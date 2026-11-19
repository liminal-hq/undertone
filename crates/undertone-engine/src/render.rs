// Offline rendering from a pattern: the options, the plan, and the booking of every onset on a graph
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The planning and booking half of `renderToBuffer` (`src/render.ts`): which voices a pattern gives over some
//! cycles, and the booking of them on a [`Graph`] up front or in windows. Turning the booked graph into samples
//! is the renderer's work; this module ends where the graph is ready to be rendered, so any [`Graph`] can be
//! driven by it, a [`LogGraph`](crate::graph::LogGraph) to record the calls or a renderer to hear them.
//!
//! A render has no real-time clock. Every onset of the pattern is turned into a voice, the voices are put in
//! time order (so a cut group chokes the voice that really played before), and they are booked on the graph. With
//! [`RenderOptions::booking_window`] they are booked in windows instead: the render is paused a window ahead of
//! each window's first onset, that window's voices are booked, and the render goes on. The audio is the same;
//! a renderer that processes every node from the moment it is made does far less work. The pause is the
//! host's: [`RenderPlan::book_pattern`] takes a function that is called at each pause with the graph and the
//! time to pause at, and it is where a renderer renders up to that time and a recording graph sets its clock.
//!
//! The steps, with the guide's wording (`docs/guide/rendering-and-export.md`):
//!
//! 1. [`RenderPlan::new`] checks the [`RenderOptions`] and works out the length of the render: a pass is
//!    `cycles` whole cycles, or `seconds`, at the tempo from `bpm` or `cps` (120 bpm, two seconds a cycle, when
//!    neither is given); the `tail` is extra time after the pass for releases and reverb to ring out.
//! 2. [`RenderPlan::book_pattern`] makes the [`Engine`] (with the master bus, the multichannel destination, and
//!    the seed of noise and reverb) and books the pattern.
//! 3. The host renders the graph. For `wrap`, [`RenderPlan::finish`] then folds the tail onto the start so the
//!    result loops without a gap, and holds it to the master `ceiling`.
//!
//! ```
//! use undertone_engine::graph::LogGraph;
//! use undertone_engine::render::{RenderOptions, RenderPlan};
//! use undertone_pattern::control::note;
//!
//! // Two notes in one cycle, rendered at 1280 Hz for two seconds (120 bpm).
//! let pattern = note("c4 e4")?;
//! let plan = RenderPlan::new(&RenderOptions {
//!     sample_rate: Some(1280.0),
//!     ..RenderOptions::default()
//! })?;
//! assert_eq!(plan.length, 2560);
//!
//! // The graph is made at the plan's sample rate and channel count, and nothing needs to pause.
//! let graph = LogGraph::new(plan.sample_rate, plan.channels);
//! let engine = plan.book_pattern(graph, &pattern, |_, _| Ok(()))?;
//!
//! // The second note starts at one second; its oscillator is the fourth node (after the master bus's three
//! // nodes and the first voice's two).
//! let record = engine.into_graph().finish(Some(plan.length as u64));
//! let starts: Vec<f64> = record
//!     .nodes
//!     .iter()
//!     .filter(|node| node.kind == "oscillator")
//!     .map(|node| node.start[0])
//!     .collect();
//! assert_eq!(starts, [0.0, 1.0]);
//! # Ok::<(), undertone_pattern::Error>(())
//! ```

use crate::engine::{Engine, OutputSetup, Playback};
use crate::graph::{Graph, NodeId};
use crate::master::{MasterBusOptions, ceiling_top};
use crate::math::{js_max, js_min, js_pow};
use crate::params::resolve_params;
use crate::samples::Samples;
use crate::window::{
	PendingVoice, RENDER_QUANTUM_FRAMES, booking_windows, check_booking_window, last_room_sizes,
	sort_booking_order,
};
use undertone_pattern::js::{is_integer, number_to_string, round};
use undertone_pattern::random::Seed;
use undertone_pattern::{ControlMap, Error, Fraction, Pattern, Result, Span, Value};

/// The sample rate of a render that gives none.
pub const DEFAULT_SAMPLE_RATE: f64 = 48_000.0;

/// The tempo of a render that gives none, in beats per minute (four beats to a cycle).
pub const DEFAULT_BPM: f64 = 120.0;

/// Seconds one cycle lasts at one beat per minute: four beats to a cycle.
const SECONDS_PER_CYCLE_AT_1_BPM: f64 = 240.0;

