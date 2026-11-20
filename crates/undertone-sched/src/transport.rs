// The Transport: plays a pattern once, or loops it with a look-ahead, against a host-driven clock
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The [`Transport`], the clock-driven part of the scheduler: `play`, `play_loop`, tempo, handles, and
//! statistics, the Rust form of `src/scheduler.ts`.
//!
//! # How a loop runs
//!
//! The reference's `loop()` is the standard two-clock scheduler: a coarse timer ticks every 100 ms, and each
//! tick books the voices that start between what is already booked and 0.3 s past the audio clock, at exact
//! audio-clock times. The transport is that, without the timer. **The host owns the timer.** It calls
//! [`Transport::tick`] about every [`SchedulerOptions::tick_interval`] (a `setInterval`, a thread that sleeps,
//! the audio callback itself), and the transport reads the [`Clock`], books, and returns. Nothing in this crate
//! starts a thread or sleeps, so the same code runs in a browser worklet, a native callback, and a test that
//! moves a [`ManualClock`](crate::ManualClock) by hand.
//!
//! # Driving it from a real audio callback
//!
//! The transport books on an [`Engine`]; the engine's graph is what renders. A native host has two jobs per
//! audio callback, and they are in this order:
//!
//! 1. Keep the clock the transport reads in step with the graph the engine books on. With a
//!    `RenderGraph` of the engine crate the graph's clock is the frames it has
//!    produced, so a [`Clock`] over a frame counter that the callback bumps by the block size agrees with it.
//! 2. Call [`Transport::tick`] when the tick interval has passed, then render the block.
//!
//! The calls to `tick` can come from the audio callback itself (simplest: one thread owns the engine, the
//! transport, and the graph, and a tick is cheap when nothing is due), or from a scheduler thread that
//! holds the engine and hands finished work to the audio thread (the host's own queue; this crate does not
//! provide one). A tick that books allocates (querying a pattern and resolving its controls build
//! collections), so a hard real-time host keeps `tick` off the callback and the rendering on it. A tick that
//! books nothing allocates nothing (the allocation test in `tests/allocation.rs` pins what is allocated and
//! what is not).
//!
//! ```
//! use undertone_engine::engine::{Engine, OutputSetup};
//! use undertone_engine::graph::LogGraph;
//! use undertone_pattern::control::note;
//! use undertone_sched::{Clock, LoopOptions, ManualClock, SchedulerOptions, Transport};
//!
//! let clock = ManualClock::new(48_000.0);
//! let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default())?;
//! let mut transport = Transport::new(clock.clone(), SchedulerOptions::default())?;
//!
//! // 240 bpm: a one-second cycle with one note. The first tick books the look-ahead at once.
//! let pattern = note("c3")?;
//! let looping = transport.play_loop(
//!     &mut engine,
//!     &pattern,
//!     &LoopOptions { bpm: Some(240.0), ..LoopOptions::default() },
//! )?;
//! assert_eq!(engine.voice_count(), 1);
//!
//! // The host's timer: every `tick_interval` seconds, move the clock (here, by hand) and tick.
//! let interval = transport.options().tick_interval;
//! for _ in 0..20 {
//!     clock.advance(interval);
//!     engine.graph_mut().set_current_time(clock.now());
//!     transport.tick(&mut engine)?;
//! }
//! // Two seconds have passed: the notes of cycles 0, 1, and 2 are booked (at 0.1, 1.1, 2.1 s).
//! let record = engine.graph().finish(None);
//! let starts: Vec<f64> = record
//!     .nodes
//!     .iter()
//!     .filter(|node| node.kind == "oscillator")
//!     .map(|node| node.start[0])
//!     .collect();
//! assert_eq!(starts, [0.1, 1.1, 2.1]);
//!
//! transport.stop_loop(&mut engine, looping, &Default::default())?;
//! # Ok::<(), undertone_pattern::Error>(())
//! ```

use crate::booking::{
	book_voices, check_cycle_position, check_seconds, collect_window, window_edge,
};
use crate::clock::Clock;
use crate::stats::Stats;
use crate::tempo::Tempo;
use std::sync::atomic::{AtomicU64, Ordering};
use undertone_engine::engine::{Engine, Playback};
use undertone_engine::graph::{Graph, NodeId};
use undertone_pattern::js::number_to_string;
use undertone_pattern::{ControlMap, Error, Fraction, Pattern, Result};

/// The seconds of fade a stopped cut-group voice gets (the reference's `CUT_FADE_SECONDS`); a loop seek uses
/// it for the voices it chokes.
pub const CUT_FADE_SECONDS: f64 = 0.005;

