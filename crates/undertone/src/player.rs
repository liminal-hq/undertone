// The Player: an owned engine and transport for offline and host-driven playback
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Player`]: one owned handle that bundles an [`Engine`], a [`Transport`], and a [`Clock`].
//!
//! The scheduler crate keeps the engine, the transport, and the clock apart, so a host decides where each
//! lives. That is the right seam for a host, and a lot to wire for a program that only wants to play a pattern.
//! A `Player` owns the three and offers the calls a program makes: [`play`](Player::play),
//! [`play_loop`](Player::play_loop), [`tick`](Player::tick), [`stop`](Player::stop), and
//! [`shutdown`](Player::shutdown).
//!
//! # Two ways to drive it
//!
//! - **Offline.** [`Player::new`] makes a player over a [`RenderGraph`] and a [`ManualClock`]. It has no audio
//!   device and no timer: [`render_seconds`](Player::render_seconds) and [`render_block`](Player::render_block)
//!   move its clock as they render and tick the transport as often as the scheduler's tick interval asks, so a
//!   loop that runs for ten seconds is booked and rendered exactly as it would be live.
//! - **Host-driven.** [`Player::with_graph`] takes any [`Graph`] and any [`Clock`]. The host owns the timer: it
//!   keeps its clock in step with its audio and calls [`tick`](Player::tick) about every
//!   [`SchedulerOptions::tick_interval`] seconds (see the scheduler crate's guide to driving a transport from an
//!   audio callback).
//!
//! # Shared state and shutdown
//!
//! A player is `Send` whenever its graph and clock are, so a host can keep it in managed state behind a mutex
//! and call it from several threads or async commands (a Tauri plugin does exactly this):
//!
//! ```
//! use std::sync::{Arc, Mutex};
//! use undertone::prelude::*;
//!
//! let player = Arc::new(Mutex::new(Player::new(&PlayerOptions::new().sample_rate(8_000))?));
//! let worker = {
//!     let player = Arc::clone(&player);
//!     std::thread::spawn(move || {
//!         let mut player = player.lock().unwrap();
//!         player.play(&note("c4")?, &PlayOptions::default())?;
//!         player.render_seconds(0.25)
//!     })
//! };
//! assert!(worker.join().unwrap()?.peak() > 0.0);
//! player.lock().unwrap().shutdown();
//! # Ok::<(), undertone::Error>(())
//! ```
//!
//! [`shutdown`](Player::shutdown) is explicit and idempotent: it stops everything, drops the engine and its
//! graph (so the audio memory is freed even while the player value lives on in a host's state), and every call
//! after it that needs the engine fails with [`ErrorKind::Closed`](crate::ErrorKind::Closed). Calling it again
//! does nothing.

use crate::error::{Error, Result};
use crate::render::RenderedAudio;
use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::Graph;
use undertone_engine::params::Pitch;
use undertone_engine::render::MasterSetting;
use undertone_engine::render_graph::{MAX_RENDER_LENGTH_FRAMES, RenderGraph};
use undertone_engine::samples::{SampleData, Samples};
use undertone_engine::score::Score;
use undertone_pattern::random::Seed;
use undertone_pattern::{ControlMap, Pattern};
use undertone_sched::{
	Clock, LoopHandle, LoopOptions, LoopStop, LoopVoices, ManualClock, PlayOptions, PlaybackHandle,
	SchedulerOptions, Stats, Tempo, TickReport, Transport,
};

/// How an offline [`Player`] is set up. Build one with [`PlayerOptions::new`] and chain setters.
///
/// ```
/// use undertone::prelude::*;
///
/// let options = PlayerOptions::new().sample_rate(22_050).channels(2).seed("level-1").cpm(30);
/// let player = Player::new(&options)?;
/// assert_eq!(player.sample_rate(), 22_050.0);
/// assert_eq!(player.transport()?.tempo().default_cpm(), Some(30.0));
/// # Ok::<(), undertone::Error>(())
/// ```
#[derive(Debug, Clone)]
pub struct PlayerOptions {
	sample_rate: f64,
	channels: u32,
	master: MasterSetting,
	seed: Seed,
	scheduler: SchedulerOptions,
	cpm: Option<f64>,
	samples: Samples,
}

