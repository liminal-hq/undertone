// The output: a control thread that renders a Player ahead into a ring, and a Sink that drains it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Output`]: plays a [`Player`] through a [`Sink`].
//!
//! # Threads
//!
//! ```text
//!  your code --with_player--> Player <--render_block-- control thread --> ring --> audio thread (Sink)
//!                          (Arc<Mutex>)             (books, renders)     (rtrb)   AudioCallback::fill
//! ```
//!
//! The **control thread** owns the work that allocates: it ticks the player's transport (a tick queries the
//! pattern and books voices, which allocates until the zero-allocation booking tick of decision D-34 lands),
//! renders the engine's graph a block at a time, interleaves the block, and writes it to a wait-free ring. The
//! **audio thread** only copies from the ring ([`AudioCallback::fill`](crate::AudioCallback::fill)): it never allocates, locks, or touches
//! the player. So the voices are pooled and booked where allocation is allowed, and the device's callback has no
//! work that can miss a deadline except the copy.
//!
//! The price is latency: what you play is heard after the ring has drained what was rendered before it, up to
//! [`OutputOptions::buffer_seconds`]. The default is a tenth of a second.
//!
//! # Time
//!
//! The player's clock is the render position, which runs ahead of the speakers by the ring's fill. A note
//! booked at clock time `t` is rendered at frame `t * sample_rate` of the stream, and the audio callback hands
//! out stream frame `n` as output frame `n` (an underrun inserts silence and drops the same number of frames
//! afterwards, see [`AudioCallback::fill`](crate::AudioCallback::fill)), so the position error against the sample clock is zero frames
//! while the control thread keeps up. A test asserts it with a fake callback.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use undertone::{ErrorKind, Player};

use crate::error::{NativeError, Result};
use crate::sink::{Sink, StreamFormat, StreamHealth, ring};

/// How the ring and the control thread are sized. Build one with [`OutputOptions::new`] and chain setters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OutputOptions {
	buffer_seconds: f64,
	block_frames: usize,
}

impl Default for OutputOptions {
	fn default() -> Self {
		Self {
			buffer_seconds: 0.1,
			block_frames: 256,
		}
	}
}

impl OutputOptions {
	/// A tenth of a second of ring, rendered in blocks of 256 frames.
	pub fn new() -> Self {
		Self::default()
	}

	/// How much audio the control thread renders ahead, in seconds (default 0.1). A bigger ring survives a busier
	/// machine and delays what you play by as much; a smaller one is more responsive and underruns sooner.
	pub fn buffer_seconds(mut self, seconds: f64) -> Self {
		self.buffer_seconds = seconds;
		self
	}

	/// Frames the control thread renders at a time (default 256). It must fit twice into the ring.
	pub fn block_frames(mut self, frames: usize) -> Self {
		self.block_frames = frames;
		self
	}
}

/// A [`Player`] playing through a [`Sink`]. See the [module documentation](self).
///
/// Dropping an output closes it. [`close`](Output::close) does the same on request and is idempotent.
#[derive(Debug)]
pub struct Output<S: Sink> {
	sink: S,
	player: Arc<Mutex<Player>>,
	stop: Arc<AtomicBool>,
	thread: Option<JoinHandle<()>>,
	health: StreamHealth,
	errors: Arc<Mutex<Option<undertone::Error>>>,
	open: bool,
}

fn lock(player: &Mutex<Player>) -> MutexGuard<'_, Player> {
	player.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The control thread's state: renders the player a block at a time into the ring.
struct Renderer {
	player: Arc<Mutex<Player>>,
	producer: rtrb::Producer<f32>,
	/// One buffer per channel of the player, reused for every block.
	planar: Vec<Vec<f32>>,
	device_channels: usize,
	block_frames: usize,
	errors: Arc<Mutex<Option<undertone::Error>>>,
}

impl Renderer {
	/// Renders blocks while the ring has room for one. Returns how many blocks it wrote, or `None` when the
	/// player is shut down (nothing more can be rendered).
	fn top_up(&mut self) -> Option<usize> {
		let mut blocks = 0;
		while self.producer.slots() >= self.block_frames * self.device_channels {
			let rendered = {
				let mut player = lock(&self.player);
				let mut parts: Vec<&mut [f32]> = self
					.planar
					.iter_mut()
					.map(|channel| channel.as_mut_slice())
					.collect();
				player.render_block(&mut parts)
			};
			match rendered {
				// A tick failed (a loop whose pattern did not query): the block is still rendered, as
				// `Player::render_block` documents, so keep it and remember the first error to report.
				Err(error) if error.kind() == ErrorKind::Closed => return None,
				Err(error) => {
					self.errors
						.lock()
						.unwrap_or_else(PoisonError::into_inner)
						.get_or_insert(error);
				}
				Ok(0) => return None,
				Ok(_) => {}
			}
			self.write_block();
			blocks += 1;
		}
		Some(blocks)
	}

	/// Interleaves the planar block into the ring, mapping the player's channels onto the device's: mono is
	/// copied to every channel; otherwise channel `c` goes to device channel `c`, extra player channels are
	/// dropped, and extra device channels are silent.
	fn write_block(&mut self) {
		let player_channels = self.planar.len();
		let Ok(mut chunk) = self
			.producer
			.write_chunk(self.block_frames * self.device_channels)
		else {
			return;
		};
		let (first, second) = chunk.as_mut_slices();
		let mut destination = first.iter_mut().chain(second.iter_mut());
		for frame in 0..self.block_frames {
			for channel in 0..self.device_channels {
				let source = if player_channels == 1 {
					Some(0)
				} else if channel < player_channels {
					Some(channel)
				} else {
					None
				};
				if let Some(slot) = destination.next() {
					*slot = source.map_or(0.0, |c| self.planar[c][frame]);
				}
			}
		}
		chunk.commit_all();
	}
}