/// How a transport is paced: the reference's look-ahead and tick, and the start headroom.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SchedulerOptions {
	/// How far ahead of the audio clock each tick books, in seconds. Default 0.3.
	pub look_ahead: f64,
	/// How often the host should call [`Transport::tick`], in seconds. Default 0.1 (the reference's 100 ms).
	/// The transport does not time itself; this is the interval the host's timer is set to, and the
	/// look-ahead should be well over it.
	pub tick_interval: f64,
	/// Headroom between a loop being started and pattern time zero, so the very first onset is not booked at
	/// exactly "now" (already past by the time its nodes exist). Default 0.1.
	pub start_latency: f64,
	/// How far behind the clock a tick still books what it missed, in seconds. Default 5.
	///
	/// A tick books every onset between what a loop has booked and the look-ahead past the clock. After a
	/// stall (a tab in the background, a laptop that slept) that span can be minutes long; booking it would
	/// stall the host for as long again and allocate a node graph for every missed note, all of it already
	/// in the past. So a tick books only the onsets that start no more than this long before the clock; the
	/// older ones are skipped, the loop moves on to the look-ahead, and the skipped onsets are counted in
	/// [`Stats::dropped_voices`](crate::Stats::dropped_voices). Five seconds is far above any scheduling
	/// hiccup (the look-ahead is 0.3 s, so a stall of a second or two still books everything it missed,
	/// late, as the reference does) and far below a suspend. `0` skips every onset that is already past.
	///
	/// This is a deliberate difference from the reference, whose `loop()` books everything it missed.
	pub max_catch_up_seconds: f64,
}

impl Default for SchedulerOptions {
	fn default() -> Self {
		Self {
			look_ahead: 0.3,
			tick_interval: 0.1,
			start_latency: 0.1,
			max_catch_up_seconds: 5.0,
		}
	}
}

impl SchedulerOptions {
	/// Checks the options.
	///
	/// # Errors
	///
	/// Fails when the look-ahead or the tick interval is not a positive finite number of seconds, or the
	/// start latency or the maximum catch-up is not a finite number of seconds from zero up.
	pub fn validate(&self) -> Result<()> {
		let positive = |name: &str, value: f64| {
			if value > 0.0 && value.is_finite() {
				Ok(())
			} else {
				Err(Error::new(format!(
					"{name} must be positive and finite, got {}",
					number_to_string(value)
				)))
			}
		};
		positive("look_ahead", self.look_ahead)?;
		positive("tick_interval", self.tick_interval)?;
		for (name, value) in [
			("start_latency", self.start_latency),
			("max_catch_up_seconds", self.max_catch_up_seconds),
		] {
			if !(value >= 0.0 && value.is_finite()) {
				return Err(Error::new(format!(
					"{name} must be zero or more and finite, got {}",
					number_to_string(value)
				)));
			}
		}
		Ok(())
	}
}

/// Options for [`Transport::play`] (the reference's `PlayOptions`).
#[derive(Debug, Clone, PartialEq)]
pub struct PlayOptions {
	/// Tempo in beats per minute, four beats to a cycle. Pass this or `cps`, not both.
	pub bpm: Option<f64>,
	/// Tempo in cycles per second. Pass this or `bpm`, not both.
	pub cps: Option<f64>,
	/// Absolute start time on the clock, in seconds. Default: now.
	pub when: Option<f64>,
	/// Where in the pattern to start, in cycles: the one cycle played is `[from, from + 1)`, and `from`
	/// sounds at `when`. Default 0.
	pub from: Fraction,
	/// Holds each event's envelope at its sustain level for its share of the cycle, as a loop does.
	/// Default `false`: envelopes stay percussive, which is what one-shot sound effects want.
	pub gated: bool,
	/// The node the voices go to; the engine's output when `None`.
	pub output: Option<NodeId>,
}

impl Default for PlayOptions {
	fn default() -> Self {
		Self {
			bpm: None,
			cps: None,
			when: None,
			from: Fraction::from_int(0),
			gated: false,
			output: None,
		}
	}
}

/// Options for [`Transport::play_loop`] (the reference's `LoopOptions`).
///
/// A loop given neither `bpm` nor `cps` follows the tempo the transport holds ([`Transport::set_cpm`],
/// [`Transport::reset_tempo`]; decision D-33): a change takes effect at the next tick. The loop keeps an
/// anchor, a pattern position paired with its time on the clock; a change moves the anchor to the end of
/// what is already booked and the new cycle length counts from there, so voices already booked keep their
/// times and the next window continues from exactly where the last ended, with no gap and no overlap. An
/// explicit `bpm` or `cps` pins the loop's tempo.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LoopOptions {
	/// Tempo in beats per minute, four beats to a cycle. Pass this or `cps`, not both. An explicit `bpm`
	/// pins the loop's tempo for its life.
	pub bpm: Option<f64>,
	/// Tempo in cycles per second. Pass this or `bpm`, not both. An explicit `cps` pins the loop's tempo for
	/// its life.
	pub cps: Option<f64>,
	/// The node the voices go to; the engine's output when `None`.
	pub output: Option<NodeId>,
}