/// The most cycles a render queries. The reference has no bound (an infinite count hangs it); this one keeps the
/// pattern queries of [`RenderPlan::collect_voices`] finite. A deliberate difference, listed in
/// `conformance/README.md`.
pub const MAX_RENDER_CYCLES: f64 = 1_048_576.0;

/// The most frames a render may be (tail included), about an hour and a half at 48000 Hz. The reference has no
/// bound (a context that size fails to allocate); this one makes the error a message instead of an abort.
pub const MAX_RENDER_FRAMES: f64 = 268_435_456.0;

/// The highest sample rate a render accepts, in hertz. Well above any real audio rate.
pub const MAX_SAMPLE_RATE: f64 = 1_000_000.0;

/// The output channel counts a render accepts.
const CHANNEL_COUNTS: [f64; 5] = [1.0, 2.0, 4.0, 6.0, 8.0];

/// How a render treats the master bus (`RenderOptions.master`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum MasterSetting {
	/// Route through the master bus with its default limiter (the default, `master: true`).
	#[default]
	On,
	/// Send the voices to the destination as they are (`master: false`).
	Off,
	/// Route through a master bus tuned with these options (`master: { gain, limiter, ceiling }`); the
	/// options' `output` is ignored. A `ceiling` bounds the returned samples, including after `wrap` folds
	/// the tail ([`RenderPlan::finish`]).
	Tuned(MasterBusOptions),
}

/// What a render is asked to do: the Rust form of the reference's `RenderOptions`, every field optional.
///
/// Numbers are `f64` as the JavaScript's are, so a value the reference rejects (a half cycle, a count of three
/// channels) is rejected here with the same message. `context`, which builds an `OfflineAudioContext`, has no
/// Rust form: the host makes the [`Graph`] from the plan instead.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RenderOptions {
	/// Whole pattern cycles to render. Default 1 when `seconds` is omitted. Pass this or `seconds`, not both.
	pub cycles: Option<f64>,
	/// Seconds of the pattern to render: onsets at or after this time are dropped, and the pass ends at it.
	pub seconds: Option<f64>,
	/// Tempo in beats per minute (four beats a cycle). Pass this or `cps`.
	pub bpm: Option<f64>,
	/// Tempo in cycles per second. Falls back to `default_cpm`, then to 120 bpm.
	pub cps: Option<f64>,
	/// The sample rate of the render. Default 48000.
	pub sample_rate: Option<f64>,
	/// Output channels: 1, 2, 4, 6, or 8. More than two uses discrete multichannel output. Default 2.
	pub channels: Option<f64>,
	/// Extra seconds rendered after the pattern, so releases and reverb can ring out. Default 0.
	pub tail: Option<f64>,
	/// Folds the tail onto the start, so the result loops seamlessly and is exactly one pass long
	/// ([`RenderPlan::finish`]). Default false.
	pub wrap: Option<bool>,
	/// Seeds noise and reverb, so the same inputs give the same samples. Default 0.
	pub seed: Option<Seed>,
	/// Holds each note for its share of the cycle, like `loop()`. `false` is a one-shot like `play()`. Default
	/// true.
	pub gated: Option<bool>,
	/// The master bus and its limiter. Default [`MasterSetting::On`].
	pub master: Option<MasterSetting>,
	/// Books the voices in windows of this many seconds instead of all up front. Must cover at least two render
	/// quanta (256 frames). Default: off.
	pub booking_window: Option<f64>,
	/// The host's default tempo in cycles per minute (the reference's `setcpm()`), used when neither `bpm` nor
	/// `cps` is given. Rust has no global tempo, so the host holds it and passes it here.
	pub default_cpm: Option<f64>,
}

