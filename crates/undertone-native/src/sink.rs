// The Sink seam: the audio callback a device or a host calls, and the trait that hands it over
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The seam between the output and whatever owns the audio device.
//!
//! The seam lives in this crate and not in the engine or the facade because the engine's [`Graph`] seam is about
//! *making* audio (booking voices, rendering blocks), while this one is about *delivering* it to a device that
//! pulls on its own thread. The two never meet: the control thread renders through the graph into a ring, and
//! the [`AudioCallback`] here only copies from that ring. A host with its own audio system (a Tauri plugin, a
//! plug-in host, a test) implements [`Sink`], receives the callback in [`Sink::start`], and calls
//! [`AudioCallback::fill`] from its audio thread. The `cpal` stream of this crate is one such `Sink`
//! ([`CpalSink`](crate::CpalSink)); it adds nothing the seam does not offer.
//!
//! [`Graph`]: undertone::engine::graph::Graph
//!
//! # What the callback promises
//!
//! [`fill`](AudioCallback::fill) does not allocate, lock, block, or make a system call: it reads a wait-free
//! single-producer single-consumer ring and bumps atomic counters. When the ring holds less than the device
//! asked for (an underrun) it writes silence for the missing part and remembers how much it owes, then
//! discards that many frames when audio is available again, so the stream keeps its place against the sample
//! clock: output frame `n` is always rendered frame `n`, or silence. An underrun costs a gap, never a drift.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{NativeError, Result};

/// The sample rate and channel count of an output, always interleaved `f32`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StreamFormat {
	/// Frames per second.
	pub sample_rate: u32,
	/// Samples per frame.
	pub channels: u16,
}

impl StreamFormat {
	/// A format of `sample_rate` hertz and `channels` channels.
	pub const fn new(sample_rate: u32, channels: u16) -> Self {
		Self {
			sample_rate,
			channels,
		}
	}

	/// [`PlayerOptions`](undertone::PlayerOptions) for a player that matches this format: the same sample
	/// rate and, when the channel count is one Undertone renders (1, 2, 4, 6, or 8), the same channels
	/// (otherwise stereo, which the output then maps onto the device's channels).
	pub fn player_options(&self) -> undertone::PlayerOptions {
		let channels = match self.channels {
			1 | 2 | 4 | 6 | 8 => u32::from(self.channels),
			_ => 2,
		};
		undertone::PlayerOptions::new()
			.sample_rate(self.sample_rate)
			.channels(channels)
	}
}

/// Something that pulls audio on its own thread: a device, or a host's own audio system.
///
/// [`Output::open`](crate::Output::open) reads [`format`](Sink::format), builds the ring, and calls
/// [`start`](Sink::start) once with the [`AudioCallback`]; the sink calls [`AudioCallback::fill`] from its audio
/// thread until [`stop`](Sink::stop). A sink is used for one open and one close.
///
/// ```
/// use undertone_native::{AudioCallback, NativeError, Sink, StreamFormat};
///
/// /// A host that keeps the callback and calls it from its own loop.
/// struct HostSink {
///     callback: Option<AudioCallback>,
/// }
///
/// impl Sink for HostSink {
///     fn format(&self) -> StreamFormat {
///         StreamFormat::new(48_000, 2)
///     }
///     fn start(&mut self, callback: AudioCallback) -> Result<(), NativeError> {
///         self.callback = Some(callback);
///         Ok(())
///     }
///     fn stop(&mut self) {
///         self.callback = None;
///     }
/// }
/// ```
pub trait Sink {
	/// The format the sink's audio thread wants: the player must render at exactly this sample rate.
	fn format(&self) -> StreamFormat;

	/// Starts pulling. The sink keeps `callback` and calls [`AudioCallback::fill`] from its audio thread.
	///
	/// # Errors
	///
	/// A [`NativeError`] when the audio system refuses to start.
	fn start(&mut self, callback: AudioCallback) -> Result<()>;

	/// Stops pulling and drops the callback. Idempotent; called by [`Output::close`](crate::Output::close).
	fn stop(&mut self);
}

