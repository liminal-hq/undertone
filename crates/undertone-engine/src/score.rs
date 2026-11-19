// A tick-based score: explicitly timed events compiled to a sample-accurate looping pattern
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Score`], the port of `score()` in `src/score.ts`.
//!
//! A pattern is built on a grid of equal steps. Music played in by hand is not, and quantising it loses much of
//! the feel. A score takes events at whole **ticks** (at any rate you choose, such as AdLib's 560 a second) and
//! compiles them to a pattern that keeps every event exactly where you put it. Pattern time stays in exact
//! fractions of the cue (`tick / length_ticks`), so repeats land on the audio clock without drift, and the rest
//! after the last note is part of the loop. Events are not snapped to any grid, so repeated notes 73, 75, 75, and
//! 221 ticks apart stay that way.
//!
//! The score's tempo is its own: [`Score::cps`] is `ticks_per_second / length_ticks`, one cycle being one pass of
//! the cue. [`Score::pattern`] is the same events as an ordinary pattern, which plays at whatever tempo it is
//! given, so use [`Score::cps`] with it (a cycle lasts 240 / `bpm` seconds, so a pattern that is not played at the
//! score's own tempo puts every tick at the wrong time while a `gate` stays in seconds).
//!
//! What the reference's `loop()`, `play()`, and `render()` do, in Rust terms:
//!
//! - [`Score::play`] books one pass on an [`Engine`] at the score's tempo.
//! - [`Score::schedule`] books any span of the looping cue: the step the reference's `loop()` takes at each tick
//!   of its timer, where the exact seam is that cycle times are rational. The timer belongs to the host.
//! - [`Score::render_plan`] and [`Score::book_render`] plan and book one pass for an offline render at the
//!   score's tempo (add a `tail` to let releases ring out, or `wrap` it for a seamless loop).
//!
//! ```
//! use undertone_engine::engine::{Engine, OutputSetup};
//! use undertone_engine::graph::LogGraph;
//! use undertone_engine::score::{Score, ScoreDefinition, ScoreEvent, ScoreNote};
//!
//! // Two notes in a two-second cue at 560 ticks a second; the second is one tick before the loop point.
//! let cue = Score::new(&ScoreDefinition {
//!     ticks_per_second: 560.0,
//!     length_ticks: 1120.0,
//!     events: vec![
//!         ScoreEvent { gate: Some(100.0), ..ScoreEvent::note(0.0, ScoreNote::Name("e4".into())) },
//!         ScoreEvent { gate: Some(100.0), ..ScoreEvent::midi(1119.0, 69.0) },
//!     ],
//!     ..ScoreDefinition::default()
//! })?;
//! assert_eq!(cue.cps(), 0.5);
//! assert_eq!(cue.seconds(), 2.0);
//!
//! let mut engine = Engine::new(LogGraph::new(44_100.0, 2), OutputSetup::default())?;
//! let playbacks = cue.play(&mut engine, Default::default())?;
//! assert_eq!(playbacks.len(), 2);
//! // The seam is a tick later than the second note: its gate is cut at the loop point, one tick long.
//! assert!((playbacks[1].start_time - 1119.0 / 560.0).abs() < 1e-12);
//! # Ok::<(), undertone_pattern::Error>(())
//! ```

use crate::engine::{Engine, Playback};
use crate::graph::{Graph, NodeId};
use crate::math::{js_max, js_min};
use crate::render::{RenderOptions, RenderPlan, schedule_span};
use std::collections::BTreeMap;
use std::sync::Arc;
use undertone_pattern::js::{is_integer, number_to_string};
use undertone_pattern::pitch::midi_to_frequency;
use undertone_pattern::{ControlMap, Error, Fraction, Hap, Pattern, Result, Span, Value};

/// The autopan waves a score event may name.
const AUTOPAN_SHAPES: [&str; 3] = ["sine", "triangle", "square"];

/// The pitch of a score event: a note name or a frequency in hertz.
#[derive(Debug, Clone, PartialEq)]
pub enum ScoreNote {
	/// A note name such as `"e4"`.
	Name(String),
	/// A frequency in hertz.
	Hz(f64),
}