/// The seconds one cycle lasts for a tempo (`cycleSecondsFor`): `cps` cycles per second, or `bpm` beats per
/// minute with four beats to a cycle, or `default_cpm` cycles per minute, or 120 bpm.
///
/// # Errors
///
/// Fails with the reference's message when both `bpm` and `cps` are given, or the one given is not positive.
/// Beyond the reference, which would turn an infinite `cps` into a zero-length cycle, it also fails when
/// `cps`, `bpm`, or `default_cpm` is infinite, and when `default_cpm` is not positive (a deliberate
/// difference, listed in `conformance/README.md`).
///
/// ```
/// use undertone_engine::render::cycle_seconds_for;
/// assert_eq!(cycle_seconds_for(None, None, None)?, 2.0);
/// assert_eq!(cycle_seconds_for(Some(60.0), None, None)?, 4.0);
/// assert_eq!(cycle_seconds_for(None, Some(0.25), None)?, 4.0);
/// assert_eq!(
///     cycle_seconds_for(Some(60.0), Some(1.0), None).unwrap_err().message(),
///     "Pass either bpm or cps, not both"
/// );
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
#[allow(clippy::neg_cmp_op_on_partial_ord)] // `!(x > 0)` is true for NaN, as the reference's check is
pub fn cycle_seconds_for(
	bpm: Option<f64>,
	cps: Option<f64>,
	default_cpm: Option<f64>,
) -> Result<f64> {
	if let Some(cps) = cps {
		if bpm.is_some() {
			return Err(Error::new("Pass either bpm or cps, not both"));
		}
		if !(cps > 0.0) {
			return Err(Error::new(format!(
				"cps must be positive, got {}",
				number_to_string(cps)
			)));
		}
		if !cps.is_finite() {
			return Err(Error::new(format!(
				"cps must be finite, got {}",
				number_to_string(cps)
			)));
		}
		return Ok(1.0 / cps);
	}
	if let Some(bpm) = bpm {
		if !(bpm > 0.0) {
			return Err(Error::new(format!(
				"bpm must be positive, got {}",
				number_to_string(bpm)
			)));
		}
		if !bpm.is_finite() {
			return Err(Error::new(format!(
				"bpm must be finite, got {}",
				number_to_string(bpm)
			)));
		}
		return Ok(SECONDS_PER_CYCLE_AT_1_BPM / bpm);
	}
	if let Some(cpm) = default_cpm {
		if !(cpm > 0.0) || !cpm.is_finite() {
			return Err(Error::new(format!(
				"default_cpm must be positive and finite, got {}",
				number_to_string(cpm)
			)));
		}
		return Ok(60.0 / cpm);
	}
	Ok(SECONDS_PER_CYCLE_AT_1_BPM / DEFAULT_BPM)
}

/// Turns every event onset in `span` into a voice, without booking anything (`collectOnsets`), so a caller can
/// inspect or reorder them first. `pattern_start_time` is where cycle 0 starts on the graph's clock and
/// `cycle_seconds` is how long a cycle lasts.
///
/// An event whose part does not start at its whole's start is a tail overlapping the span, not an onset, and is
/// skipped. When `gated`, each voice's envelope holds until its event's share of the cycle ends (the note
/// length); otherwise envelopes run their percussive course. An explicit `duration` in the event wins, and a
/// `legato` scales the event's own length and gates even a one-shot.
///
/// # Errors
///
/// A pattern that fails when queried (a chord whose voicing anchor is wrong) fails with the reference's message.
pub fn collect_onsets(
	pattern: &Pattern<ControlMap>,
	span: Span,
	pattern_start_time: f64,
	cycle_seconds: f64,
	gated: bool,
) -> Result<Vec<PendingVoice>> {
	let mut voices = Vec::new();
	for hap in pattern.try_query(span)? {
		let Some(whole) = hap.whole else { continue };
		if whole.begin != hap.part.begin {
			continue;
		}
		let start_time = pattern_start_time + whole.begin.to_f64() * cycle_seconds;
		let event_seconds = (whole.end - whole.begin).to_f64() * cycle_seconds;
		let gate = match hap.value.get("legato").and_then(Value::as_number) {
			Some(legato) => Some(event_seconds * legato),
			None if gated => Some(event_seconds),
			None => None,
		};
		let mut value = hap.value;
		if let (Some(gate), Value::Map(map)) = (gate, &mut value) {
			// `{ duration, ...value }`: the event's own keys win.
			map.entry("duration".into()).or_insert(Value::Num(gate));
		}
		voices.push(PendingVoice {
			start_time,
			params: resolve_params(&value),
		});
	}
	Ok(voices)
}

/// Books every onset in `span` as a voice on the engine, `start_time` being where cycle 0 starts on the graph's
/// clock (`scheduleSpan`). The voices go to `output` when given, the engine's output otherwise. This is the
/// step the reference's `play()` takes once for the first cycle and `loop()` takes for each window of its
/// look-ahead; the timer that calls it for a loop belongs to the host.
///
/// # Errors
///
/// As [`collect_onsets`] and [`Engine::play`].
pub fn schedule_span<G: Graph>(
	engine: &mut Engine<G>,
	pattern: &Pattern<ControlMap>,
	span: Span,
	start_time: f64,
	cycle_seconds: f64,
	gated: bool,
	output: Option<NodeId>,
) -> Result<Vec<Playback>> {
	let output = output.unwrap_or_else(|| engine.output());
	collect_onsets(pattern, span, start_time, cycle_seconds, gated)?
		.iter()
		.map(|voice| engine.play_to(output, &voice.params, voice.start_time))
		.collect()
}