impl Default for PlayerOptions {
	fn default() -> Self {
		PlayerOptions {
			sample_rate: 48_000.0,
			channels: 2,
			master: MasterSetting::On,
			seed: Seed::Num(0.0),
			scheduler: SchedulerOptions::default(),
			cpm: None,
			samples: Samples::default(),
		}
	}
}

impl PlayerOptions {
	/// 48000 Hz, stereo, through the master bus, the reference's look-ahead and tick, 120 bpm.
	pub fn new() -> Self {
		Self::default()
	}

	/// The sample rate in hertz (default 48000).
	pub fn sample_rate(mut self, hertz: impl Into<f64>) -> Self {
		self.sample_rate = hertz.into();
		self
	}

	/// Output channels: 1, 2, 4, 6, or 8 (default 2). More than two uses discrete multichannel output.
	pub fn channels(mut self, channels: u32) -> Self {
		self.channels = channels;
		self
	}

	/// The master bus and its limiter (default [`MasterSetting::On`]).
	pub fn master(mut self, master: MasterSetting) -> Self {
		self.master = master;
		self
	}

	/// Seeds noise and reverb (default 0).
	pub fn seed(mut self, seed: impl Into<Seed>) -> Self {
		self.seed = seed.into();
		self
	}

	/// The scheduler's look-ahead, tick interval, and start latency.
	pub fn scheduler(mut self, scheduler: SchedulerOptions) -> Self {
		self.scheduler = scheduler;
		self
	}

	/// The transport's default tempo in cycles per minute (the reference's `setcpm()`), used by a play or a
	/// loop that gives neither `bpm` nor `cps`. Default 120 bpm, which is 30 cycles per minute.
	pub fn cpm(mut self, cycles_per_minute: impl Into<f64>) -> Self {
		self.cpm = Some(cycles_per_minute.into());
		self
	}

	/// The samples voices play (decoded PCM, decision D-30).
	pub fn samples(mut self, samples: Samples) -> Self {
		self.samples = samples;
		self
	}
}

/// An owned engine, transport, and clock. See the [module documentation](self).
///
/// `G` is the graph the engine books on and `C` the clock the transport reads. The defaults, a
/// [`RenderGraph`] and a [`ManualClock`], are the offline player [`Player::new`] makes.
pub struct Player<G: Graph = RenderGraph, C: Clock = ManualClock> {
	engine: Option<Engine<G>>,
	transport: Transport<C>,
	/// One-shots played through the player, so `stop` can reach them.
	playbacks: Vec<PlaybackHandle>,
	/// The frames the offline renderer has produced, so the clock is set from a count and not accumulated.
	frames: u64,
	/// The clock time the next tick is due at (offline driving only).
	next_tick: f64,
}

impl<G: Graph + std::fmt::Debug, C: Clock + std::fmt::Debug> std::fmt::Debug for Player<G, C> {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Player")
			.field("closed", &self.engine.is_none())
			.field("transport", &self.transport)
			.field("playbacks", &self.playbacks.len())
			.finish_non_exhaustive()
	}
}