/// One point of a score event's `panPath`: a stereo position some ticks after the onset.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScorePanPoint {
	/// Whole ticks from the event's onset (0 is the onset itself).
	pub tick: f64,
	/// Stereo position, -1 to 1; clamped.
	pub pan: f64,
}

/// A score event's autopan, in ticks like the event's other fields.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreAutopan {
	/// Ticks per LFO cycle, a whole number of at least 1.
	pub period_ticks: f64,
	/// Swing either side of the note's pan, 0 to 1.
	pub depth: f64,
	/// The LFO's wave: `"sine"` (the default), `"triangle"`, or `"square"`.
	pub shape: Option<String>,
	/// Where in its cycle the LFO starts, 0 to 1. Default 0.
	pub phase: Option<f64>,
}

/// One note in a score. Times are whole ticks, so they stay exact. Every number is an `f64` as in the reference,
/// so that a value it rejects (a half tick) is rejected here with the same message.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScoreEvent {
	/// Onset, in ticks from the start of the cue (0 up to but not including `length_ticks`).
	pub tick: f64,
	/// Pitch as a note name or Hz; or give `midi` instead.
	pub note: Option<ScoreNote>,
	/// MIDI note number, as an alternative to `note`.
	pub midi: Option<f64>,
	/// Key-down length in ticks (default 1). The instrument's release rings on after it.
	pub gate: Option<f64>,
	/// Strength, as the `velocity` control.
	pub level: Option<f64>,
	/// Stereo position, -1 to 1.
	pub pan: Option<f64>,
	/// Pan automation inside the note, in ticks from the onset, in order. The first point is the pan at the onset
	/// (replacing `pan`); the pan moves linearly from each point to the next, jumps when two points share a tick,
	/// and holds the last value, through the release too.
	pub pan_path: Option<Vec<ScorePanPoint>>,
	/// An autopan LFO on this note: one cycle every `period_ticks`, swinging `depth` either side of the note's pan.
	/// Carried into the `autopan` voice controls in hertz.
	pub autopan: Option<ScoreAutopan>,
	/// Any further voice controls for this one note, such as an instrument from `fm_voice`: a map value.
	pub voice: Option<Value>,
}

impl ScoreEvent {
	/// An event at `tick` with a pitch given as a note name or Hz, and nothing else set.
	pub fn note(tick: f64, note: ScoreNote) -> ScoreEvent {
		ScoreEvent {
			tick,
			note: Some(note),
			..ScoreEvent::default()
		}
	}

	/// An event at `tick` with a MIDI note number, and nothing else set.
	pub fn midi(tick: f64, midi: f64) -> ScoreEvent {
		ScoreEvent {
			tick,
			midi: Some(midi),
			..ScoreEvent::default()
		}
	}
}

/// What happens to a note still held when the cue loops.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Seam {
	/// Closes the note's gate at the seam, as classic chip music does (the default). The instrument's release
	/// rings on.
	#[default]
	Cut,
	/// Lets the gate run on past the seam. Either way the instrument's release rings on.
	Ring,
}

/// A score: the tick rate, the length of the cue, and its events (`ScoreDefinition`).
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreDefinition {
	/// Tick rate in ticks per second, for example 560 for AdLib IMF data.
	pub ticks_per_second: f64,
	/// Length of one pass of the cue in ticks, *including* any rest at the end. This is the loop length.
	pub length_ticks: f64,
	/// The notes.
	pub events: Vec<ScoreEvent>,
	/// What happens to a note still held when the cue loops. Default [`Seam::Cut`].
	pub seam: Option<Seam>,
	/// Pan law for every event, in dB at the centre (-6 to 0), as the `panLaw` voice control; an event whose
	/// `voice` sets its own `panLaw` keeps it. Default: the stereo panner's -3 dB. Events with no pan are
	/// unaffected.
	pub pan_law: Option<f64>,
}

impl Default for ScoreDefinition {
	/// A one-second cue at one tick a second with no events: a starting point to set fields on.
	fn default() -> Self {
		ScoreDefinition {
			ticks_per_second: 1.0,
			length_ticks: 1.0,
			events: Vec::new(),
			seam: None,
			pan_law: None,
		}
	}
}