/// A render, checked: its length, tempo, and the settings the engine needs. Made by [`RenderPlan::new`] from the
/// [`RenderOptions`], with the reference's checks in the reference's order.
///
/// The fields are what a host needs to make its graph: build it at `sample_rate` with `channels` channels and
/// `length` frames.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderPlan {
	/// The sample rate in hertz.
	pub sample_rate: f64,
	/// The output channels: 1, 2, 4, 6, or 8.
	pub channels: u32,
	/// Seconds rendered after the pass.
	pub tail: f64,
	/// Seconds one cycle lasts.
	pub cycle_seconds: f64,
	/// How many cycles are queried.
	pub cycles: f64,
	/// Seconds of the pass, before the tail: `cycles` cycles, or the `seconds` asked for.
	pub pass_seconds: f64,
	/// Frames of the pass, at least 1. A wrapped render is exactly this long.
	pub pass_length: usize,
	/// Frames of the whole render, the tail included, at least 1.
	pub length: usize,
	/// The `seconds` asked for: onsets at or after it are dropped.
	pub seconds: Option<f64>,
	/// Whether the tail is folded onto the start.
	pub wrap: bool,
	/// Whether envelopes are held for their note's length.
	pub gated: bool,
	/// The seed of noise and reverb.
	pub seed: Seed,
	/// The master bus.
	pub master: MasterSetting,
	/// The window the voices are booked in, if they are.
	pub booking_window: Option<f64>,
}

/// `${name} must be positive, got ${value}` unless `value` is a positive finite number.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn require_positive(name: &str, value: f64) -> Result<()> {
	if !(value > 0.0) || !value.is_finite() {
		return Err(Error::new(format!(
			"{name} must be positive, got {}",
			number_to_string(value)
		)));
	}
	Ok(())
}

impl RenderPlan {
	/// Checks the options and works out the length of the render.
	///
	/// # Errors
	///
	/// Fails with the reference's message, in the reference's order: both `cycles` and `seconds`; a channel count
	/// that is not 1, 2, 4, 6, or 8; a sample rate that is not positive; a tail that is negative or not finite; a
	/// booking window that is not positive or covers under two render quanta (256 frames); both `bpm` and `cps`,
	/// or one that is not positive; `seconds` that is not positive; `cycles` that is not a positive whole number.
	/// Then the limits the reference lacks (deliberate differences): a tempo that is infinite or a `default_cpm`
	/// that is not positive and finite, a sample rate above [`MAX_SAMPLE_RATE`], more than [`MAX_RENDER_CYCLES`]
	/// cycles, and a render longer than [`MAX_RENDER_FRAMES`] frames. Each is an error, where the reference
	/// would hang or fail to allocate.
	#[allow(clippy::neg_cmp_op_on_partial_ord)]
	pub fn new(options: &RenderOptions) -> Result<RenderPlan> {
		if options.cycles.is_some() && options.seconds.is_some() {
			return Err(Error::new("Pass either cycles or seconds, not both"));
		}
		let channels = options.channels.unwrap_or(2.0);
		if !CHANNEL_COUNTS.contains(&channels) {
			return Err(Error::new(format!(
				"channels must be 1, 2, 4, 6 or 8, got {}",
				number_to_string(channels)
			)));
		}
		let sample_rate = options.sample_rate.unwrap_or(DEFAULT_SAMPLE_RATE);
		require_positive("sampleRate", sample_rate)?;
		if sample_rate > MAX_SAMPLE_RATE {
			return Err(Error::new(format!(
				"sampleRate must be at most {}, got {}",
				number_to_string(MAX_SAMPLE_RATE),
				number_to_string(sample_rate)
			)));
		}
		let tail = options.tail.unwrap_or(0.0);
		if !(tail >= 0.0) || !tail.is_finite() {
			return Err(Error::new(format!(
				"tail must be zero or more seconds, got {}",
				number_to_string(tail)
			)));
		}
		if let Some(window) = options.booking_window {
			check_booking_window(window, sample_rate)?;
		}
		let cycle_seconds = cycle_seconds_for(options.bpm, options.cps, options.default_cpm)?;

		let (cycles, pass_seconds) = match options.seconds {
			Some(seconds) => {
				require_positive("seconds", seconds)?;
				((seconds / cycle_seconds).ceil(), seconds)
			}
			None => {
				let cycles = options.cycles.unwrap_or(1.0);
				if !is_integer(cycles) || cycles < 1.0 {
					return Err(Error::new(format!(
						"cycles must be a positive whole number, got {}",
						number_to_string(cycles)
					)));
				}
				(cycles, cycles * cycle_seconds)
			}
		};
		if !(cycles <= MAX_RENDER_CYCLES) {
			return Err(Error::new(format!(
				"too many cycles ({}): a render is at most {}",
				number_to_string(cycles),
				number_to_string(MAX_RENDER_CYCLES)
			)));
		}
		let longest = js_max(1.0, round((pass_seconds + tail) * sample_rate));
		if !(longest <= MAX_RENDER_FRAMES) {
			return Err(Error::new(format!(
				"the render is too long: {} frames, at most {} are allowed",
				number_to_string(longest),
				number_to_string(MAX_RENDER_FRAMES)
			)));
		}
		let frames = |seconds: f64| js_max(1.0, round(seconds * sample_rate)) as usize;
		Ok(RenderPlan {
			sample_rate,
			channels: channels as u32,
			tail,
			cycle_seconds,
			cycles,
			pass_seconds,
			pass_length: frames(pass_seconds),
			length: frames(pass_seconds + tail),
			seconds: options.seconds,
			wrap: options.wrap.unwrap_or(false),
			gated: options.gated.unwrap_or(true),
			seed: options.seed.clone().unwrap_or(Seed::Num(0.0)),
			master: options.master.unwrap_or_default(),
			booking_window: options.booking_window,
		})
	}