impl Player {
	/// An offline player: a [`RenderGraph`] of the options' sample rate and channels, and a [`ManualClock`]
	/// that [`render_seconds`](Player::render_seconds) and [`render_block`](Player::render_block) move.
	///
	/// # Errors
	///
	/// A sample rate outside 1 to 1,000,000 Hz, a channel count that is not 1, 2, 4, 6, or 8, an invalid
	/// scheduler setting or default tempo, and an invalid master bus fail with the reference's messages.
	pub fn new(options: &PlayerOptions) -> Result<Self> {
		if ![1, 2, 4, 6, 8].contains(&options.channels) {
			return Err(Error::new(format!(
				"channels must be 1, 2, 4, 6 or 8, got {}",
				options.channels
			)));
		}
		let graph = RenderGraph::try_new(
			options.sample_rate,
			options.channels,
			MAX_RENDER_LENGTH_FRAMES,
		)?;
		let clock = ManualClock::new(options.sample_rate);
		let setup = OutputSetup {
			master: match options.master {
				MasterSetting::On => Some(Default::default()),
				MasterSetting::Off => None,
				MasterSetting::Tuned(tuned) => Some(undertone_engine::master::MasterBusOptions {
					output: None,
					..tuned
				}),
			},
			multichannel: options.channels > 2,
			seed: options.seed.clone(),
		};
		let mut player = Player::with_graph(graph, clock, setup, options.scheduler)?;
		if let Some(cpm) = options.cpm {
			player.set_cpm(cpm)?;
		}
		*player.engine_mut()?.samples_mut() = options.samples.clone();
		Ok(player)
	}

	/// The sample rate of the renderer, in hertz.
	pub fn sample_rate(&self) -> f64 {
		self.engine
			.as_ref()
			.map_or(0.0, |engine| engine.graph().sample_rate())
	}

	/// How many channels the renderer makes (0 once shut down).
	pub fn channel_count(&self) -> usize {
		self.engine
			.as_ref()
			.map_or(0, |engine| engine.graph().channels())
	}

	/// Renders the next `out[0].len()` frames into `out` (one slice per channel, all of one length) and moves the
	/// clock on by as many frames, ticking the transport every tick interval on the way. Returns the frames
	/// written.
	///
	/// This is the offline player's audio callback: a host that wants the audio itself (to send it to a device
	/// or a file as it goes) calls it with whatever block size it likes; the samples do not depend on the block
	/// size.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown, or a tick's error (a loop whose pattern
	/// fails to query keeps its place and is tried again at the next tick; the audio rendered so far is kept in
	/// `out`).
	///
	/// # Panics
	///
	/// Panics if `out` does not hold one slice per channel, or the slices differ in length.
	pub fn render_block(&mut self, out: &mut [&mut [f32]]) -> Result<usize> {
		let channels = self.channel_count();
		assert_eq!(out.len(), channels, "one slice per channel");
		let total = out.first().map_or(0, |channel| channel.len());
		assert!(
			out.iter().all(|channel| channel.len() == total),
			"slices of one length"
		);
		let sample_rate = self.engine()?.graph().sample_rate();
		let mut done = 0;
		let mut first_error = None;
		while done < total {
			if self.transport.clock().now() >= self.next_tick {
				if let Err(error) = self.tick() {
					first_error.get_or_insert(error);
				}
				self.next_tick = self.transport.clock().now() + self.transport.tick_interval();
			}
			let until_tick = ((self.next_tick - self.transport.clock().now()) * sample_rate).ceil();
			let take = (total - done).min(until_tick.max(1.0) as usize);
			let mut parts: Vec<&mut [f32]> = out
				.iter_mut()
				.map(|channel| &mut channel[done..done + take])
				.collect();
			let written = self.engine_mut()?.graph_mut().render_block(&mut parts);
			if written == 0 {
				break;
			}
			done += written;
			self.frames += written as u64;
			self.transport.clock().set(self.frames as f64 / sample_rate);
		}
		match first_error {
			Some(error) => Err(error),
			None => Ok(done),
		}
	}