/// What [`Score::play`] is asked: where to start and where to send the voices.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PlayOptions {
	/// Absolute start time on the graph's clock. Default: the graph's clock now.
	pub when: Option<f64>,
	/// Hold each event's envelope for its own share of the cycle, like a loop, to preview what one looped cycle
	/// sounds like. Default false: envelopes stay percussive, which game sound effects want.
	pub gated: bool,
	/// Where the voices go. Default the engine's output.
	pub output: Option<NodeId>,
}

/// An event after its checks: the extent in cue time and the voice controls it books.
#[derive(Debug)]
struct Compiled {
	begin: Fraction,
	end: Fraction,
	value: Value,
}

/// A compiled score: a one-cycle pattern, the tempo that makes one cycle equal one pass, and the means to
/// play it.
#[derive(Debug, Clone)]
pub struct Score {
	pattern: Pattern<ControlMap>,
	cps: f64,
	seconds: f64,
}

/// `score() ${label} must be an integer of at least ${min}, got ${value}` unless it is.
fn require_integer(value: f64, label: &str, min: f64) -> Result<()> {
	if !is_integer(value) || value < min {
		return Err(Error::new(format!(
			"score() {label} must be an integer of at least {}, got {}",
			number_to_string(min),
			number_to_string(value)
		)));
	}
	Ok(())
}

/// A pan point as the `{ time, pan }` map the `panPath` control holds.
fn point_value(time: f64, pan: f64) -> Value {
	let mut map = BTreeMap::new();
	map.insert("pan".to_string(), Value::Num(pan));
	map.insert("time".to_string(), Value::Num(time));
	Value::Map(map)
}

/// A score event's pan path in seconds from its onset, checked: whole ticks that never go backwards, finite pans.
fn compile_pan_path(points: &[ScorePanPoint], onset: f64, ticks_per_second: f64) -> Result<Value> {
	let mut previous = 0.0;
	let mut compiled = Vec::with_capacity(points.len());
	for point in points {
		require_integer(point.tick, "panPath tick", 0.0)?;
		if point.tick < previous {
			return Err(Error::new(format!(
				"score() panPath ticks must not go backwards, got {} after {} (event at tick {})",
				number_to_string(point.tick),
				number_to_string(previous),
				number_to_string(onset)
			)));
		}
		if !point.pan.is_finite() {
			return Err(Error::new(format!(
				"score() panPath pan must be a number, got {} (event at tick {})",
				number_to_string(point.pan),
				number_to_string(onset)
			)));
		}
		previous = point.tick;
		compiled.push(point_value(
			point.tick / ticks_per_second,
			js_max(-1.0, js_min(1.0, point.pan)),
		));
	}
	Ok(Value::List(compiled))
}