/// Counters the audio thread updates and any thread may read.
#[derive(Debug, Default)]
struct Shared {
	frames_played: AtomicU64,
	underruns: AtomicU64,
	underrun_frames: AtomicU64,
	stream_errors: AtomicU64,
}

/// A cloneable, read-mostly view of how the output is doing. Reading it never blocks the audio thread.
#[derive(Debug, Clone)]
pub struct StreamHealth {
	shared: Arc<Shared>,
	format: StreamFormat,
}

impl StreamHealth {
	/// Frames the callback has handed to the device, the output's sample clock.
	pub fn frames_played(&self) -> u64 {
		self.shared.frames_played.load(Ordering::Acquire)
	}

	/// The sample clock in seconds: [`frames_played`](Self::frames_played) over the sample rate.
	pub fn position_seconds(&self) -> f64 {
		self.frames_played() as f64 / f64::from(self.format.sample_rate)
	}

	/// How many callbacks found the ring short and wrote silence for the missing part.
	pub fn underruns(&self) -> u64 {
		self.shared.underruns.load(Ordering::Acquire)
	}

	/// How many frames of silence underruns wrote in all.
	pub fn underrun_frames(&self) -> u64 {
		self.shared.underrun_frames.load(Ordering::Acquire)
	}

	/// How many errors the audio system reported on the stream (a device unplugged, for example).
	pub fn stream_errors(&self) -> u64 {
		self.shared.stream_errors.load(Ordering::Acquire)
	}

	/// Records an error the audio system reported. A [`Sink`] calls this from its error callback.
	pub fn report_stream_error(&self) {
		self.shared.stream_errors.fetch_add(1, Ordering::AcqRel);
	}
}

/// The audio thread's half of the output: fills the device's interleaved `f32` buffer from the ring.
///
/// Get one from [`Sink::start`]. It is `Send`, so a sink can move it onto its audio thread. See the
/// [module documentation](self) for what [`fill`](AudioCallback::fill) guarantees.
#[derive(Debug)]
pub struct AudioCallback {
	consumer: rtrb::Consumer<f32>,
	channels: usize,
	/// Samples to discard from the ring because earlier output was silence written in their place.
	owed: usize,
	shared: Arc<Shared>,
	format: StreamFormat,
}

/// Makes the ring and both ends of it: the producer for the control thread, the callback for the audio thread.
pub(crate) fn ring(
	format: StreamFormat,
	capacity_frames: usize,
) -> (rtrb::Producer<f32>, AudioCallback) {
	let channels = usize::from(format.channels);
	let (producer, consumer) = rtrb::RingBuffer::new(capacity_frames * channels);
	let callback = AudioCallback {
		consumer,
		channels,
		owed: 0,
		shared: Arc::new(Shared::default()),
		format,
	};
	(producer, callback)
}

impl AudioCallback {
	/// Fills `out`, interleaved `f32`, with the next frames of the stream. Call it from the audio thread with
	/// whatever buffer the device hands over; it never allocates, locks, or blocks (see the
	/// [module documentation](self)).
	pub fn fill(&mut self, out: &mut [f32]) {
		let wanted = out.len();
		// Pay back an earlier underrun: those frames were played as silence, so drop their audio to stay in place.
		if self.owed > 0 {
			let drop_now = self.owed.min(self.consumer.slots());
			if drop_now > 0 {
				if let Ok(chunk) = self.consumer.read_chunk(drop_now) {
					chunk.commit_all();
				}
				self.owed -= drop_now;
			}
		}
		let take = if self.owed > 0 {
			0
		} else {
			self.consumer.slots().min(wanted)
		};
		if take > 0
			&& let Ok(chunk) = self.consumer.read_chunk(take)
		{
			let (first, second) = chunk.as_slices();
			out[..first.len()].copy_from_slice(first);
			out[first.len()..take].copy_from_slice(second);
			chunk.commit_all();
		}
		if take < wanted {
			out[take..].fill(0.0);
			let missing = wanted - take;
			// Only the part the ring could not supply is owed; samples already dropped above are paid.
			self.owed += missing;
			self.shared.underruns.fetch_add(1, Ordering::AcqRel);
			self.shared
				.underrun_frames
				.fetch_add((missing / self.channels) as u64, Ordering::AcqRel);
		}
		self.shared
			.frames_played
			.fetch_add((wanted / self.channels) as u64, Ordering::AcqRel);
	}