	/// Renders `seconds` of whatever is playing and collects it: the offline way to hear a loop that runs for a
	/// while, or one-shots played with [`play`](Player::play). The transport is ticked as the clock moves, so
	/// loops keep booking.
	///
	/// # Errors
	///
	/// A `seconds` that is not positive and finite, longer than the engine's bound (268,435,456 frames), or a
	/// [`render_block`](Player::render_block) failure.
	///
	/// ```
	/// use undertone::prelude::*;
	///
	/// let mut player = Player::new(&PlayerOptions::new().sample_rate(8_000))?;
	/// let handle = player.play_loop(
	///     &note("c3 e3 g3 b3")?.sound("triangle"),
	///     &LoopOptions { bpm: Some(240.0), ..LoopOptions::default() }, // a one-second cycle
	/// )?;
	/// let heard = player.render_seconds(2.0)?;
	/// assert_eq!(heard.frames(), 16_000);
	/// assert!(heard.peak() > 0.01);
	/// player.stop_loop(handle, &LoopStop::default())?;
	/// # Ok::<(), undertone::Error>(())
	/// ```
	pub fn render_seconds(&mut self, seconds: f64) -> Result<RenderedAudio> {
		let sample_rate = self.engine()?.graph().sample_rate();
		let frames = (seconds * sample_rate).round();
		if seconds.is_nan()
			|| seconds <= 0.0
			|| !frames.is_finite()
			|| frames > MAX_RENDER_LENGTH_FRAMES as f64
		{
			return Err(Error::new(format!(
				"seconds must be positive and render at most {MAX_RENDER_LENGTH_FRAMES} frames, got {}",
				undertone_pattern::js::number_to_string(seconds)
			)));
		}
		let frames = frames as usize;
		let mut channels = vec![vec![0.0_f32; frames]; self.channel_count()];
		let mut slices: Vec<&mut [f32]> = channels.iter_mut().map(Vec::as_mut_slice).collect();
		let written = self.render_block(&mut slices)?;
		for channel in &mut channels {
			channel.truncate(written);
		}
		Ok(RenderedAudio::new(sample_rate, channels))
	}
}

impl<G: Graph, C: Clock> Player<G, C> {
	/// A player over a graph and a clock the host owns. The engine's output is set up as `setup` says; the
	/// transport is paced by `scheduler`.
	///
	/// The graph's clock and `clock` must agree (the transport books against `clock.now()`, and the engine
	/// forgets finished voices against the graph's time).
	///
	/// # Errors
	///
	/// An invalid scheduler setting, or a master bus whose options are invalid.
	///
	/// ```
	/// use undertone::prelude::*;
	///
	/// // A host's own graph (here a recording one) and clock.
	/// let clock = ManualClock::new(48_000.0);
	/// let graph = LogGraph::new(48_000.0, 2);
	/// let mut player = Player::with_graph(graph, clock.clone(), OutputSetup::default(), SchedulerOptions::default())?;
	/// player.play(&note("c3")?, &PlayOptions::default())?;
	/// clock.advance(0.1);
	/// player.tick()?;
	/// assert_eq!(player.engine()?.voice_count(), 1);
	/// # Ok::<(), undertone::Error>(())
	/// ```
	pub fn with_graph(
		graph: G,
		clock: C,
		setup: OutputSetup,
		scheduler: SchedulerOptions,
	) -> Result<Self> {
		let engine = Engine::new(graph, setup)?;
		let transport = Transport::new(clock, scheduler)?;
		Ok(Player::from_parts(engine, transport))
	}

	/// A player over an engine and a transport the host has already made.
	pub fn from_parts(engine: Engine<G>, transport: Transport<C>) -> Self {
		let next_tick = transport.clock().now();
		Player {
			engine: Some(engine),
			transport,
			playbacks: Vec::new(),
			frames: 0,
			next_tick,
		}
	}

	/// Whether [`shutdown`](Player::shutdown) has been called.
	pub fn is_shutdown(&self) -> bool {
		self.engine.is_none()
	}

	/// The engine, for a host that books voices itself beside the player.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown.
	pub fn engine(&self) -> Result<&Engine<G>> {
		self.engine.as_ref().ok_or_else(Error::closed)
	}

	/// The engine, mutably.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown.
	pub fn engine_mut(&mut self) -> Result<&mut Engine<G>> {
		self.engine.as_mut().ok_or_else(Error::closed)
	}