/// What happens to the voices already booked when a loop stops (`LoopStopOptions.voices`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LoopVoices {
	/// Let them finish naturally (the default).
	#[default]
	Ring,
	/// Fade them out now, including notes booked into the look-ahead that have not started yet.
	Cut,
}

/// Options for [`Transport::stop_loop`] (the reference's `LoopStopOptions`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LoopStop {
	/// What happens to voices already booked or sounding.
	pub voices: LoopVoices,
	/// The fade-out, in seconds, for [`LoopVoices::Cut`]. Default 0.01.
	pub fade: Option<f64>,
}

/// What [`Transport::play`] returns: the booked voices' time window, and a way to stop them early (the
/// reference's `PlaybackHandle`). Stopping any number of times, before or after the voices have started or
/// finished, is safe.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaybackHandle {
	/// The earliest start of any voice, on the clock, in seconds.
	pub start_time: f64,
	/// The latest time any voice is still sounding (after its release), in seconds.
	pub end_time: f64,
	playbacks: Vec<Playback>,
}

impl PlaybackHandle {
	/// A handle for voices that started and ended where `playbacks` say; empty ones are `at`.
	fn combine(playbacks: Vec<Playback>, at: f64) -> Self {
		let (start_time, end_time) = playbacks
			.iter()
			.fold((f64::INFINITY, f64::NEG_INFINITY), |(s, e), p| {
				(s.min(p.start_time), e.max(p.end_time))
			});
		if playbacks.is_empty() {
			Self {
				start_time: at,
				end_time: at,
				playbacks,
			}
		} else {
			Self {
				start_time,
				end_time,
				playbacks,
			}
		}
	}

	/// How many voices the handle covers.
	pub fn voices(&self) -> usize {
		self.playbacks.len()
	}

	/// Stops every voice at `when` (default: the graph's clock now) with a short fade (`fade`, default 0.01
	/// s). Voices that have not started never sound; voices that already finished are untouched.
	///
	/// ```
	/// use undertone_engine::engine::{Engine, OutputSetup};
	/// use undertone_engine::graph::LogGraph;
	/// use undertone_pattern::control::note;
	/// use undertone_sched::{ManualClock, PlayOptions, SchedulerOptions, Transport};
	///
	/// let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default())?;
	/// let mut transport = Transport::new(ManualClock::new(48_000.0), SchedulerOptions::default())?;
	/// let handle = transport.play(&mut engine, &note("c3 e3")?, &PlayOptions::default())?;
	/// assert_eq!((handle.start_time, handle.end_time > 1.0), (0.0, true));
	///
	/// // Stop both notes at 0.5 s with a 20 ms fade; the second never sounds.
	/// handle.stop(&mut engine, Some(0.5), Some(0.02));
	/// # Ok::<(), undertone_pattern::Error>(())
	/// ```
	pub fn stop<G: Graph>(&self, engine: &mut Engine<G>, when: Option<f64>, fade: Option<f64>) {
		for playback in &self.playbacks {
			engine.stop(*playback, when, fade);
		}
	}
}

/// A loop a transport is running, from [`Transport::play_loop`]. Copyable: stop it with
/// [`Transport::stop_loop`] (or [`LoopHandle::stop`]); a handle for a loop that has stopped is simply ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopHandle {
	transport: u64,
	index: usize,
	generation: u64,
}

impl LoopHandle {
	/// Stops the loop on `transport` (the reference's `handle.stop(options)`): no more cycles are booked and,
	/// as `options` say, the voices already booked ring out or are cut. Stopping twice is harmless.
	///
	/// # Errors
	///
	/// Never, today; the `Result` is for symmetry with the other transport calls.
	pub fn stop<C: Clock, G: Graph>(
		self,
		transport: &mut Transport<C>,
		engine: &mut Engine<G>,
		options: &LoopStop,
	) -> Result<()> {
		transport.stop_loop(engine, self, options)
	}
}

/// What one [`Transport::tick`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TickReport {
	/// How many loops were running.
	pub loops: usize,
	/// How many voices the tick booked.
	pub booked: usize,
}

/// Cuts every playback at `now` with the cut-group fade: the rollback of a call that failed part-way.
fn cut_all<G: Graph>(engine: &mut Engine<G>, playbacks: &[Playback], now: f64) {
	for playback in playbacks {
		engine.stop(*playback, Some(now), Some(CUT_FADE_SECONDS));
	}
}