/// A score event's autopan as voice controls, checked: a whole-tick period, a depth and phase in 0..1, a known
/// shape. The controls are `autopan` in hertz, `autopanDepth`, and when given `autopanShape` and `autopanPhase`.
fn compile_autopan(
	autopan: &ScoreAutopan,
	onset: f64,
	ticks_per_second: f64,
) -> Result<[(&'static str, Value); 4]> {
	require_integer(autopan.period_ticks, "autopan periodTicks", 1.0)?;
	let event = || number_to_string(onset);
	if !(0.0..=1.0).contains(&autopan.depth) {
		return Err(Error::new(format!(
			"score() autopan depth must be between 0 and 1, got {} (event at tick {})",
			number_to_string(autopan.depth),
			event()
		)));
	}
	if let Some(shape) = &autopan.shape
		&& !AUTOPAN_SHAPES.contains(&shape.as_str())
	{
		return Err(Error::new(format!(
			"score() autopan shape must be sine, triangle or square, got {shape} (event at tick {})",
			event()
		)));
	}
	if let Some(phase) = autopan.phase
		&& !(0.0..=1.0).contains(&phase)
	{
		return Err(Error::new(format!(
			"score() autopan phase must be between 0 and 1, got {} (event at tick {})",
			number_to_string(phase),
			event()
		)));
	}
	Ok([
		(
			"autopan",
			Value::Num(ticks_per_second / autopan.period_ticks),
		),
		("autopanDepth", Value::Num(autopan.depth)),
		(
			"autopanShape",
			autopan.shape.clone().map_or(Value::Undefined, Value::Str),
		),
		(
			"autopanPhase",
			autopan.phase.map_or(Value::Undefined, Value::Num),
		),
	])
}

impl Score {
	/// Compiles explicitly timed events into a looping pattern.
	///
	/// # Errors
	///
	/// Fails with the reference's message, checking the definition first (`ticks_per_second` positive,
	/// `length_ticks` a whole number of at least 1, `pan_law` from -6 to 0), then each event in order: the tick a
	/// whole number inside the cue, the gate a whole number of at least 1, a `note` or `midi`, a valid `autopan`,
	/// and a valid `pan_path`.
	#[allow(clippy::neg_cmp_op_on_partial_ord)]
	pub fn new(definition: &ScoreDefinition) -> Result<Score> {
		let ticks_per_second = definition.ticks_per_second;
		let length_ticks = definition.length_ticks;
		if !(ticks_per_second > 0.0) {
			return Err(Error::new(format!(
				"score() ticksPerSecond must be positive, got {}",
				number_to_string(ticks_per_second)
			)));
		}
		require_integer(length_ticks, "lengthTicks", 1.0)?;
		let seam = definition.seam.unwrap_or_default();
		let pan_law = definition.pan_law;
		if let Some(db) = pan_law
			&& !(-6.0..=0.0).contains(&db)
		{
			return Err(Error::new(format!(
				"score() panLaw must be between -6 and 0 dB, got {}",
				number_to_string(db)
			)));
		}

		let mut compiled = Vec::with_capacity(definition.events.len());
		for event in &definition.events {
			require_integer(event.tick, "event tick", 0.0)?;
			if event.tick >= length_ticks {
				return Err(Error::new(format!(
					"score() event tick {} is outside the cue (length {})",
					number_to_string(event.tick),
					number_to_string(length_ticks)
				)));
			}
			let gate = event.gate.unwrap_or(1.0);
			require_integer(gate, "event gate", 1.0)?;
			if event.note.is_none() && event.midi.is_none() {
				return Err(Error::new(format!(
					"score() event at tick {} needs a note or midi",
					number_to_string(event.tick)
				)));
			}

			// The gate in seconds is what holds the envelope; 'cut' stops it at the seam.
			let gate_ticks = match seam {
				Seam::Cut => js_min(gate, length_ticks - event.tick),
				Seam::Ring => gate,
			};
			let mut map = match &event.voice {
				Some(Value::Map(voice)) => voice.clone(),
				_ => BTreeMap::new(),
			};
			let pitch = match (&event.note, event.midi) {
				(Some(ScoreNote::Name(name)), _) => Value::Str(name.clone()),
				(Some(ScoreNote::Hz(hz)), _) => Value::Num(*hz),
				(None, midi) => Value::Num(midi_to_frequency(midi.unwrap_or(f64::NAN))),
			};
			map.insert("pitch".into(), pitch);
			map.insert("duration".into(), Value::Num(gate_ticks / ticks_per_second));
			if let Some(db) = pan_law
				&& !matches!(map.get("panLaw"), Some(value) if *value != Value::Undefined)
			{
				map.insert("panLaw".into(), Value::Num(db));
			}
			if let Some(autopan) = &event.autopan {
				for (key, value) in compile_autopan(autopan, event.tick, ticks_per_second)? {
					if value != Value::Undefined {
						map.insert(key.into(), value);
					}
				}
			}
			if let Some(level) = event.level {
				map.insert("velocity".into(), Value::Num(level));
			}
			if let Some(pan) = event.pan {
				map.insert("pan".into(), Value::Num(pan));
			}
			if let Some(points) = &event.pan_path
				&& !points.is_empty()
			{
				map.insert(
					"panPath".into(),
					compile_pan_path(points, event.tick, ticks_per_second)?,
				);
			}

			compiled.push(Compiled {
				begin: Fraction::new(event.tick as i128, length_ticks as i128),
				// The event's own extent in pattern time; the gate itself is carried by `duration`.
				end: Fraction::new((event.tick + gate_ticks) as i128, length_ticks as i128),
				value: Value::Map(map),
			});
		}
		compiled.sort_by_key(|event| event.begin);

		let events = Arc::new(compiled);
		let pattern = Pattern::from_fn(move |span: Span, out: &mut Vec<Hap<Value>>| {
			let mut cycle = span.begin.floor();
			while Fraction::from_int(cycle) < span.end {
				let offset = Fraction::from_int(cycle);
				for event in events.iter() {
					let whole = Span::new(offset + event.begin, offset + event.end);
					let begin = whole.begin.max(span.begin);
					let end = whole.end.min(span.end);
					if begin < end {
						out.push(Hap {
							whole: Some(whole),
							part: Span::new(begin, end),
							value: event.value.clone(),
						});
					}
				}
				cycle += 1;
			}
		});
		Ok(Score {
			pattern,
			cps: ticks_per_second / length_ticks,
			seconds: length_ticks / ticks_per_second,
		})
	}

	/// The events as a pattern: one cycle is exactly `length_ticks` ticks.
	pub fn pattern(&self) -> &Pattern<ControlMap> {
		&self.pattern
	}

	/// The `cps` that plays [`Score::pattern`] at the score's own tick rate.
	pub fn cps(&self) -> f64 {
		self.cps
	}

	/// The cue's length in seconds.
	pub fn seconds(&self) -> f64 {
		self.seconds
	}

	/// Books one pass of the cue on the engine at the score's own tempo (`.play()`). Envelopes are percussive
	/// unless [`PlayOptions::gated`].
	///
	/// # Errors
	///
	/// As [`schedule_span`].
	pub fn play<G: Graph>(
		&self,
		engine: &mut Engine<G>,
		options: PlayOptions,
	) -> Result<Vec<Playback>> {
		let start = options
			.when
			.unwrap_or_else(|| engine.graph().current_time());
		schedule_span(
			engine,
			&self.pattern,
			Span::new(Fraction::from_int(0), Fraction::from_int(1)),
			start,
			1.0 / self.cps,
			options.gated,
			options.output,
		)
	}

	/// Books the voices of a span of the looping cue, `start_time` being where cycle 0 starts on the graph's
	/// clock (the step of `.loop()` at each tick). Envelopes are gated, as in a loop; `output` is where the voices go
	/// (the engine's output when `None`). Because cue times are rational, spans that meet book every note once
	/// and none twice, and the seam between passes is exact.
	///
	/// # Errors
	///
	/// As [`schedule_span`].
	pub fn schedule<G: Graph>(
		&self,
		engine: &mut Engine<G>,
		span: Span,
		start_time: f64,
		output: Option<NodeId>,
	) -> Result<Vec<Playback>> {
		schedule_span(
			engine,
			&self.pattern,
			span,
			start_time,
			1.0 / self.cps,
			true,
			output,
		)
	}

	/// The offline render plan for one pass of the cue (`.render()`): the options with the score's tempo, so that
	/// `bpm`, `cps`, and `seconds` should be left out (giving `bpm` fails, as in the reference, with "Pass either
	/// bpm or cps, not both"). Add a `tail` to let releases ring out, or `wrap` it for a seamless loop.
	///
	/// # Errors
	///
	/// As [`RenderPlan::new`].
	pub fn render_plan(&self, options: &RenderOptions) -> Result<RenderPlan> {
		RenderPlan::new(&RenderOptions {
			cps: Some(self.cps),
			..options.clone()
		})
	}

	/// Plans the offline render ([`Score::render_plan`]) and books the cue on `graph` ([`RenderPlan::book_pattern`]).
	///
	/// # Errors
	///
	/// As [`RenderPlan::new`] and [`RenderPlan::book_pattern`].
	pub fn book_render<G: Graph>(
		&self,
		graph: impl FnOnce(&RenderPlan) -> G,
		options: &RenderOptions,
		pause: impl FnMut(&mut G, f64) -> Result<()>,
	) -> Result<Engine<G>> {
		let plan = self.render_plan(options)?;
		plan.book_pattern(graph(&plan), &self.pattern, pause)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn definition(events: Vec<ScoreEvent>) -> ScoreDefinition {
		ScoreDefinition {
			ticks_per_second: 560.0,
			length_ticks: 1120.0,
			events,
			..ScoreDefinition::default()
		}
	}

	fn first_cycle(cue: &Score) -> Vec<Hap<Value>> {
		cue.pattern()
			.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)))
	}

	#[test]
	fn events_are_exact_fractions_of_the_cue_in_onset_order() {
		let cue = Score::new(&definition(vec![
			ScoreEvent::midi(560.0, 60.0),
			ScoreEvent::note(73.0, ScoreNote::Name("c4".into())),
		]))
		.unwrap();
		let haps = first_cycle(&cue);
		assert_eq!(haps.len(), 2);
		assert_eq!(haps[0].whole.unwrap().begin, Fraction::new(73, 1120));
		assert_eq!(haps[1].whole.unwrap().begin, Fraction::new(1, 2));
		assert_eq!(
			haps[1].value.get("duration"),
			Some(&Value::Num(1.0 / 560.0))
		);
	}

	#[test]
	fn a_note_held_at_the_seam_is_cut_there_by_default_and_rings_on_request() {
		let held = ScoreEvent {
			gate: Some(400.0),
			..ScoreEvent::midi(1000.0, 60.0)
		};
		let cut = Score::new(&definition(vec![held.clone()])).unwrap();
		assert_eq!(
			first_cycle(&cut)[0].value.get("duration"),
			Some(&Value::Num(120.0 / 560.0))
		);
		let ring = Score::new(&ScoreDefinition {
			seam: Some(Seam::Ring),
			..definition(vec![held])
		})
		.unwrap();
		assert_eq!(
			first_cycle(&ring)[0].value.get("duration"),
			Some(&Value::Num(400.0 / 560.0))
		);
	}

	#[test]
	fn the_pan_law_is_given_to_events_unless_they_set_their_own() {
		let mut own = BTreeMap::new();
		own.insert("panLaw".to_string(), Value::Num(-1.5));
		let cue = Score::new(&ScoreDefinition {
			pan_law: Some(-6.0),
			..definition(vec![
				ScoreEvent::midi(0.0, 60.0),
				ScoreEvent {
					voice: Some(Value::Map(own)),
					..ScoreEvent::midi(10.0, 60.0)
				},
			])
		})
		.unwrap();
		let haps = first_cycle(&cue);
		assert_eq!(haps[0].value.get("panLaw"), Some(&Value::Num(-6.0)));
		assert_eq!(haps[1].value.get("panLaw"), Some(&Value::Num(-1.5)));
	}

	#[test]
	fn an_autopan_period_in_ticks_becomes_hertz() {
		let cue = Score::new(&definition(vec![ScoreEvent {
			autopan: Some(ScoreAutopan {
				period_ticks: 280.0,
				depth: 0.5,
				shape: None,
				phase: Some(0.25),
			}),
			..ScoreEvent::midi(0.0, 60.0)
		}]))
		.unwrap();
		let value = &first_cycle(&cue)[0].value;
		assert_eq!(value.get("autopan"), Some(&Value::Num(2.0)));
		assert_eq!(value.get("autopanPhase"), Some(&Value::Num(0.25)));
		assert_eq!(value.get("autopanShape"), None);
	}

	#[test]
	fn a_pan_path_in_ticks_becomes_seconds_and_is_clamped() {
		let cue = Score::new(&definition(vec![ScoreEvent {
			pan_path: Some(vec![
				ScorePanPoint {
					tick: 0.0,
					pan: -3.0,
				},
				ScorePanPoint {
					tick: 280.0,
					pan: 0.5,
				},
			]),
			..ScoreEvent::midi(0.0, 60.0)
		}]))
		.unwrap();
		let value = &first_cycle(&cue)[0].value;
		let Some(Value::List(points)) = value.get("panPath") else {
			panic!("a pan path");
		};
		assert_eq!(points[0].get("pan"), Some(&Value::Num(-1.0)));
		assert_eq!(points[1].get("time"), Some(&Value::Num(0.5)));
	}

	#[test]
	fn the_pattern_repeats_every_cycle_and_splits_at_a_query_edge() {
		let cue = Score::new(&definition(vec![ScoreEvent {
			gate: Some(100.0),
			..ScoreEvent::midi(100.0, 60.0)
		}]))
		.unwrap();
		let half = Fraction::new(15, 112);
		let haps = cue.pattern().query(Span::new(half, Fraction::new(3, 2)));
		assert_eq!(haps.len(), 2);
		// The first note is queried from part way through: a fragment, not an onset.
		assert!(haps[0].whole.unwrap().begin < haps[0].part.begin);
		assert_eq!(haps[1].whole.unwrap().begin, Fraction::new(61, 56));
	}

	fn engine() -> Engine<crate::graph::LogGraph> {
		Engine::new(
			crate::graph::LogGraph::new(44_100.0, 2),
			crate::engine::OutputSetup::default(),
		)
		.unwrap()
	}

	#[test]
	fn play_books_one_pass_at_the_scores_tempo_from_when() {
		let cue = Score::new(&definition(vec![
			ScoreEvent::midi(0.0, 60.0),
			ScoreEvent::midi(560.0, 62.0),
		]))
		.unwrap();
		let mut engine = engine();
		let playbacks = cue
			.play(
				&mut engine,
				PlayOptions {
					when: Some(10.0),
					..PlayOptions::default()
				},
			)
			.unwrap();
		assert_eq!(playbacks[0].start_time, 10.0);
		assert_eq!(playbacks[1].start_time, 11.0);
		// A one-shot's envelope stays percussive: the gate's duration is not given to it.
		let record = engine.into_graph().finish(None);
		assert_eq!(
			record
				.nodes
				.iter()
				.filter(|n| n.kind == "oscillator")
				.count(),
			2
		);
	}

	#[test]
	fn spans_that_meet_book_every_note_once_across_the_seam() {
		let cue = Score::new(&definition(vec![
			ScoreEvent::midi(0.0, 60.0),
			ScoreEvent::midi(560.0, 62.0),
		]))
		.unwrap();
		let mut engine = engine();
		let mut starts = Vec::new();
		let mut begin = Fraction::from_int(0);
		for end in [
			Fraction::new(1, 3),
			Fraction::new(5, 4),
			Fraction::new(5, 2),
		] {
			let span = Span::new(begin, end);
			for playback in cue.schedule(&mut engine, span, 0.0, None).unwrap() {
				starts.push(playback.start_time);
			}
			begin = end;
		}
		// Cycles last two seconds: notes at 0, 1, 2, 3, and 4 (the last cycle's first note).
		assert_eq!(starts, [0.0, 1.0, 2.0, 3.0, 4.0]);
	}

	#[test]
	fn a_render_uses_the_scores_tempo_and_a_second_tempo_is_refused() {
		let cue = Score::new(&definition(vec![ScoreEvent::midi(0.0, 60.0)])).unwrap();
		let plan = cue.render_plan(&RenderOptions::default()).unwrap();
		assert_eq!(plan.cycle_seconds, 2.0);
		assert_eq!(plan.pass_length, 96_000);
		assert_eq!(
			cue.render_plan(&RenderOptions {
				bpm: Some(120.0),
				..RenderOptions::default()
			})
			.unwrap_err()
			.message(),
			"Pass either bpm or cps, not both"
		);
	}

	#[test]
	fn messages_name_the_event() {
		let error = |event: ScoreEvent| {
			Score::new(&definition(vec![event]))
				.unwrap_err()
				.message()
				.to_string()
		};
		assert_eq!(
			error(ScoreEvent {
				tick: 3.0,
				..ScoreEvent::default()
			}),
			"score() event at tick 3 needs a note or midi"
		);
		assert_eq!(
			error(ScoreEvent::midi(1120.0, 60.0)),
			"score() event tick 1120 is outside the cue (length 1120)"
		);
	}
}