	/// The transport.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown.
	pub fn transport(&self) -> Result<&Transport<C>> {
		if self.is_shutdown() {
			return Err(Error::closed());
		}
		Ok(&self.transport)
	}

	/// The clock the transport reads.
	pub fn clock(&self) -> &C {
		self.transport.clock()
	}

	/// The default tempo the transport holds.
	pub fn tempo(&self) -> &Tempo {
		self.transport.tempo()
	}

	/// Sets the default tempo in cycles per minute, used by a play or a loop that gives neither `bpm` nor `cps`
	/// (`setcpm`). An explicit `bpm` or `cps` on a call always wins.
	///
	/// # Errors
	///
	/// The reference's `setcpm() must be positive, got N`, and an infinite tempo.
	pub fn set_cpm(&mut self, cycles_per_minute: f64) -> Result<()> {
		Ok(self.transport.set_cpm(cycles_per_minute)?)
	}

	/// Clears the tempo override (`resetTempo`): 120 bpm again.
	pub fn reset_tempo(&mut self) {
		self.transport.reset_tempo();
	}

	/// The transport's counters: ticks, voices booked, late voices, underruns, and callback times.
	pub fn stats(&self) -> Stats {
		self.transport.stats()
	}

	/// Plays one cycle of the pattern once (`.play()`): every voice that starts in `[from, from + 1)` cycles,
	/// with percussive envelopes unless [`PlayOptions::gated`]. The returned handle's start and end times are on
	/// the clock; [`stop_playback`](Player::stop_playback) or [`stop`](Player::stop) ends it early.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown, an invalid tempo (`bpm must be positive,
	/// got 0`, `Pass either bpm or cps, not both`), a pattern that fails to query, or a voice that fails to book.
	pub fn play(
		&mut self,
		pattern: &Pattern<ControlMap>,
		options: &PlayOptions,
	) -> Result<PlaybackHandle> {
		let engine = self.engine.as_mut().ok_or_else(Error::closed)?;
		let handle = self.transport.play(engine, pattern, options)?;
		let now = self.transport.clock().now();
		self.playbacks.retain(|playback| playback.end_time > now);
		self.playbacks.push(handle.clone());
		Ok(handle)
	}

	/// Plays one pass of a [`Score`] at its own tempo (`cue.play()`).
	///
	/// # Errors
	///
	/// As [`play`](Player::play).
	pub fn play_score(&mut self, score: &Score) -> Result<PlaybackHandle> {
		self.play(
			score.pattern(),
			&PlayOptions {
				cps: Some(score.cps()),
				..PlayOptions::default()
			},
		)
	}

	/// Loops the pattern until it is stopped (`.loop()`): the first look-ahead window is booked now and each
	/// [`tick`](Player::tick) extends it. Voices are gated by their event's length.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown, an invalid tempo, or a first window that
	/// fails to book (no loop is started).
	pub fn play_loop(
		&mut self,
		pattern: &Pattern<ControlMap>,
		options: &LoopOptions,
	) -> Result<LoopHandle> {
		let engine = self.engine.as_mut().ok_or_else(Error::closed)?;
		Ok(self.transport.play_loop(engine, pattern, options)?)
	}

	/// Loops a [`Score`] at its own tempo (`cue.loop()`).
	///
	/// # Errors
	///
	/// As [`play_loop`](Player::play_loop).
	pub fn loop_score(&mut self, score: &Score) -> Result<LoopHandle> {
		self.play_loop(
			score.pattern(),
			&LoopOptions {
				cps: Some(score.cps()),
				..LoopOptions::default()
			},
		)
	}

	/// One tick of the scheduler: books, for every running loop, the voices between what is booked and the
	/// look-ahead past the clock. Offline, [`render_seconds`](Player::render_seconds) ticks for you; a host calls
	/// this about every [`SchedulerOptions::tick_interval`] seconds. A tick with nothing due books nothing.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown, or the first error of the tick (see
	/// [`Transport::tick`]).
	pub fn tick(&mut self) -> Result<TickReport> {
		let engine = self.engine.as_mut().ok_or_else(Error::closed)?;
		Ok(self.transport.tick(engine)?)
	}