/// A loop the transport is running.
#[derive(Debug)]
struct LoopState {
	pattern: Pattern<ControlMap>,
	/// The cycle length, in seconds, now.
	cycle_seconds: f64,
	/// Whether the cycle length follows the transport's tempo (no explicit `bpm` or `cps` pinned it).
	follow: bool,
	output: Option<NodeId>,
	/// Pattern time zero on the clock.
	start_time: f64,
	/// Pattern time, in cycles, up to which voices are booked.
	scheduled_until: Fraction,
	/// Voices booked but possibly not finished, so a cut can reach them. Pruned each tick.
	live: Vec<Playback>,
	/// Voices a seek scheduled to stop at a time still ahead of the clock, and when. They stay reachable so a
	/// cut can fade them sooner. Pruned each tick, once their stop time has passed.
	stopping: Vec<(Playback, f64)>,
	/// Whether a tick has run since the loop started or was last repositioned.
	ticked: bool,
}

#[derive(Debug)]
struct LoopSlot {
	generation: u64,
	state: Option<LoopState>,
}

/// The most cycles of a skipped span that are queried to count the onsets in them, so that counting what a
/// long stall skipped stays bounded; beyond it the count is a lower bound.
const MAX_COUNTED_CYCLES: i128 = 4096;

/// How many cycles are queried at a time while counting skipped onsets.
const COUNT_CHUNK_CYCLES: i128 = 64;

/// How many onsets start in `[begin, end)`, counted in bounded chunks and for at most [`MAX_COUNTED_CYCLES`]
/// cycles from `begin`. A pattern that fails to query counts as none.
fn count_onsets(
	pattern: &Pattern<ControlMap>,
	begin: Fraction,
	end: Fraction,
	start_time: f64,
	cycle_seconds: f64,
) -> u64 {
	let end = end.min(begin + Fraction::from_int(MAX_COUNTED_CYCLES));
	let mut from = begin;
	let mut total = 0;
	while from < end {
		let to = end.min(from + Fraction::from_int(COUNT_CHUNK_CYCLES));
		match collect_window(pattern, from, to, start_time, cycle_seconds, true) {
			Ok(voices) => total += voices.len() as u64,
			Err(_) => break,
		}
		from = to;
	}
	total
}

static NEXT_TRANSPORT_ID: AtomicU64 = AtomicU64::new(1);

/// Plays and loops patterns against a [`Clock`]. See the module documentation.
///
/// The transport owns the clock, the tempo, the running loops, and the statistics. It does not own the
/// [`Engine`]: every call that books takes it, so the host decides where the engine lives (and who else may
/// touch its graph). The engine's graph clock and the transport's clock must agree: the transport books
/// against [`Clock::now`], and the engine forgets finished voices against [`Graph::current_time`].
#[derive(Debug)]
pub struct Transport<C: Clock> {
	id: u64,
	clock: C,
	options: SchedulerOptions,
	tempo: Tempo,
	loops: Vec<LoopSlot>,
	free: Vec<usize>,
	stats: Stats,
	/// The latest clock reading that was a finite time, so a clock that goes backwards or fails to be a
	/// number reads as no time passing.
	last_now: Option<f64>,
}

impl<C: Clock> Transport<C> {
	/// A transport on `clock`, paced by `options`, at the default tempo (120 bpm).
	///
	/// # Errors
	///
	/// As [`SchedulerOptions::validate`].
	pub fn new(clock: C, options: SchedulerOptions) -> Result<Self> {
		options.validate()?;
		Ok(Self {
			id: NEXT_TRANSPORT_ID.fetch_add(1, Ordering::Relaxed),
			clock,
			options,
			tempo: Tempo::new(),
			loops: Vec::new(),
			free: Vec::new(),
			stats: Stats::default(),
			last_now: None,
		})
	}

	/// The clock the transport reads.
	pub fn clock(&self) -> &C {
		&self.clock
	}

	/// The pacing options.
	pub fn options(&self) -> &SchedulerOptions {
		&self.options
	}

	/// The tempo the transport holds (D-29: a value of this transport, not a global).
	pub fn tempo(&self) -> &Tempo {
		&self.tempo
	}

	/// Sets the default tempo in cycles per minute (`setcpm`): used by every later [`Transport::play`] and
	/// [`Transport::play_loop`] that gives neither `bpm` nor `cps`, and, at the next tick, by the loops already
	/// running without one (they follow it; see [`LoopOptions`]). An explicit `bpm` or `cps` on a call always
	/// wins.
	///
	/// # Errors
	///
	/// As [`Tempo::set_cpm`].
	pub fn set_cpm(&mut self, cycles_per_minute: f64) -> Result<()> {
		self.tempo.set_cpm(cycles_per_minute)
	}