	/// The format the ring carries.
	pub fn format(&self) -> StreamFormat {
		self.format
	}

	/// Whole frames waiting in the ring right now (a host that paces itself can wait for enough).
	pub fn buffered_frames(&self) -> usize {
		self.consumer.slots() / self.channels
	}

	/// A view of the output's counters, for the sink's error callback and for monitoring.
	pub fn health(&self) -> StreamHealth {
		StreamHealth {
			shared: Arc::clone(&self.shared),
			format: self.format,
		}
	}
}

/// A [`Sink`] with no device: it keeps the [`AudioCallback`] where a [`ManualDriver`] can reach it, so a test
/// or an offline host calls [`fill`](AudioCallback::fill) itself.
///
/// ```
/// use undertone::prelude::*;
/// use undertone_native::{ManualSink, Output, OutputOptions, StreamFormat};
///
/// let format = StreamFormat::new(8_000, 2);
/// let (sink, driver) = ManualSink::new(format);
/// let mut player = Player::new(&format.player_options())?;
/// player.play(&note("c4")?.sound("triangle"), &PlayOptions::default())?;
/// let mut output = Output::open(sink, player, &OutputOptions::default())?;
///
/// let mut buffer = vec![0.0_f32; 2 * 512];
/// driver.wait_for_frames(512);
/// driver.fill(&mut buffer);
/// assert!(buffer.iter().any(|sample| *sample != 0.0));
/// output.close();
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
#[derive(Debug)]
pub struct ManualSink {
	format: StreamFormat,
	slot: Arc<std::sync::Mutex<Option<AudioCallback>>>,
}

/// The test or offline host's handle on a [`ManualSink`]. Cloneable; not for use on a real audio thread
/// (it locks), which is what [`ManualDriver::take_callback`] is for.
#[derive(Debug, Clone)]
pub struct ManualDriver {
	slot: Arc<std::sync::Mutex<Option<AudioCallback>>>,
}

impl ManualSink {
	/// A sink of `format` and the driver that calls its callback.
	pub fn new(format: StreamFormat) -> (ManualSink, ManualDriver) {
		let slot = Arc::new(std::sync::Mutex::new(None));
		(
			ManualSink {
				format,
				slot: Arc::clone(&slot),
			},
			ManualDriver { slot },
		)
	}
}

impl Sink for ManualSink {
	fn format(&self) -> StreamFormat {
		self.format
	}

	fn start(&mut self, callback: AudioCallback) -> Result<()> {
		let mut slot = self.slot.lock().map_err(|_| poisoned())?;
		*slot = Some(callback);
		Ok(())
	}

	fn stop(&mut self) {
		if let Ok(mut slot) = self.slot.lock() {
			*slot = None;
		}
	}
}

fn poisoned() -> NativeError {
	NativeError::Stream("the manual sink's lock was poisoned".into())
}

impl ManualDriver {
	/// Calls [`AudioCallback::fill`] on `out`. Fills with silence when the sink is not started.
	pub fn fill(&self, out: &mut [f32]) {
		match self.slot.lock() {
			Ok(mut slot) => match slot.as_mut() {
				Some(callback) => callback.fill(out),
				None => out.fill(0.0),
			},
			Err(_) => out.fill(0.0),
		}
	}

	/// Whole frames waiting in the ring (zero when the sink is not started).
	pub fn buffered_frames(&self) -> usize {
		self.slot
			.lock()
			.ok()
			.and_then(|slot| slot.as_ref().map(AudioCallback::buffered_frames))
			.unwrap_or(0)
	}