	/// Stops one loop: no more cycles are booked and, as `options` say, the voices already booked ring out or are
	/// cut. A handle for a loop that has stopped is ignored.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown.
	pub fn stop_loop(&mut self, handle: LoopHandle, options: &LoopStop) -> Result<()> {
		let engine = self.engine.as_mut().ok_or_else(Error::closed)?;
		Ok(self.transport.stop_loop(engine, handle, options)?)
	}

	/// Stops one one-shot at `when` (default: now) with a short fade (default 10 ms).
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown.
	pub fn stop_playback(
		&mut self,
		handle: &PlaybackHandle,
		when: Option<f64>,
		fade: Option<f64>,
	) -> Result<()> {
		let engine = self.engine.as_mut().ok_or_else(Error::closed)?;
		handle.stop(engine, when, fade);
		Ok(())
	}

	/// Stops everything now: every loop, with its booked voices cut (a short fade, so there is no click), and
	/// every one-shot played through the player. The player stays usable.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown.
	pub fn stop(&mut self) -> Result<()> {
		let engine = self.engine.as_mut().ok_or_else(Error::closed)?;
		self.transport.stop_all(
			engine,
			&LoopStop {
				voices: LoopVoices::Cut,
				fade: None,
			},
		)?;
		for handle in self.playbacks.drain(..) {
			handle.stop(engine, None, None);
		}
		Ok(())
	}