	/// Clears the default tempo, restoring 120 bpm (`resetTempo`).
	pub fn reset_tempo(&mut self) {
		self.tempo.reset();
	}

	/// How long to wait before the next [`Transport::tick`], in seconds: the tick interval.
	pub fn tick_interval(&self) -> f64 {
		self.options.tick_interval
	}

	/// A snapshot of the statistics, with the clock's frame count and output latency filled in.
	pub fn stats(&self) -> Stats {
		Stats {
			frames_played: self.clock.frames_played(),
			output_latency: self.clock.output_latency(),
			..self.stats
		}
	}

	/// Zeroes the counters.
	pub fn reset_stats(&mut self) {
		self.stats = Stats::default();
	}

	/// Records how long one audio callback took, in seconds, for the statistics. The host measures it (this
	/// crate reads no wall clock).
	pub fn record_callback(&mut self, seconds: f64) {
		if seconds.is_finite() && seconds >= 0.0 {
			self.stats.callbacks += 1;
			self.stats.callback_seconds_total += seconds;
			self.stats.callback_seconds_last = seconds;
			if seconds > self.stats.callback_seconds_max {
				self.stats.callback_seconds_max = seconds;
			}
		}
	}

	/// Counts an underrun the host saw (the output device asked for audio the engine had not produced).
	pub fn record_underrun(&mut self) {
		self.stats.underruns += 1;
	}

	/// How many loops are running.
	pub fn loop_count(&self) -> usize {
		self.loops
			.iter()
			.filter(|slot| slot.state.is_some())
			.count()
	}

	/// Whether the loop named by `handle` is still running.
	pub fn is_running(&self, handle: LoopHandle) -> bool {
		self.state(handle).is_some()
	}

	/// The pattern time, in cycles, a running loop has booked up to, or `None` for a loop that stopped.
	pub fn scheduled_until(&self, handle: LoopHandle) -> Option<Fraction> {
		self.state(handle).map(|state| state.scheduled_until)
	}

	fn state(&self, handle: LoopHandle) -> Option<&LoopState> {
		if handle.transport != self.id {
			return None;
		}
		let slot = self.loops.get(handle.index)?;
		if slot.generation != handle.generation {
			return None;
		}
		slot.state.as_ref()
	}

	/// Reads the clock. A reading that is not finite, or is before an earlier one, is no time passing: it
	/// reads as the latest good time (zero before any) and is counted in
	/// [`Stats::bad_clock_reads`](crate::Stats::bad_clock_reads).
	fn read_now(&mut self) -> f64 {
		let raw = self.clock.now();
		match self.last_now {
			Some(last) if !(raw.is_finite() && raw >= last) => {
				self.stats.bad_clock_reads += 1;
				last
			}
			None if !raw.is_finite() => {
				self.stats.bad_clock_reads += 1;
				0.0
			}
			_ => {
				self.last_now = Some(raw);
				raw
			}
		}
	}

	fn count_late(&mut self, playbacks: &[Playback], now: f64) {
		self.stats.voices_booked += playbacks.len() as u64;
		self.stats.late_voices += playbacks.iter().filter(|p| p.start_time < now).count() as u64;
	}