impl<S: Sink> Output<S> {
	/// Opens the output: fills the ring, starts the control thread, and starts the sink, so audio flows as soon
	/// as this returns. The player must render at the sink's sample rate (see
	/// [`StreamFormat::player_options`]); the output keeps the player and plays through it until it is closed.
	///
	/// # Errors
	///
	/// [`NativeError::Format`] when the sample rates differ or an option is out of range,
	/// [`NativeError::Player`] when the player was shut down, and whatever [`Sink::start`] fails with. When
	/// the sink fails to start, the control thread is stopped again before the error is returned.
	pub fn open(sink: S, player: Player, options: &OutputOptions) -> Result<Output<S>> {
		let format = sink.format();
		check_format(format, &player, options)?;
		// A player that is already shut down cannot render.
		player.engine()?;
		let frames = (options.buffer_seconds * f64::from(format.sample_rate)).ceil() as usize;
		let (producer, callback) = ring(format, frames.max(2 * options.block_frames));
		let health = callback.health();
		let player_channels = player.channel_count();
		let player = Arc::new(Mutex::new(player));
		let errors = Arc::new(Mutex::new(None));
		let mut renderer = Renderer {
			player: Arc::clone(&player),
			producer,
			planar: vec![vec![0.0; options.block_frames]; player_channels],
			device_channels: usize::from(format.channels),
			block_frames: options.block_frames,
			errors: Arc::clone(&errors),
		};
		// Fill the ring before the sink starts, so the stream begins at frame 0 of the player's clock.
		renderer.top_up();
		let stop = Arc::new(AtomicBool::new(false));
		let flag = Arc::clone(&stop);
		let thread = std::thread::Builder::new()
			.name("undertone-native-render".into())
			.spawn(move || {
				while !flag.load(Ordering::Acquire) {
					match renderer.top_up() {
						None => break,
						Some(0) => std::thread::sleep(Duration::from_micros(500)),
						Some(_) => {}
					}
				}
			})
			.map_err(|error| NativeError::Stream(format!("the control thread did not start: {error}")))?;
		let mut output = Output {
			sink,
			player,
			stop,
			thread: Some(thread),
			health,
			errors,
			open: true,
		};
		if let Err(error) = output.sink.start(callback) {
			output.close();
			return Err(error);
		}
		Ok(output)
	}

	/// Runs `f` on the player, for example to [`play`](Player::play) a pattern or start a loop. Keep it short:
	/// the control thread waits for the player while `f` runs, and the ring only covers
	/// [`OutputOptions::buffer_seconds`] of that wait. Works after [`close`](Output::close) too.
	pub fn with_player<R>(&self, f: impl FnOnce(&mut Player) -> R) -> R {
		f(&mut lock(&self.player))
	}

	/// The error a tick reported on the control thread (a loop whose pattern failed to query), if any, and
	/// clears it. Playback continues; the failed loop retries at the next tick.
	pub fn take_error(&self) -> Option<undertone::Error> {
		self.errors
			.lock()
			.unwrap_or_else(PoisonError::into_inner)
			.take()
	}

	/// The sample clock and the underrun counters.
	pub fn health(&self) -> StreamHealth {
		self.health.clone()
	}

	/// The format of the sink's stream.
	pub fn format(&self) -> StreamFormat {
		self.sink.format()
	}

	/// Whether the output is open (it is until [`close`](Output::close) or the drop).
	pub fn is_open(&self) -> bool {
		self.open
	}

	/// The sink the output plays through.
	pub fn sink(&self) -> &S {
		&self.sink
	}

	/// Stops the sink, then stops and joins the control thread. Idempotent. The player is kept, so
	/// [`with_player`](Output::with_player) still works; shut it down there if it is not needed again.
	pub fn close(&mut self) {
		if !self.open {
			return;
		}
		self.open = false;
		self.sink.stop();
		self.stop.store(true, Ordering::Release);
		if let Some(thread) = self.thread.take() {
			// A panic on the control thread has nothing more to report once the output is closing.
			let _ = thread.join();
		}
	}
}

impl<S: Sink> Drop for Output<S> {
	fn drop(&mut self) {
		self.close();
	}
}

fn check_format(format: StreamFormat, player: &Player, options: &OutputOptions) -> Result<()> {
	if format.sample_rate == 0 || format.channels == 0 {
		return Err(NativeError::Format(format!(
			"the sink wants {} Hz and {} channels",
			format.sample_rate, format.channels
		)));
	}
	if player.sample_rate() != f64::from(format.sample_rate) {
		return Err(NativeError::Format(format!(
			"the player renders at {} Hz but the sink wants {} Hz (build the player with StreamFormat::player_options)",
			player.sample_rate(),
			format.sample_rate
		)));
	}
	if options.block_frames == 0 || !(options.buffer_seconds.is_finite() && options.buffer_seconds > 0.0)
	{
		return Err(NativeError::Format(
			"block_frames must be positive and buffer_seconds positive and finite".into(),
		));
	}
	Ok(())
}