	/// Sleeps in short steps until the ring holds `frames`, so a test that pulls faster than real time does not
	/// underrun. Gives up after ten seconds (the output has stopped) and returns whether the frames arrived.
	pub fn wait_for_frames(&self, frames: usize) -> bool {
		let started = std::time::Instant::now();
		while self.buffered_frames() < frames {
			if started.elapsed() > std::time::Duration::from_secs(10) {
				return false;
			}
			std::thread::sleep(std::time::Duration::from_micros(200));
		}
		true
	}

	/// Takes the callback out of the sink, so the caller can run it on a thread of its own and count what it
	/// allocates. [`fill`](ManualDriver::fill) then fills with silence.
	pub fn take_callback(&self) -> Option<AudioCallback> {
		self.slot.lock().ok().and_then(|mut slot| slot.take())
	}

	/// A view of the started output's counters, or `None` before it starts.
	pub fn health(&self) -> Option<StreamHealth> {
		self.slot
			.lock()
			.ok()
			.and_then(|slot| slot.as_ref().map(AudioCallback::health))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn frames(callback: &mut AudioCallback, count: usize) -> Vec<f32> {
		let mut out = vec![9.0; count * callback.channels];
		callback.fill(&mut out);
		out
	}

	fn push(producer: &mut rtrb::Producer<f32>, from: usize, count: usize, channels: usize) {
		for frame in from..from + count {
			for _ in 0..channels {
				producer.push(frame as f32 + 1.0).unwrap();
			}
		}
	}

	#[test]
	fn an_underrun_writes_silence_and_keeps_the_place() {
		let (mut producer, mut callback) = ring(StreamFormat::new(1000, 2), 1000);
		// Frames 0..100 are in the ring, each frame's samples holding its index plus one.
		push(&mut producer, 0, 100, 2);
		// Ask for 150: frames 0..100 are real, 100..150 are silence, and 50 are owed.
		let out = frames(&mut callback, 150);
		assert_eq!(out[0], 1.0);
		assert_eq!(out[2 * 99], 100.0);
		assert!(out[2 * 100..].iter().all(|s| *s == 0.0));
		let health = callback.health();
		assert_eq!((health.underruns(), health.underrun_frames()), (1, 50));
		assert_eq!(health.frames_played(), 150);
		// Frames 100..300 arrive. Output frames 150.. must be rendered frames 150.., so 100..150 are dropped.
		push(&mut producer, 100, 200, 2);
		let out = frames(&mut callback, 100);
		assert_eq!(out[0], 151.0, "output frame 150 is rendered frame 150");
		assert_eq!(out[2 * 99], 250.0);
		assert_eq!(health.underruns(), 1);
		assert_eq!(health.frames_played(), 250);
	}

	#[test]
	fn an_empty_ring_is_silence_and_the_debt_is_paid_as_frames_arrive() {
		let (mut producer, mut callback) = ring(StreamFormat::new(1000, 1), 1000);
		assert!(frames(&mut callback, 40).iter().all(|s| *s == 0.0));
		assert!(frames(&mut callback, 40).iter().all(|s| *s == 0.0));
		// 80 frames are owed. Frames 0..100 arrive: the next fill drops 80 and plays from frame 80 + 0.
		push(&mut producer, 0, 100, 1);
		let out = frames(&mut callback, 10);
		assert_eq!(out[0], 81.0);
		assert_eq!(callback.health().underruns(), 2);
	}

	#[test]
	fn a_ring_that_wraps_is_read_whole() {
		let (mut producer, mut callback) = ring(StreamFormat::new(1000, 2), 8);
		let mut next = 0;
		for _ in 0..10 {
			push(&mut producer, next, 5, 2);
			let out = frames(&mut callback, 5);
			for (i, pair) in out.chunks(2).enumerate() {
				assert_eq!(pair, [(next + i) as f32 + 1.0; 2]);
			}
			next += 5;
		}
		assert_eq!(callback.health().underruns(), 0);
	}

	#[test]
	fn the_callback_and_the_health_view_can_cross_threads() {
		fn needs<T: Send>() {}
		needs::<AudioCallback>();
		needs::<StreamHealth>();
	}
}