	/// Plays one cycle of the pattern as a one-shot (the reference's `play()`): books every voice that starts
	/// in `[from, from + 1)` cycles, with `from` sounding at `options.when` (default: now).
	///
	/// Envelopes stay percussive unless [`PlayOptions::gated`].
	///
	/// # Errors
	///
	/// An invalid tempo fails with the reference's message (`bpm must be positive, got 0`, `Pass either bpm or
	/// cps, not both`). Then as `book_cycles`. A call that fails **rolls back**: voices
	/// booked before the failing one are cut at once (with the 5 ms cut-group fade), nothing is counted in
	/// [`Stats`], and no handle is lost, because none is returned. The reference's `play()` throws part-way
	/// and leaves the earlier voices sounding; this is deliberately better (D-38).
	///
	/// ```
	/// use undertone_engine::engine::{Engine, OutputSetup};
	/// use undertone_engine::graph::LogGraph;
	/// use undertone_pattern::control::note;
	/// use undertone_sched::{ManualClock, PlayOptions, SchedulerOptions, Transport};
	///
	/// let clock = ManualClock::new(48_000.0);
	/// clock.set(3.0);
	/// let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default())?;
	/// let mut transport = Transport::new(clock, SchedulerOptions::default())?;
	///
	/// // 120 bpm: two-second cycles, so two notes start at 3 s and 4 s.
	/// let handle = transport.play(&mut engine, &note("c3 e3")?, &PlayOptions::default())?;
	/// assert_eq!(handle.voices(), 2);
	/// assert_eq!(handle.start_time, 3.0);
	///
	/// // `from` starts half a cycle in: the second note is now first, at `when`.
	/// let options = PlayOptions {
	///     when: Some(10.0),
	///     from: undertone_pattern::Fraction::new(1, 2),
	///     ..PlayOptions::default()
	/// };
	/// let handle = transport.play(&mut engine, &note("c3 e3")?, &options)?;
	/// assert_eq!((handle.voices(), handle.start_time), (2, 10.0));
	/// # Ok::<(), undertone_pattern::Error>(())
	/// ```
	pub fn play<G: Graph>(
		&mut self,
		engine: &mut Engine<G>,
		pattern: &Pattern<ControlMap>,
		options: &PlayOptions,
	) -> Result<PlaybackHandle> {
		let cycle_seconds = self.tempo.cycle_seconds(options.bpm, options.cps)?;
		let now = self.read_now();
		let at = options.when.unwrap_or(now);
		check_seconds("when", at)?;
		let from = options.from;
		check_cycle_position(from)?;
		check_cycle_position(from + Fraction::from_int(1))?;
		let start_time = if from == Fraction::from_int(0) {
			at
		} else {
			at - from.to_f64() * cycle_seconds
		};
		let voices = collect_window(
			pattern,
			from,
			from + Fraction::from_int(1),
			start_time,
			cycle_seconds,
			options.gated,
		)?;
		let mut playbacks = Vec::with_capacity(voices.len());
		if let Err(error) = book_voices(engine, &voices, options.output, &mut playbacks) {
			// Roll back: the caller gets no handle, so nothing booked may be left sounding or counted.
			cut_all(engine, &playbacks, now);
			return Err(error);
		}
		self.count_late(&playbacks, now);
		Ok(PlaybackHandle::combine(playbacks, at))
	}

	/// Loops the pattern indefinitely (the reference's `loop()`): the first window, up to the look-ahead past
	/// the clock, is booked now, and each [`Transport::tick`] extends it.
	///
	/// Pattern time zero is `start_latency` (0.1 s) after the clock, so the first onset is not booked at
	/// exactly "now". Voices are gated: each holds for its event's share of the cycle. The loop follows the
	/// transport's tempo as it changes unless `options` give an explicit `bpm` or `cps` (see
	/// [`LoopOptions`]); the reference's `loop()` of before D-33 read the tempo once.
	///
	/// # Errors
	///
	/// An invalid tempo fails with the reference's message. A first window that fails to book fails the call,
	/// starts no loop, and **rolls back**: voices of that window booked before the failure are cut at once
	/// (with the 5 ms cut-group fade) and are not counted in [`Stats`] (D-38; the reference leaves them
	/// sounding). Once a loop is running, a window that fails keeps the voices it booked tracked, so a stop
	/// reaches them; see [`Transport::tick`].
	pub fn play_loop<G: Graph>(
		&mut self,
		engine: &mut Engine<G>,
		pattern: &Pattern<ControlMap>,
		options: &LoopOptions,
	) -> Result<LoopHandle> {
		let cycle_seconds = self.tempo.cycle_seconds(options.bpm, options.cps)?;
		let now = self.read_now();
		let counted = (self.stats.voices_booked, self.stats.late_voices);
		let state = LoopState {
			pattern: pattern.clone(),
			cycle_seconds,
			follow: options.bpm.is_none() && options.cps.is_none(),
			output: options.output,
			start_time: now + self.options.start_latency,
			scheduled_until: Fraction::from_int(0),
			live: Vec::new(),
			stopping: Vec::new(),
			ticked: false,
		};
		let handle = self.insert(state);
		// The first tick: book the window now. A failure to even collect it leaves no loop behind.
		let result = self.tick_loop(engine, handle.index, now);
		match result {
			Ok(_) => Ok(handle),
			Err(error) => {
				// Roll back: cut what the window booked and take it back out of the statistics.
				if let Some(state) = self.remove(handle) {
					cut_all(engine, &state.live, now);
				}
				(self.stats.voices_booked, self.stats.late_voices) = counted;
				Err(error)
			}
		}
	}

	fn insert(&mut self, state: LoopState) -> LoopHandle {
		let index = match self.free.pop() {
			Some(index) => index,
			None => {
				self.loops.push(LoopSlot {
					generation: 0,
					state: None,
				});
				self.loops.len() - 1
			}
		};
		self.loops[index].state = Some(state);
		LoopHandle {
			transport: self.id,
			index,
			generation: self.loops[index].generation,
		}
	}

	fn remove(&mut self, handle: LoopHandle) -> Option<LoopState> {
		self.state(handle)?;
		let slot = &mut self.loops[handle.index];
		slot.generation += 1;
		self.free.push(handle.index);
		slot.state.take()
	}