	/// How the engine's output is set up for this render: the destination widened for more than two channels,
	/// then the master bus (`createMasterBus`) unless it is off, and the seed.
	pub fn output_setup(&self) -> OutputSetup {
		OutputSetup {
			master: match self.master {
				MasterSetting::On => Some(MasterBusOptions::default()),
				MasterSetting::Off => None,
				MasterSetting::Tuned(options) => Some(MasterBusOptions {
					output: None,
					..options
				}),
			},
			multichannel: self.channels > 2,
			seed: self.seed.clone(),
		}
	}

	/// The voices the pattern gives over the render's cycles, in booking order: the onsets of each cycle in turn
	/// (onsets at or after `seconds` dropped), then sorted by start time with the nudge included, so a cut group
	/// chokes the voice that really played before.
	///
	/// # Errors
	///
	/// As [`collect_onsets`].
	pub fn collect_voices(&self, pattern: &Pattern<ControlMap>) -> Result<Vec<PendingVoice>> {
		let mut voices = Vec::new();
		let mut cycle = 0.0;
		while cycle < self.cycles {
			let span = Span::new(
				Fraction::from_int(cycle as i128),
				Fraction::from_int(cycle as i128 + 1),
			);
			for voice in collect_onsets(pattern, span, 0.0, self.cycle_seconds, self.gated)? {
				if self.seconds.is_none() || voice.start_time < self.pass_seconds {
					voices.push(voice);
				}
			}
			cycle += 1.0;
		}
		sort_booking_order(&mut voices);
		Ok(voices)
	}

	/// Makes the engine on `graph` and books the pattern on it, up front or in windows.
	///
	/// The graph must be made for this plan: `sample_rate`, `channels`, and (for a renderer) `length`. Without a
	/// booking window every voice is booked before the render starts and `pause` is never called. With one, the
	/// voices of the first two windows are booked before the render starts, and `pause` is called once for each
	/// later window, in time order, with the graph and the time to pause at in seconds (rounded down to a multiple
	/// of 128 frames, the render quantum); the window's voices are booked as soon as it returns. A renderer
	/// renders up to that time in `pause`; a recording graph sets its clock there.
	///
	/// A voice that fails to book fails the render with its message, and later voices are not booked. The graph
	/// keeps what was made before the failure. The engine has no samples, so a sample voice is skipped; use
	/// [`RenderPlan::book_pattern_with_samples`] to render a pattern that plays registered recordings.
	///
	/// # Errors
	///
	/// A master bus whose options are invalid ([`Engine::new`]), a pattern that fails to query
	/// ([`RenderPlan::collect_voices`]), a voice that fails to book ([`Engine::play`]), or `pause` failing.
	pub fn book_pattern<G: Graph>(
		&self,
		graph: G,
		pattern: &Pattern<ControlMap>,
		pause: impl FnMut(&mut G, f64) -> Result<()>,
	) -> Result<Engine<G>> {
		self.book_pattern_with_samples(graph, Samples::default(), pattern, pause)
	}