	/// Stops everything and releases the engine and its graph. Explicit and idempotent: a second call does
	/// nothing, and every call after it that needs the engine fails with
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed).
	///
	/// ```
	/// use undertone::prelude::*;
	///
	/// let mut player = Player::new(&PlayerOptions::new().sample_rate(8_000))?;
	/// player.shutdown();
	/// player.shutdown(); // harmless
	/// assert!(player.is_shutdown());
	/// assert_eq!(player.tick().unwrap_err().kind(), ErrorKind::Closed);
	/// # Ok::<(), undertone::Error>(())
	/// ```
	pub fn shutdown(&mut self) {
		if self.engine.is_some() {
			// A stop that fails has nothing left to do: the engine is dropped next.
			let _ = self.stop();
			self.engine = None;
		}
		self.playbacks.clear();
	}

	/// Registers decoded PCM that sample voices play, under `name`, with the pitch it sounds at (`None` means
	/// `c4`). An engine keeps the buffer it makes from a recording the first time it plays it, so register a
	/// sample before it is first heard.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown; otherwise as
	/// [`Samples::register_sample`].
	pub fn register_sample(
		&mut self,
		name: impl Into<String>,
		data: SampleData,
		base_note: Option<Pitch>,
	) -> Result<()> {
		Ok(self
			.engine_mut()?
			.samples_mut()
			.register_sample(name, data, base_note)?)
	}

	/// The registry sample voices play from.
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown.
	pub fn samples(&self) -> Result<&Samples> {
		Ok(self.engine()?.samples())
	}

	/// The registry, mutably, for the bulk calls ([`Samples::register_samples`], [`Samples::load_samples`]).
	///
	/// # Errors
	///
	/// [`ErrorKind::Closed`](crate::ErrorKind::Closed) after shutdown.
	pub fn samples_mut(&mut self) -> Result<&mut Samples> {
		Ok(self.engine_mut()?.samples_mut())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::prelude::*;

	fn offline() -> Player {
		Player::new(&PlayerOptions::new().sample_rate(8_000)).unwrap()
	}

	#[test]
	fn a_one_shot_is_heard_and_then_it_is_quiet() {
		let mut player = offline();
		let handle = player
			.play(
				&note("c4").unwrap().sound("triangle"),
				&PlayOptions::default(),
			)
			.unwrap();
		assert_eq!(handle.voices(), 1);
		let heard = player.render_seconds(0.5).unwrap();
		assert!(heard.peak() > 0.05);
		let after = player.render_seconds(2.0).unwrap();
		assert!(after.peak() < 1e-3, "the note has rung out");
	}

	#[test]
	fn a_loop_keeps_booking_as_the_clock_moves() {
		let mut player = offline();
		let handle = player
			.play_loop(
				&note("c4").unwrap().sound("triangle").release(0.05).unwrap(),
				&LoopOptions {
					bpm: Some(240.0),
					..LoopOptions::default()
				},
			)
			.unwrap();
		let heard = player.render_seconds(4.0).unwrap();
		// A note starts every second (0.1 s in): four attacks, so energy in each of the four seconds.
		for second in 0..4 {
			let from = second * 8_000 + 800;
			let window = &heard.channels()[0][from..from + 2_000];
			assert!(window.iter().any(|s| s.abs() > 0.01), "second {second}");
		}
		assert!(player.stats().ticks >= 4);
		player.stop_loop(handle, &LoopStop::default()).unwrap();
	}

	#[test]
	fn block_size_does_not_change_the_samples() {
		let pattern = note("c3 e3 g3 b3").unwrap().sound("sawtooth");
		let options = LoopOptions {
			bpm: Some(240.0),
			..LoopOptions::default()
		};
		let mut whole = offline();
		whole.play_loop(&pattern, &options).unwrap();
		let all = whole.render_seconds(2.0).unwrap();

		let mut pieces = offline();
		pieces.play_loop(&pattern, &options).unwrap();
		let mut joined: Vec<Vec<f32>> = vec![Vec::new(); 2];
		let mut left = 16_000usize;
		for size in [1usize, 7, 128, 1000].into_iter().cycle() {
			let size = size.min(left);
			let mut a = vec![0.0; size];
			let mut b = vec![0.0; size];
			let written = pieces.render_block(&mut [&mut a, &mut b]).unwrap();
			assert_eq!(written, size);
			joined[0].extend_from_slice(&a);
			joined[1].extend_from_slice(&b);
			left -= size;
			if left == 0 {
				break;
			}
		}
		assert_eq!(all.channels(), joined.as_slice());
	}

	#[test]
	fn stop_cuts_a_loop_and_its_booked_voices() {
		let mut player = offline();
		player
			.play_loop(
				&note("c4").unwrap().sound("sine").sustain(0.8).unwrap(),
				&LoopOptions {
					bpm: Some(60.0),
					..LoopOptions::default()
				},
			)
			.unwrap();
		player.render_seconds(0.5).unwrap();
		player.stop().unwrap();
		let after = player.render_seconds(1.0).unwrap();
		// The cut fades over about 10 ms; nothing is left after a tenth of a second.
		assert!(after.channels()[0][800..].iter().all(|s| s.abs() < 1e-3));
		assert_eq!(player.transport().unwrap().loop_count(), 0);
	}

	#[test]
	fn the_tempo_is_the_players_own_and_explicit_beats_it() {
		let mut player = offline();
		let pattern = note("c4 e4").unwrap();
		// 15 cycles a minute: four-second cycles, so the second note starts two seconds in.
		player.set_cpm(15.0).unwrap();
		assert_eq!(player.tempo().default_cpm(), Some(15.0));
		let own = player.play(&pattern, &PlayOptions::default()).unwrap();
		// An explicit 240 bpm is a one-second cycle: the second note starts half a second in.
		let explicit = player
			.play(
				&pattern,
				&PlayOptions {
					bpm: Some(240.0),
					..PlayOptions::default()
				},
			)
			.unwrap();
		assert!((own.end_time - explicit.end_time - 1.5).abs() < 1e-9);
		assert_eq!(
			player.set_cpm(0.0).unwrap_err().message(),
			"setcpm() must be positive, got 0"
		);
		player.reset_tempo();
		assert_eq!(player.tempo().default_cpm(), None);
	}

	#[test]
	fn shutdown_is_idempotent_and_closes_every_call() {
		let mut player = offline();
		player
			.play(&note("c4").unwrap(), &PlayOptions::default())
			.unwrap();
		player.shutdown();
		player.shutdown();
		assert!(player.is_shutdown());
		let closed = |error: Error| error.kind() == ErrorKind::Closed;
		assert!(closed(player.tick().unwrap_err()));
		assert!(closed(
			player
				.play(&note("c4").unwrap(), &PlayOptions::default())
				.unwrap_err()
		));
		assert!(closed(
			player
				.play_loop(&note("c4").unwrap(), &LoopOptions::default())
				.unwrap_err()
		));
		assert!(closed(player.render_seconds(1.0).unwrap_err()));
		assert!(closed(player.stop().unwrap_err()));
		assert!(closed(player.engine().map(|_| ()).unwrap_err()));
		assert!(closed(
			player
				.register_sample("x", SampleData::new(8_000.0, vec![vec![0.1; 10]]), None)
				.unwrap_err()
		));
		assert_eq!(player.channel_count(), 0);
		player.shutdown();
	}

	#[test]
	fn a_registered_sample_plays_and_a_bad_one_is_refused() {
		let mut player = offline();
		player
			.register_sample("blip", SampleData::new(8_000.0, vec![vec![0.5; 800]]), None)
			.unwrap();
		assert!(player.samples().unwrap().is_sample_registered("blip", None));
		player
			.play(&s("blip").unwrap(), &PlayOptions::default())
			.unwrap();
		assert!(player.render_seconds(0.5).unwrap().peak() > 0.05);
		let error = player
			.register_sample("bad", SampleData::new(8_000.0, vec![vec![]]), None)
			.unwrap_err();
		assert_eq!(error.message(), "Sample \"bad\" has no frames.");
	}

	#[test]
	fn a_bad_setup_fails_with_a_message() {
		assert_eq!(
			Player::new(&PlayerOptions::new().channels(3))
				.unwrap_err()
				.message(),
			"channels must be 1, 2, 4, 6 or 8, got 3"
		);
		assert!(Player::new(&PlayerOptions::new().sample_rate(0)).is_err());
		assert!(offline().render_seconds(0.0).is_err());
		assert!(offline().render_seconds(f64::NAN).is_err());
	}

	#[test]
	fn a_score_plays_and_loops_at_its_own_tempo() {
		let cue = Score::new(&ScoreDefinition {
			ticks_per_second: 100.0,
			length_ticks: 100.0,
			events: vec![ScoreEvent::note(0.0, ScoreNote::Name("a3".into()))],
			..ScoreDefinition::default()
		})
		.unwrap();
		let mut player = offline();
		player.play_score(&cue).unwrap();
		assert!(player.render_seconds(0.5).unwrap().peak() > 0.01);
		let handle = player.loop_score(&cue).unwrap();
		assert!(player.render_seconds(2.0).unwrap().peak() > 0.01);
		player.stop_loop(handle, &LoopStop::default()).unwrap();
	}

	#[test]
	fn a_host_graph_and_clock_work_through_with_graph() {
		let clock = ManualClock::new(48_000.0);
		let mut player = Player::with_graph(
			LogGraph::new(48_000.0, 2),
			clock.clone(),
			OutputSetup::default(),
			SchedulerOptions::default(),
		)
		.unwrap();
		let handle = player
			.play_loop(
				&note("c3").unwrap(),
				&LoopOptions {
					bpm: Some(240.0),
					..LoopOptions::default()
				},
			)
			.unwrap();
		let interval = player.transport().unwrap().tick_interval();
		for _ in 0..20 {
			clock.advance(interval);
			player
				.engine_mut()
				.unwrap()
				.graph_mut()
				.set_current_time(clock.now());
			player.tick().unwrap();
		}
		assert!(player.stats().voices_booked >= 3);
		player.stop_loop(handle, &LoopStop::default()).unwrap();
	}
}