	/// One tick of the scheduler: books, for every running loop, the voices between what is booked and the
	/// look-ahead past the clock. The host calls this about every [`SchedulerOptions::tick_interval`]. A
	/// tick with nothing due books nothing and allocates nothing.
	///
	/// A loop whose window cannot be queried (a pattern that fails) is left where it was and tried again at
	/// the next tick, as the reference does; the first such error is returned after every loop has had its
	/// tick. A voice the engine cannot book is skipped (its window is not tried again, so nothing is booked
	/// twice) and the error is returned the same way. The voices of that window booked before the failing one
	/// stay tracked in the loop, so stopping the loop (or a seek) still reaches them: a running loop does not
	/// roll back, unlike the first window of [`Transport::play_loop`].
	///
	/// # Errors
	///
	/// The first error of the tick, as above.
	pub fn tick<G: Graph>(&mut self, engine: &mut Engine<G>) -> Result<TickReport> {
		let now = self.read_now();
		self.stats.ticks += 1;
		let mut report = TickReport::default();
		let mut first_error = None;
		for index in 0..self.loops.len() {
			if self.loops[index].state.is_none() {
				continue;
			}
			report.loops += 1;
			match self.tick_loop(engine, index, now) {
				Ok(booked) => report.booked += booked,
				Err(error) => {
					first_error.get_or_insert(error);
				}
			}
		}
		if report.booked > 0 {
			self.stats.booking_ticks += 1;
		}
		match first_error {
			Some(error) => Err(error),
			None => Ok(report),
		}
	}

	/// Ticks one loop; returns how many voices were booked.
	fn tick_loop<G: Graph>(
		&mut self,
		engine: &mut Engine<G>,
		index: usize,
		now: f64,
	) -> Result<usize> {
		let Some(mut state) = self.loops[index].state.take() else {
			return Ok(0);
		};
		let outcome = self.tick_state(engine, &mut state, now);
		self.loops[index].state = Some(state);
		outcome
	}

	fn tick_state<G: Graph>(
		&mut self,
		engine: &mut Engine<G>,
		state: &mut LoopState,
		now: f64,
	) -> Result<usize> {
		if state.follow {
			let cycle_seconds = self.tempo.cycle_seconds(None, None)?;
			if cycle_seconds != state.cycle_seconds {
				// Move the anchor to the end of what is booked: that position keeps its time on the clock, and
				// the new cycle length counts from it.
				let booked_until =
					state.start_time + state.scheduled_until.to_f64() * state.cycle_seconds;
				state.start_time = booked_until - state.scheduled_until.to_f64() * cycle_seconds;
				state.cycle_seconds = cycle_seconds;
			}
		}
		// The clock passed the end of what this loop booked: the output had nothing to play.
		if state.ticked
			&& now > state.start_time + state.scheduled_until.to_f64() * state.cycle_seconds
		{
			self.stats.underruns += 1;
		}
		state.ticked = true;
		let horizon_seconds = now + self.options.look_ahead - state.start_time;
		let horizon = window_edge(horizon_seconds, state.cycle_seconds)?;
		if horizon <= state.scheduled_until {
			return Ok(0);
		}
		state.live.retain(|playback| playback.end_time > now);
		state.stopping.retain(|(_, stop_at)| *stop_at > now);
		// Skip what is too far in the past to be worth booking (a suspended host), and count it.
		let oldest = now - self.options.max_catch_up_seconds - state.start_time;
		if oldest > 0.0 {
			let floor = window_edge(oldest, state.cycle_seconds)?.min(horizon);
			if floor > state.scheduled_until {
				self.stats.dropped_voices += count_onsets(
					&state.pattern,
					state.scheduled_until,
					floor,
					state.start_time,
					state.cycle_seconds,
				);
				state.scheduled_until = floor;
			}
		}
		let voices = collect_window(
			&state.pattern,
			state.scheduled_until,
			horizon,
			state.start_time,
			state.cycle_seconds,
			true,
		)?;
		// From here the window is spent, whatever the booking does: booking it again would double it.
		state.scheduled_until = horizon;
		let before = state.live.len();
		let booked = book_voices(engine, &voices, state.output, &mut state.live);
		let made = state.live.len() - before;
		let late = state.live[before..]
			.iter()
			.filter(|playback| playback.start_time < now)
			.count();
		self.stats.voices_booked += made as u64;
		self.stats.late_voices += late as u64;
		booked.map(|()| made)
	}