	/// As [`RenderPlan::book_pattern`], with the registered recordings sample voices play (the reference's
	/// `renderToBuffer` preloads the samples the pattern names on the render's context; here the host has
	/// already decoded them into `samples`). A voice that names a sample that is not registered is skipped and
	/// gives the engine's once-only warning ([`Engine::warnings`]).
	///
	/// # Errors
	///
	/// As [`RenderPlan::book_pattern`].
	pub fn book_pattern_with_samples<G: Graph>(
		&self,
		graph: G,
		samples: Samples,
		pattern: &Pattern<ControlMap>,
		mut pause: impl FnMut(&mut G, f64) -> Result<()>,
	) -> Result<Engine<G>> {
		let mut engine = Engine::new(graph, self.output_setup())?;
		*engine.samples_mut() = samples;
		let voices = self.collect_voices(pattern)?;
		let Some(window) = self.booking_window else {
			for voice in &voices {
				engine.play(&voice.params, voice.start_time)?;
			}
			return Ok(engine);
		};
		let quantum = RENDER_QUANTUM_FRAMES as f64;
		let last_pause = (self.length as f64 - 2.0 * quantum) / self.sample_rate;
		let sized = last_room_sizes(&voices, |params| engine.is_voice_skipped(params));
		for window in booking_windows(&sized, window, last_pause) {
			if window.suspend_at != 0.0 {
				let frame = ((window.suspend_at * self.sample_rate) / quantum).floor() * quantum;
				pause(engine.graph_mut(), frame / self.sample_rate)?;
			}
			for voice in &window.voices {
				engine.play(&voice.params, voice.start_time)?;
			}
		}
		Ok(engine)
	}

	/// The rendered channels as the render returns them: unchanged, or for `wrap` with a tail, folded onto the
	/// start ([`fold_tail`]) and held to the master `ceiling` when there is one ([`clamp_to_ceiling`]).
	pub fn finish(&self, rendered: Vec<Vec<f32>>) -> Vec<Vec<f32>> {
		if !self.wrap || self.tail <= 0.0 {
			return rendered;
		}
		let mut folded = fold_tail(&rendered, self.pass_length);
		if let MasterSetting::Tuned(MasterBusOptions {
			ceiling: Some(ceiling),
			..
		}) = self.master
		{
			clamp_to_ceiling(&mut folded, ceiling);
		}
		folded
	}
}

/// Adds the tail's samples onto the start of a copy one pass long, so a looped file has no gap at the seam
/// (`foldTail`). A buffer shorter than a pass is padded with silence.
///
/// ```
/// use undertone_engine::render::fold_tail;
/// let folded = fold_tail(&[vec![1.0, 2.0, 3.0, 4.0, 5.0]], 3);
/// assert_eq!(folded, [vec![5.0, 7.0, 3.0]]);
/// ```
pub fn fold_tail(rendered: &[Vec<f32>], pass_length: usize) -> Vec<Vec<f32>> {
	rendered
		.iter()
		.map(|source| {
			let mut target = vec![0.0_f32; pass_length];
			let head = source.len().min(pass_length);
			target[..head].copy_from_slice(&source[..head]);
			for (i, sample) in source.iter().enumerate().skip(pass_length) {
				target[(i - pass_length) % pass_length] += sample;
			}
			target
		})
		.collect()
}