	/// Stops a loop (the reference's `LoopHandle.stop`): no more cycles are booked. With
	/// [`LoopVoices::Cut`] the voices already booked, including ones in the look-ahead that have not started,
	/// are faded out now over `fade` seconds (default 0.01); with [`LoopVoices::Ring`] they finish naturally.
	/// A handle for a loop that has already stopped is ignored.
	///
	/// # Errors
	///
	/// Never, today; the `Result` keeps room for hosts whose engine can fail to stop.
	pub fn stop_loop<G: Graph>(
		&mut self,
		engine: &mut Engine<G>,
		handle: LoopHandle,
		options: &LoopStop,
	) -> Result<()> {
		let now = self.read_now();
		if let Some(state) = self.remove(handle)
			&& options.voices == LoopVoices::Cut
		{
			for playback in &state.live {
				engine.stop(*playback, Some(now), options.fade);
			}
			// Voices a seek had scheduled to stop later: only those whose stop is still ahead are touched,
			// since a cut now would reopen one that has already faded.
			for (playback, stop_at) in &state.stopping {
				if *stop_at > now {
					engine.stop(*playback, Some(now), options.fade);
				}
			}
		}
		Ok(())
	}

	/// Moves a running loop to pattern position `from` (in cycles), sounding at `when` (default: now plus the
	/// start latency). The voices already booked are cut at `when` with the cut-group fade (5 ms): the ones
	/// that start after it never sound, and the ones sounding are choked. The first window from the new
	/// position is booked at once.
	///
	/// Returns `false` for a handle whose loop has stopped, and changes nothing.
	///
	/// # Errors
	///
	/// As the loop's first window: a pattern that fails to query, or a voice that fails to book.
	///
	/// ```
	/// use undertone_engine::engine::{Engine, OutputSetup};
	/// use undertone_engine::graph::LogGraph;
	/// use undertone_pattern::{Fraction, control::note};
	/// use undertone_sched::{LoopOptions, ManualClock, SchedulerOptions, Transport};
	///
	/// let clock = ManualClock::new(48_000.0);
	/// let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default())?;
	/// let mut transport = Transport::new(clock.clone(), SchedulerOptions::default())?;
	/// let pattern = note("c3 e3 g3 b3")?;
	/// let looping = transport.play_loop(
	///     &mut engine,
	///     &pattern,
	///     &LoopOptions { bpm: Some(240.0), ..LoopOptions::default() }, // one-second cycles
	/// )?;
	///
	/// // Jump to the third note (half a cycle in), sounding at 1 s.
	/// assert!(transport.seek(&mut engine, looping, Fraction::new(1, 2), Some(1.0))?);
	/// // Nothing sounds before 1 s, and the look-ahead has not reached it: booking waits for the clock.
	/// assert_eq!(transport.scheduled_until(looping), Some(Fraction::new(1, 2)));
	/// # Ok::<(), undertone_pattern::Error>(())
	/// ```
	pub fn seek<G: Graph>(
		&mut self,
		engine: &mut Engine<G>,
		handle: LoopHandle,
		from: Fraction,
		when: Option<f64>,
	) -> Result<bool> {
		let now = self.read_now();
		if self.state(handle).is_none() {
			return Ok(false);
		}
		let when = when.unwrap_or(now + self.options.start_latency);
		check_seconds("when", when)?;
		check_cycle_position(from)?;
		let Some(mut state) = self.loops[handle.index].state.take() else {
			return Ok(false);
		};
		// Voices an earlier seek scheduled to stop after `when` stop at `when` instead.
		for (playback, stop_at) in &mut state.stopping {
			if *stop_at > when {
				engine.stop(*playback, Some(when), Some(CUT_FADE_SECONDS));
				*stop_at = when;
			}
		}
		for playback in state.live.drain(..) {
			engine.stop(playback, Some(when), Some(CUT_FADE_SECONDS));
			// Keep it reachable while the stop is still ahead of the clock, so a cut can bring it forward.
			if when > now {
				state.stopping.push((playback, when));
			}
		}
		state.start_time = when - from.to_f64() * state.cycle_seconds;
		state.scheduled_until = from;
		state.ticked = false;
		let outcome = self.tick_state(engine, &mut state, now);
		self.loops[handle.index].state = Some(state);
		outcome.map(|_| true)
	}

	/// Stops every running loop, as [`Transport::stop_loop`] does for each.
	///
	/// # Errors
	///
	/// As [`Transport::stop_loop`].
	pub fn stop_all<G: Graph>(&mut self, engine: &mut Engine<G>, options: &LoopStop) -> Result<()> {
		for index in 0..self.loops.len() {
			if self.loops[index].state.is_some() {
				let handle = LoopHandle {
					transport: self.id,
					index,
					generation: self.loops[index].generation,
				};
				self.stop_loop(engine, handle, options)?;
			}
		}
		Ok(())
	}
}