/// Clamps every sample to the master ceiling in dBFS (`clampToCeiling`). The bus clips the tail and the start
/// separately, so once they are added the sum can pass the ceiling; this holds the buffer to it, to exactly what
/// the bus lets through ([`ceiling_top`]).
///
/// ```
/// use undertone_engine::render::clamp_to_ceiling;
/// let mut channels = vec![vec![0.9_f32, -0.9, 0.1]];
/// clamp_to_ceiling(&mut channels, -6.0206); // a ceiling of one half
/// assert!(channels[0][0] < 0.5001 && channels[0][1] > -0.5001);
/// assert_eq!(channels[0][2], 0.1);
/// ```
pub fn clamp_to_ceiling(channels: &mut [Vec<f32>], ceiling_db: f64) {
	let top = ceiling_top(js_pow(10.0, ceiling_db / 20.0));
	for channel in channels {
		for sample in channel {
			*sample = js_max(-top, js_min(top, f64::from(*sample))) as f32;
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::graph::LogGraph;
	use undertone_pattern::control::note;

	fn plan(options: RenderOptions) -> Result<RenderPlan> {
		RenderPlan::new(&options)
	}

	#[test]
	fn the_defaults_are_one_two_second_cycle_at_48000_hz() {
		let plan = plan(RenderOptions::default()).unwrap();
		assert_eq!(plan.sample_rate, 48_000.0);
		assert_eq!(plan.channels, 2);
		assert_eq!((plan.pass_length, plan.length), (96_000, 96_000));
		assert!(plan.gated && !plan.wrap);
		assert_eq!(plan.master, MasterSetting::On);
	}

	#[test]
	fn a_tempo_that_makes_the_cycle_count_unbounded_is_an_error() {
		let message = |options: RenderOptions| plan(options).unwrap_err().message().to_string();
		let infinite_cps = RenderOptions {
			cps: Some(f64::INFINITY),
			seconds: Some(1.0),
			..RenderOptions::default()
		};
		assert_eq!(message(infinite_cps), "cps must be finite, got Infinity");
		assert_eq!(
			message(RenderOptions {
				bpm: Some(f64::INFINITY),
				..RenderOptions::default()
			}),
			"bpm must be finite, got Infinity"
		);
		// A huge finite cps divides to an infinite cycle count.
		assert!(
			message(RenderOptions {
				cps: Some(1e300),
				seconds: Some(1e300),
				..RenderOptions::default()
			})
			.contains("too many cycles")
		);
		for cpm in [0.0, -1.0, f64::NAN, f64::INFINITY] {
			assert!(
				message(RenderOptions {
					default_cpm: Some(cpm),
					..RenderOptions::default()
				})
				.starts_with("default_cpm must be positive and finite")
			);
		}
	}

	#[test]
	fn absurd_lengths_and_rates_are_errors_not_loops_or_allocations() {
		let message = |options: RenderOptions| plan(options).unwrap_err().message().to_string();
		assert!(
			message(RenderOptions {
				cycles: Some(1e15),
				..RenderOptions::default()
			})
			.contains("too many cycles")
		);
		assert!(
			message(RenderOptions {
				cycles: Some(10_000.0),
				bpm: Some(1.0),
				..RenderOptions::default()
			})
			.contains("too long")
		);
		assert!(
			message(RenderOptions {
				tail: Some(1e12),
				..RenderOptions::default()
			})
			.contains("too long")
		);
		assert!(
			message(RenderOptions {
				sample_rate: Some(1e12),
				..RenderOptions::default()
			})
			.contains("sampleRate")
		);
		assert!(
			message(RenderOptions {
				seconds: Some(1e300),
				..RenderOptions::default()
			})
			.contains("too many cycles")
		);
	}

	#[test]
	fn seconds_round_up_to_whole_cycles_and_end_the_pass() {
		let plan = plan(RenderOptions {
			seconds: Some(3.0),
			sample_rate: Some(1000.0),
			tail: Some(0.5),
			..RenderOptions::default()
		})
		.unwrap();
		assert_eq!(plan.cycles, 2.0);
		assert_eq!((plan.pass_length, plan.length), (3000, 3500));
	}

	#[test]
	fn the_checks_give_the_references_messages_in_its_order() {
		let message = |options: RenderOptions| plan(options).unwrap_err().message().to_string();
		let base = RenderOptions::default();
		assert_eq!(
			message(RenderOptions {
				cycles: Some(1.0),
				seconds: Some(1.0),
				channels: Some(3.0),
				..base.clone()
			}),
			"Pass either cycles or seconds, not both"
		);
		assert_eq!(
			message(RenderOptions {
				channels: Some(3.0),
				sample_rate: Some(0.0),
				..base.clone()
			}),
			"channels must be 1, 2, 4, 6 or 8, got 3"
		);
		assert_eq!(
			message(RenderOptions {
				sample_rate: Some(-1.0),
				..base.clone()
			}),
			"sampleRate must be positive, got -1"
		);
		assert_eq!(
			message(RenderOptions {
				tail: Some(-0.5),
				..base.clone()
			}),
			"tail must be zero or more seconds, got -0.5"
		);
		assert_eq!(
			message(RenderOptions {
				booking_window: Some(0.0),
				..base.clone()
			}),
			"bookingWindow must be positive, got 0"
		);
		assert_eq!(
			message(RenderOptions {
				bpm: Some(0.0),
				..base.clone()
			}),
			"bpm must be positive, got 0"
		);
		assert_eq!(
			message(RenderOptions {
				cps: Some(-2.0),
				..base.clone()
			}),
			"cps must be positive, got -2"
		);
		assert_eq!(
			message(RenderOptions {
				seconds: Some(f64::NAN),
				..base.clone()
			}),
			"seconds must be positive, got NaN"
		);
		assert_eq!(
			message(RenderOptions {
				cycles: Some(1.5),
				..base
			}),
			"cycles must be a positive whole number, got 1.5"
		);
	}

	#[test]
	fn the_default_tempo_is_the_hosts_setcpm() {
		let plan = plan(RenderOptions {
			default_cpm: Some(30.0),
			..RenderOptions::default()
		})
		.unwrap();
		assert_eq!(plan.cycle_seconds, 2.0);
		assert_eq!(
			cycle_seconds_for(None, None, Some(15.0)).unwrap(),
			4.0,
			"the host's tempo replaces 120 bpm"
		);
	}

	#[test]
	fn onsets_at_or_after_seconds_are_dropped() {
		let pattern = note("c4 e4 g4 b4").unwrap();
		let plan = plan(RenderOptions {
			seconds: Some(1.0),
			..RenderOptions::default()
		})
		.unwrap();
		let voices = plan.collect_voices(&pattern).unwrap();
		assert_eq!(
			voices.iter().map(|v| v.start_time).collect::<Vec<_>>(),
			[0.0, 0.5]
		);
	}

	#[test]
	fn a_gated_voice_holds_for_its_share_of_the_cycle_and_a_one_shot_does_not() {
		let pattern = note("c4 e4").unwrap();
		let gated = RenderPlan::new(&RenderOptions::default())
			.unwrap()
			.collect_voices(&pattern)
			.unwrap();
		assert_eq!(gated[0].params.duration, Some(1.0));
		let ungated = RenderPlan::new(&RenderOptions {
			gated: Some(false),
			..RenderOptions::default()
		})
		.unwrap()
		.collect_voices(&pattern)
		.unwrap();
		assert_eq!(ungated[0].params.duration, None);
	}

	#[test]
	fn the_pauses_of_a_windowed_render_come_before_the_voices_they_book() {
		let pattern = note("c4 d4 e4 f4 g4 a4 b4 c5").unwrap();
		let plan = plan(RenderOptions {
			sample_rate: Some(1280.0),
			booking_window: Some(0.5),
			cycles: Some(2.0),
			..RenderOptions::default()
		})
		.unwrap();
		let mut pauses = Vec::new();
		let engine = plan
			.book_pattern(LogGraph::new(1280.0, 2), &pattern, |graph, at| {
				graph.set_current_time(at);
				pauses.push(at);
				Ok(())
			})
			.unwrap();
		assert_eq!(pauses, [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]);
		let record = engine.into_graph().finish(None);
		assert_eq!(
			record
				.nodes
				.iter()
				.filter(|n| n.kind == "oscillator")
				.count(),
			16
		);
	}

	#[test]
	fn a_wrapped_render_folds_the_tail_and_holds_the_ceiling() {
		let plan = plan(RenderOptions {
			sample_rate: Some(1000.0),
			tail: Some(0.002),
			wrap: Some(true),
			master: Some(MasterSetting::Tuned(MasterBusOptions {
				ceiling: Some(-6.0),
				..MasterBusOptions::default()
			})),
			cycles: Some(1.0),
			cps: Some(0.001),
			..RenderOptions::default()
		})
		.unwrap();
		assert_eq!((plan.pass_length, plan.length), (1_000_000, 1_000_002));
		let mut rendered = vec![0.0_f32; plan.length];
		rendered[0] = 0.4;
		rendered[plan.pass_length] = 0.4;
		let folded = plan.finish(vec![rendered]);
		assert_eq!(folded[0].len(), 1_000_000);
		// 0.4 + 0.4 is above the -6 dB ceiling (about 0.5012), so it is clamped.
		assert!(
			folded[0][0] > 0.5 && folded[0][0] < 0.5012,
			"{}",
			folded[0][0]
		);
	}

	#[test]
	fn a_render_without_wrap_returns_every_frame_untouched() {
		let plan = plan(RenderOptions {
			tail: Some(1.0),
			..RenderOptions::default()
		})
		.unwrap();
		let rendered = vec![vec![0.25_f32; 3]];
		assert_eq!(plan.finish(rendered.clone()), rendered);
	}
}
