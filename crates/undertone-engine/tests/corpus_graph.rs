// Runs the layer 3 conformance corpus: voices and renders booked on a graph, compared with the recorded graph
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Layer 3 of the corpus: each case is a `score` (one voice per line, `v<k> @<seconds> <patch json>`) and the
//! `graph` the TypeScript reference recorded for it. Cases of a `voices` kind also carry an `output` setup, and
//! cases of a `render` kind a `program` and its `render` options.
//!
//! **The runner is group-agnostic**: it lists `conformance/cases/3/`, so a new group is picked up without a
//! change here. Each case is parsed into a [`Case`] and booked through [`book`].
//!
//! **What is pending.** A case is booked through [`book`]: the recorder's call sequence (the destination set
//! up, the master bus, then each voice in order) on a [`LogGraph`]. Cases that are not equal are named in
//! [`PENDING_CASES`] with the reason. The test fails
//! if a pending case starts to equal the corpus (so its entry is removed), and for any other case that does
//! not equal it.
//!
//! **How a booked graph is compared (CONFORMANCE.md).** Both sides are read as JSON and are exact: structure,
//! strings, counts, times, and the sign of a zero. The one exception is the absolute floor of `1e-15` for
//! numerical zeros, and it applies only to wave coefficients (`waves[].real` and `.imag`) and to the value
//! of a gain parameter's automation call. Cases that pass only through the floor are listed.
//!
//! Two further tests keep the writer honest without any booking: a graph built by hand through the [`Graph`]
//! trait for `placement-pan-default` must write the corpus bytes, and every recorded graph that can be remade (no
//! buffers, or only the samples a case registers) is replayed through the trait and must write itself back byte
//! for byte, buffer summaries included. A case with a `registry` registers the same PCM before booking.

#[allow(dead_code)]
#[path = "../../undertone-pattern/tests/common/mod.rs"]
mod common;

use common::interpret::{Failure, interpret};
use common::json;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::{
	Automation, ChannelCountMode, ChannelInterpretation, FilterType, Graph, GraphRecord, LogGraph,
	NodeId, NodeKind, OscillatorType, Oversample, ParamKind, Target,
};
use undertone_engine::instruments::{FmVoiceDefinition, LayerOptions, fm_voice, layer};
use undertone_engine::master::{Limiter, LimiterOptions, MasterBusOptions};
use undertone_engine::params::{Pitch, resolve_params};
use undertone_engine::render::{MasterSetting, RenderOptions, RenderPlan};
use undertone_engine::samples::{SampleData, Samples};
use undertone_engine::score::{
	Score, ScoreAutopan, ScoreDefinition, ScoreEvent, ScoreNote, ScorePanPoint, Seam,
};
use undertone_engine::surround::create_mono_fold;
use undertone_engine::window::{PendingVoice, check_booking_window};
use undertone_pattern::Value as PatternValue;
use undertone_pattern::control::note;
use undertone_pattern::random::Seed;

/// Cases the booking does not equal yet, by id, each with the precise reason. A case listed here must differ
/// from the corpus (the test fails when it starts to pass, so the entry is removed); a case not listed must be
/// equal.
const PENDING_CASES: &[(&str, &str)] = &[];

/// The reason a case is pending, if it is.
fn pending_reason(case: &Case) -> Option<&'static str> {
	PENDING_CASES
		.iter()
		.find(|(id, _)| *id == case.id)
		.map(|(_, reason)| *reason)
}

/// The absolute floor for a number that should be zero.
const ABS_FLOOR: f64 = 1e-15;

/// One voice of a score.
#[derive(Debug)]
struct ScoreLine {
	at: f64,
	patch: Value,
}

/// One layer 3 case, with the parts the booking needs.
#[derive(Debug)]
struct Case {
	id: String,
	score: Vec<ScoreLine>,
	/// `output` of a voices case: the master bus and the channel count.
	output: Option<Value>,
	/// `program` of a render case.
	program: Option<Value>,
	/// `definition` of a score case.
	definition: Option<Value>,
	/// The `render` options of a render or score case.
	render: Option<Value>,
	/// The score's own `cps` and `seconds`, which a score case records.
	tempo: Option<(f64, f64)>,
	/// The decoded samples to register, each with the voice index it is registered before.
	registry: Vec<(usize, String, SampleData, Option<Pitch>)>,
	/// The voice indices the registry is cleared before.
	clear_before: Vec<usize>,
	/// The recorded graph, or the message a case that must fail gives.
	expected: Expected,
}

/// What a case records: a graph, or the error message of a booking that throws.
#[derive(Debug)]
enum Expected {
	Graph(Value),
	Error(String),
}

/// What booking a case gave.
enum Booked {
	NotImplemented,
	Graph(Box<GraphRecord>),
	Error(String),
}

/// Turns a recorded JSON value into a pattern [`Value`], reading the recorder's `{"$num": ...}` form for the
/// numbers JSON cannot hold.
fn to_value(json: &Value) -> PatternValue {
	match json {
		Value::Number(n) => PatternValue::Num(n.as_f64().expect("f64")),
		Value::String(s) => PatternValue::Str(s.clone()),
		Value::Bool(b) => PatternValue::Bool(*b),
		Value::Array(items) => PatternValue::List(items.iter().map(to_value).collect()),
		Value::Object(map) => match map.get("$num").and_then(Value::as_str) {
			Some("NaN") => PatternValue::Num(f64::NAN),
			Some("Infinity") => PatternValue::Num(f64::INFINITY),
			Some("-Infinity") => PatternValue::Num(f64::NEG_INFINITY),
			Some("-0") => PatternValue::Num(-0.0),
			Some(other) => panic!("special number {other}"),
			None => PatternValue::Map(
				map.iter()
					.map(|(key, value)| (key.clone(), to_value(value)))
					.collect(),
			),
		},
		Value::Null => PatternValue::Undefined,
	}
}

/// `output.master` of a case as the master bus options (`true` or an object).
fn master_options(master: &Value) -> MasterBusOptions {
	let Some(object) = master.as_object() else {
		return MasterBusOptions::default();
	};
	let number = |key: &str| {
		object
			.get(key)
			.map(|v| to_value(v).as_number().expect("number"))
	};
	let limiter = match object.get("limiter") {
		None | Some(Value::Bool(true)) => Limiter::Default,
		Some(Value::Bool(false)) => Limiter::Off,
		Some(Value::Object(tuned)) => {
			let field = |key: &str| tuned.get(key).and_then(Value::as_f64);
			Limiter::Tuned(LimiterOptions {
				threshold: field("threshold"),
				knee: field("knee"),
				ratio: field("ratio"),
				attack: field("attack"),
				release: field("release"),
				compensate: tuned.get("compensate").and_then(Value::as_bool),
			})
		}
		Some(other) => panic!("limiter {other}"),
	};
	MasterBusOptions {
		output: None,
		gain: number("gain"),
		limiter,
		ceiling: number("ceiling"),
	}
}

/// The voices of a score, as the pending voices a render books.
fn pending_voices(case: &Case) -> Vec<PendingVoice> {
	case.score
		.iter()
		.map(|line| PendingVoice {
			start_time: line.at,
			params: resolve_params(&to_value(&line.patch)),
		})
		.collect()
}

/// Books a `voices` case on a [`LogGraph`], as the recorder does: the destination is set up first, then the
/// master bus, then every voice of the score in order.
fn book_voices(case: &Case) -> Booked {
	let output_field = |key: &str| case.output.as_ref().and_then(|output| output.get(key));
	let channels = output_field("channels")
		.and_then(Value::as_u64)
		.map_or(2, |count| count as u32);
	// The hardware maximum defaults to the destination's count, and `enableMultichannel` is called when the
	// destination is wider than stereo unless the case says otherwise.
	let max_channels = output_field("maxChannels")
		.and_then(Value::as_u64)
		.map_or(channels, |count| count as u32);
	let multichannel = output_field("multichannel")
		.and_then(Value::as_bool)
		.unwrap_or(channels > 2);
	let mono_fold = output_field("monoFold").and_then(Value::as_bool) == Some(true);
	let master = output_field("master")
		.filter(|master| !master.is_null() && **master != Value::Bool(false))
		.map(master_options);
	let graph = LogGraph::with_max_channels(44_100.0, channels, max_channels);
	let setup = OutputSetup {
		master,
		multichannel,
		seed: Seed::Num(0.0),
	};
	let booked = || -> undertone_pattern::Result<Engine<LogGraph>> {
		let mut engine = Engine::new(graph, setup)?;
		// `createMonoFold(ctx, output)`: the fold feeds the master bus when there is one, and the voices play into it.
		let output = if mono_fold {
			let into = engine.output();
			create_mono_fold(engine.graph_mut(), into)
		} else {
			engine.output()
		};
		for (index, voice) in pending_voices(case).into_iter().enumerate() {
			if case.clear_before.contains(&index) {
				engine.samples_mut().clear_samples();
			}
			for (_, name, data, base_note) in case.registry.iter().filter(|entry| entry.0 == index)
			{
				engine.samples_mut().register_sample(
					name.clone(),
					data.clone(),
					base_note.clone(),
				)?;
			}
			engine.play_to(output, &voice.params, voice.start_time)?;
		}
		Ok(engine)
	};
	match booked() {
		Ok(engine) => Booked::Graph(Box::new(engine.into_graph().finish(None))),
		Err(error) => Booked::Error(error.message().to_string()),
	}
}

fn number_option(render: &Value, key: &str) -> Option<f64> {
	render
		.get(key)
		.map(|v| to_value(v).as_number().expect("number"))
}

/// The render options of a case, as the recorder wrote them (`context` is not recorded).
fn render_options(render: &Value) -> RenderOptions {
	let seed = render.get("seed").map(|seed| match seed.as_str() {
		Some(text) => Seed::Str(text.to_string()),
		None => Seed::Num(seed.as_f64().expect("seed")),
	});
	let master = match render.get("master") {
		None => None,
		Some(Value::Bool(false)) => Some(MasterSetting::Off),
		Some(Value::Bool(true)) => Some(MasterSetting::On),
		Some(options) => Some(MasterSetting::Tuned(master_options(options))),
	};
	let flag = |key: &str| render.get(key).and_then(Value::as_bool);
	RenderOptions {
		cycles: number_option(render, "cycles"),
		seconds: number_option(render, "seconds"),
		bpm: number_option(render, "bpm"),
		cps: number_option(render, "cps"),
		sample_rate: number_option(render, "sampleRate"),
		channels: number_option(render, "channels"),
		tail: number_option(render, "tail"),
		wrap: flag("wrap"),
		seed,
		gated: flag("gated"),
		master,
		booking_window: number_option(render, "bookingWindow"),
		default_cpm: None,
	}
}

/// The voices a plan collected must be the ones the recorder's collection of onsets gave: the same count, and
/// the same start times to the nine digits the corpus keeps.
fn check_onsets(case: &Case, voices: &[PendingVoice]) -> undertone_pattern::Result<()> {
	let fail = |message: String| Err(undertone_pattern::Error::new(message));
	if voices.len() != case.score.len() {
		return fail(format!(
			"{}: {} voices planned, {} recorded",
			case.id,
			voices.len(),
			case.score.len()
		));
	}
	// The recorded score is in collection order; the plan's is in booking order (stable by start time).
	let mut recorded: Vec<f64> = case.score.iter().map(|line| line.at).collect();
	recorded.sort_by(f64::total_cmp);
	let mut planned: Vec<f64> = voices.iter().map(|voice| voice.start_time).collect();
	planned.sort_by(f64::total_cmp);
	for (index, (planned, recorded)) in planned.iter().zip(&recorded).enumerate() {
		if (planned - recorded).abs() > 1e-8 * recorded.abs().max(1e-3) {
			return fail(format!(
				"{}: voice {index} starts at {planned}, recorded {recorded}",
				case.id
			));
		}
	}
	Ok(())
}

/// The recording graph a plan asks for: the plan's sample rate and channel count, all channels available.
fn graph_for(plan: &RenderPlan) -> LogGraph {
	LogGraph::with_max_channels(plan.sample_rate, plan.channels, plan.channels)
}

/// What a pause of the render does to a recording graph: sets its clock to the quantized frame.
fn pause_at(graph: &mut LogGraph, time: f64) -> undertone_pattern::Result<()> {
	graph.set_current_time(time);
	Ok(())
}

/// Books a `render` case from its **program**, the way `renderToBuffer` does on a recording offline context: the
/// program is built with the pattern crate (the interpreter layer 2 uses), planned and booked by the library
/// ([`RenderPlan`]), and the plan's onsets are checked against the recorder's.
fn book_render(case: &Case, program: &Value, render: &Value) -> Booked {
	let outcome = || -> undertone_pattern::Result<(Engine<LogGraph>, usize)> {
		let options = render_options(render);
		let text = serde_json::to_string(program).expect("a program is JSON");
		let program = json::parse(&text).expect("a program parses");
		let pattern = match interpret(&program) {
			Ok(pattern) => pattern,
			Err(Failure::Error(message)) => return Err(undertone_pattern::Error::new(message)),
			Err(Failure::Uncovered(what)) => panic!("{}: not covered: {what}", case.id),
		};
		let plan = RenderPlan::new(&options)?;
		let mut samples = Samples::default();
		for (_, name, data, base_note) in &case.registry {
			samples.register_sample(name.clone(), data.clone(), base_note.clone())?;
		}
		let engine =
			plan.book_pattern_with_samples(graph_for(&plan), samples, &pattern, pause_at)?;
		check_onsets(case, &plan.collect_voices(&pattern)?)?;
		Ok((engine, plan.length))
	};
	finished(outcome())
}

/// A booked render as a case result: the graph, with the render's length in frames.
fn finished(booked: undertone_pattern::Result<(Engine<LogGraph>, usize)>) -> Booked {
	match booked {
		Ok((engine, length)) => {
			Booked::Graph(Box::new(engine.into_graph().finish(Some(length as u64))))
		}
		Err(error) => Booked::Error(error.message().to_string()),
	}
}

/// A score definition as the recorder wrote it.
fn score_definition(definition: &Value) -> ScoreDefinition {
	let number = |value: &Value| to_value(value).as_number().expect("a number");
	let field = |object: &Value, key: &str| object.get(key).map(number);
	let events = definition["events"]
		.as_array()
		.expect("events")
		.iter()
		.map(|event| ScoreEvent {
			tick: field(event, "tick").expect("tick"),
			note: event.get("note").map(|note| match note.as_str() {
				Some(name) => ScoreNote::Name(name.to_string()),
				None => ScoreNote::Hz(number(note)),
			}),
			midi: field(event, "midi"),
			gate: field(event, "gate"),
			level: field(event, "level"),
			pan: field(event, "pan"),
			pan_path: event.get("panPath").map(|points| {
				points
					.as_array()
					.expect("points")
					.iter()
					.map(|point| ScorePanPoint {
						tick: field(point, "tick").expect("tick"),
						pan: field(point, "pan").expect("pan"),
					})
					.collect()
			}),
			autopan: event.get("autopan").map(|autopan| ScoreAutopan {
				period_ticks: field(autopan, "periodTicks").expect("periodTicks"),
				depth: field(autopan, "depth").expect("depth"),
				shape: autopan
					.get("shape")
					.map(|shape| shape.as_str().expect("shape").to_string()),
				phase: field(autopan, "phase"),
			}),
			voice: event.get("voice").map(to_value),
		})
		.collect();
	ScoreDefinition {
		ticks_per_second: field(definition, "ticksPerSecond").expect("ticksPerSecond"),
		length_ticks: field(definition, "lengthTicks").expect("lengthTicks"),
		events,
		seam: definition.get("seam").map(|seam| match seam.as_str() {
			Some("ring") => Seam::Ring,
			Some("cut") => Seam::Cut,
			other => panic!("seam {other:?}"),
		}),
		pan_law: field(definition, "panLaw"),
	}
}

/// Books a `score` case: the score compiled from the definition, and rendered offline at its own tempo
/// ([`Score::book_render`]). The score's `cps` and `seconds` and the plan's onsets are checked against the
/// recorded ones.
fn book_score(case: &Case, definition: &Value, render: &Value) -> Booked {
	let outcome = || -> undertone_pattern::Result<(Engine<LogGraph>, usize)> {
		let cue = Score::new(&score_definition(definition))?;
		if let Some((cps, seconds)) = case.tempo
			&& (cue.cps() != cps || cue.seconds() != seconds)
		{
			return Err(undertone_pattern::Error::new(format!(
				"{}: the score has cps {} and seconds {}, recorded {cps} and {seconds}",
				case.id,
				cue.cps(),
				cue.seconds()
			)));
		}
		let options = render_options(render);
		let plan = cue.render_plan(&options)?;
		check_onsets(case, &plan.collect_voices(cue.pattern())?)?;
		let engine = cue.book_render(graph_for, &options, pause_at)?;
		Ok((engine, plan.length))
	};
	finished(outcome())
}

/// The inputs of a case the corpus records only as a message (a case that throws records no score and no
/// options), taken from `conformance/recorder/optionsData.ts`.
fn book_message_only(id: &str) -> Booked {
	let attempt = |master: MasterBusOptions| {
		Engine::new(
			LogGraph::new(44_100.0, 2),
			OutputSetup {
				master: Some(master),
				..OutputSetup::default()
			},
		)
		.map(|_| ())
	};
	let ceiling = |ceiling: f64| MasterBusOptions {
		ceiling: Some(ceiling),
		..MasterBusOptions::default()
	};
	let error = match id {
		"options-ceiling-above-full-scale" => attempt(ceiling(3.0)).err(),
		"options-ceiling-not-a-level" => attempt(ceiling(f64::NAN)).err(),
		// `render(..., { cps: 1, bookingWindow })` at the default 48000 Hz sample rate.
		"options-window-not-positive" => check_booking_window(0.0, 48_000.0).err(),
		"options-window-too-short" => check_booking_window(0.05, 1_280.0).err(),
		// `fmVoice(definition)` and `layer(note('a4'), voices, options)`, which throw before any voice is booked
		// (`conformance/recorder/instrumentsData.ts`).
		"instruments-fmvoice-error-harmonicity" => fm_voice(&FmVoiceDefinition {
			harmonicity: Some(0.0),
			..FmVoiceDefinition::default()
		})
		.err(),
		"instruments-fmvoice-error-index" => fm_voice(&FmVoiceDefinition {
			modulation_index: Some(-1.0),
			..FmVoiceDefinition::default()
		})
		.err(),
		"instruments-layer-error-empty" => {
			layer(&note("a4").expect("a note"), &[], &LayerOptions::default()).err()
		}
		"instruments-layer-error-stagger" => layer(
			&note("a4").expect("a note"),
			&[PatternValue::Map(Default::default())],
			&LayerOptions {
				stagger: Some(-1.0),
				..LayerOptions::default()
			},
		)
		.err(),
		other => panic!("no inputs are known for the message-only case {other}"),
	};
	error.map_or(Booked::NotImplemented, |error| {
		Booked::Error(error.message().to_string())
	})
}

/// Books a case.
fn book(case: &Case) -> Booked {
	if let (Some(definition), Some(render)) = (&case.definition, &case.render) {
		return book_score(case, definition, render);
	}
	if let Expected::Error(_) = case.expected {
		return book_message_only(&case.id);
	}
	match (&case.program, &case.render) {
		(Some(program), Some(render)) => book_render(case, program, render),
		_ => book_voices(case),
	}
}

fn parse_score_line(line: &str) -> ScoreLine {
	let (_name, rest) = line.split_once(" @").expect("a score line has a time");
	let (at, patch) = rest.split_once(' ').expect("a score line has a patch");
	ScoreLine {
		at: at.parse().expect("the time is a number"),
		patch: serde_json::from_str(patch).expect("the patch is JSON"),
	}
}

/// The `registry` of a case: the decoded samples the recorder registered, with the voice each is registered before.
fn parse_registry(value: &Value) -> Vec<(usize, String, SampleData, Option<Pitch>)> {
	value
		.get("registry")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.map(|sample| {
			let channels = sample["channels"]
				.as_array()
				.expect("channels")
				.iter()
				.map(f32s)
				.collect();
			let base_note = sample.get("baseNote").map(|note| match note {
				Value::String(name) => Pitch::Name(name.clone()),
				other => Pitch::Hz(other.as_f64().expect("a frequency")),
			});
			(
				sample.get("before").and_then(Value::as_u64).unwrap_or(0) as usize,
				sample["name"].as_str().expect("name").to_string(),
				SampleData::new(sample["sampleRate"].as_f64().expect("sampleRate"), channels),
				base_note,
			)
		})
		.collect()
}

fn parse_case(value: &Value) -> Case {
	let text = |key: &str| value[key].as_str().expect(key).to_string();
	// Shapes: `voices` cases carry `voices` (`{at, patch}`) or a `score`, `render` cases a `program` and
	// `render` options, and an error case only an `error` message. The recorder always writes `score` lines
	// for the first two, so they are what is parsed; the structured forms are not needed.
	let score = value
		.get("score")
		.and_then(Value::as_array)
		.map(|lines| {
			lines
				.iter()
				.map(|line| parse_score_line(line.as_str().expect("a score line is text")))
				.collect()
		})
		.unwrap_or_default();
	let expected = match value.get("error") {
		Some(message) => Expected::Error(message.as_str().expect("error text").to_string()),
		None => Expected::Graph(value["graph"].clone()),
	};
	Case {
		id: text("id"),
		score,
		output: value.get("output").cloned(),
		program: value.get("program").cloned(),
		definition: value.get("definition").cloned(),
		render: value.get("render").cloned(),
		tempo: value
			.get("cps")
			.zip(value.get("seconds"))
			.map(|(cps, seconds)| {
				(
					cps.as_f64().expect("cps"),
					seconds.as_f64().expect("seconds"),
				)
			}),
		registry: parse_registry(value),
		clear_before: value
			.get("clearBefore")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.map(|index| index.as_u64().expect("a voice index") as usize)
			.collect(),
		expected,
	}
}

fn corpus_dir() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cases/3")
}

/// Every group file of layer 3, by group name.
fn groups() -> BTreeMap<String, Vec<Value>> {
	let mut groups = BTreeMap::new();
	for entry in std::fs::read_dir(corpus_dir()).expect("conformance/cases/3 exists") {
		let path = entry.expect("a directory entry").path();
		if path.extension().is_none_or(|extension| extension != "json") {
			continue;
		}
		let text = std::fs::read_to_string(&path).expect("the corpus file reads");
		let file: Value = serde_json::from_str(&text).expect("the corpus file is JSON");
		assert_eq!(file["layer"], 3, "{} is a layer 3 file", path.display());
		let group = file["group"].as_str().expect("group").to_string();
		let cases = file["cases"].as_array().expect("cases").clone();
		groups.insert(group, cases);
	}
	groups
}

/// Where the absolute floor applies (CONFORMANCE.md, R9): wave coefficients (`waves[].real` and `.imag`) and
/// the values of gain automation (`nodes[].params.gain`, the second token of a call string). Everything else,
/// every time included, is compared exactly.
fn is_wave_coefficient(path: &str) -> bool {
	path.contains(".waves[") && (path.contains(".real[") || path.contains(".imag["))
}

fn is_gain_call(path: &str) -> bool {
	path.contains(".nodes[") && path.contains(".params.gain[")
}

/// A number the recorder writes as `{"$num": ...}` (a value JSON cannot hold), or a plain number.
fn number_of(value: &Value) -> Option<f64> {
	match value {
		Value::Number(n) => n.as_f64(),
		Value::Object(map) if map.len() == 1 => match map.get("$num")?.as_str()? {
			"-0" => Some(-0.0),
			"NaN" => Some(f64::NAN),
			"Infinity" => Some(f64::INFINITY),
			"-Infinity" => Some(f64::NEG_INFINITY),
			_ => None,
		},
		_ => None,
	}
}

/// Whether two JSON values are equal: exactly, except inside the two places the floor is allowed (see
/// [`is_wave_coefficient`]). Returns whether the floor was needed, or the path of the first difference.
fn compare(expected: &Value, actual: &Value, path: &str) -> Result<bool, String> {
	if is_wave_coefficient(path)
		&& let (Some(e), Some(a)) = (number_of(expected), number_of(actual))
	{
		return if e.to_bits() == a.to_bits() {
			Ok(false)
		} else if (e - a).abs() <= ABS_FLOOR {
			Ok(true)
		} else {
			Err(format!("{path}: recorded {e}, rust {a}"))
		};
	}
	match (expected, actual) {
		(Value::String(e), Value::String(a)) => {
			if e == a {
				return Ok(false);
			}
			if !is_gain_call(path) {
				return Err(format!("{path}: recorded {e:?}, rust {a:?}"));
			}
			// A call string is `<method> <value> @<time> ...`: only the value may use the floor, and a zero of
			// either sign must match its sign.
			let (e_tokens, a_tokens): (Vec<_>, Vec<_>) =
				(e.split(' ').collect(), a.split(' ').collect());
			let floor_value = e_tokens.len() == a_tokens.len()
				&& e_tokens.len() > 2
				&& e_tokens
					.iter()
					.zip(&a_tokens)
					.enumerate()
					.all(|(index, (x, y))| index == 1 || x == y)
				&& *e_tokens[1] != *"-0"
				&& *a_tokens[1] != *"-0"
				&& matches!(
					(e_tokens[1].parse::<f64>(), a_tokens[1].parse::<f64>()),
					(Ok(x), Ok(y)) if (x - y).abs() <= ABS_FLOOR
				);
			if floor_value {
				Ok(true)
			} else {
				Err(format!("{path}: recorded {e:?}, rust {a:?}"))
			}
		}
		(Value::Number(e), Value::Number(a)) => {
			if e == a {
				Ok(false)
			} else {
				Err(format!("{path}: recorded {e}, rust {a}"))
			}
		}
		(Value::Array(e), Value::Array(a)) => {
			if e.len() != a.len() {
				return Err(format!(
					"{path}: {} recorded, {} from rust",
					e.len(),
					a.len()
				));
			}
			let mut floor = false;
			for (index, (x, y)) in e.iter().zip(a).enumerate() {
				floor |= compare(x, y, &format!("{path}[{index}]"))?;
			}
			Ok(floor)
		}
		(Value::Object(e), Value::Object(a)) => {
			let keys = |object: &serde_json::Map<String, Value>| {
				object.keys().cloned().collect::<Vec<_>>()
			};
			if keys(e) != keys(a) {
				return Err(format!(
					"{path}: keys {:?} recorded, {:?} from rust",
					keys(e),
					keys(a)
				));
			}
			let mut floor = false;
			for (key, x) in e {
				floor |= compare(x, &a[key], &format!("{path}.{key}"))?;
			}
			Ok(floor)
		}
		(e, a) if e == a => Ok(false),
		(e, a) => Err(format!("{path}: recorded {e}, rust {a}")),
	}
}

#[test]
fn layer_3_cases_are_equal_or_listed_as_pending() {
	let groups = groups();
	assert!(!groups.is_empty(), "no layer 3 group was found");
	let known: Vec<String> = groups
		.values()
		.flatten()
		.map(|case| case["id"].as_str().expect("id").to_string())
		.collect();
	for (listed, _) in PENDING_CASES {
		assert!(
			known.iter().any(|id| id == listed),
			"PENDING_CASES names a missing case {listed}"
		);
	}
	let mut failures = Vec::new();
	for (group, cases) in &groups {
		let (mut equal, mut pending, mut floor_ids) = (0usize, 0usize, Vec::new());
		let mut pending_ids = Vec::new();
		for value in cases {
			let case = parse_case(value);
			let reason = pending_reason(&case);
			// `Ok(floor)` when the booking equals the corpus, `Err(difference)` when it does not.
			let outcome: Result<bool, String> = match book(&case) {
				Booked::NotImplemented => Err("not booked".to_string()),
				Booked::Error(message) => match &case.expected {
					Expected::Error(recorded) if *recorded == message => Ok(false),
					other => Err(format!(
						"{}: booking failed with {message:?}, recorded {other:?}",
						case.id
					)),
				},
				Booked::Graph(record) => match &case.expected {
					Expected::Graph(expected) => {
						let actual: Value = serde_json::from_str(&record.to_json(""))
							.expect("the writer produces JSON");
						compare(expected, &actual, &case.id)
					}
					Expected::Error(recorded) => Err(format!(
						"{}: booked a graph where the error {recorded:?} is recorded",
						case.id
					)),
				},
			};
			match (outcome, reason) {
				(Ok(floor), None) => {
					equal += 1;
					if floor {
						floor_ids.push(case.id.clone());
					}
				}
				(Err(difference), None) => failures.push(difference),
				(Ok(_), Some(reason)) => failures.push(format!(
					"{}: is listed as pending ({reason}) but equals the corpus; remove it from the pending list",
					case.id
				)),
				(Err(_), Some(_)) => {
					pending += 1;
					pending_ids.push(case.id.clone());
				}
			}
		}
		let total = cases.len();
		println!("layer 3 {group}: {equal}/{total} equal, {pending} pending");
		if !floor_ids.is_empty() {
			println!("  equal only within the absolute floor: {floor_ids:?}");
		}
		for id in &pending_ids {
			let reason = PENDING_CASES
				.iter()
				.find(|(listed, _)| listed == id)
				.map_or("", |(_, reason)| *reason);
			println!("  pending {id}: {reason}");
		}
	}
	assert!(
		failures.is_empty(),
		"layer 3 differences:\n{}",
		failures.join("\n")
	);
}

/// The text of the `graph` object of a case in a corpus file, as the file holds it (the lines from
/// `"graph": {` to its closing brace, with the brace's own line indentation kept).
fn graph_text_in_file(group: &str, id: &str) -> String {
	let text = std::fs::read_to_string(corpus_dir().join(format!("{group}.json"))).expect("file");
	let start = text
		.find(&format!("\"id\": \"{id}\""))
		.unwrap_or_else(|| panic!("case {id} is in the file"));
	let after = &text[start..];
	let key = after.find("\"graph\": ").expect("the case has a graph") + "\"graph\": ".len();
	let object = &after[key..];
	// The graph is the last key of a case: its closing brace is the first line that is exactly six spaces and `}`.
	let end = object.find("\n      }").expect("the graph ends") + "\n      }".len();
	object[..end].to_string()
}

/// `placement-pan-default` built by hand: a triangle voice at 220 Hz through a gain envelope and a panner.
#[test]
fn a_hand_built_graph_writes_the_corpus_bytes() {
	let mut graph = LogGraph::new(44_100.0, 2);
	let gain = graph.create_node(NodeKind::Gain);
	let oscillator = graph.create_node(NodeKind::Oscillator);
	let panner = graph.create_node(NodeKind::StereoPanner);
	let level = graph.param(gain, ParamKind::Gain);
	graph.set_oscillator_type(oscillator, OscillatorType::Triangle);
	let frequency = graph.param(oscillator, ParamKind::Frequency);
	graph.set_value_at_time(frequency, 220.0, 0.0);
	graph.set_value_at_time(level, 0.0, 0.0);
	graph.linear_ramp_to_value_at_time(level, 0.3, 0.01);
	graph.linear_ramp_to_value_at_time(level, 0.15, 0.11);
	graph.set_value_at_time(level, 0.15, 0.5);
	graph.linear_ramp_to_value_at_time(level, 0.0, 0.7);
	let pan = graph.param(panner, ParamKind::Pan);
	graph.set_value_at_time(pan, 0.5, 0.0);
	graph.connect_node(oscillator, gain);
	graph.connect_node(gain, panner);
	graph.connect_node(panner, graph.destination());
	graph.start(oscillator, 0.0);
	graph.stop(oscillator, 0.72);

	let written = graph.finish(None).to_json("      ");
	assert_eq!(
		written,
		graph_text_in_file("placement", "placement-pan-default")
	);
}

/// Parses one call string of a parameter, as `LogGraph` writes it.
fn parse_call(call: &str) -> Automation {
	let tokens: Vec<&str> = call.split(' ').collect();
	let number = |text: &str| -> f64 { text.trim_start_matches('@').parse().expect("a number") };
	match tokens[0] {
		"set" => Automation::Set {
			value: number(tokens[1]),
			time: number(tokens[2]),
		},
		"lin" => Automation::LinearRamp {
			value: number(tokens[1]),
			time: number(tokens[2]),
		},
		"exp" => Automation::ExponentialRamp {
			value: number(tokens[1]),
			time: number(tokens[2]),
		},
		"target" => Automation::Target {
			value: number(tokens[1]),
			time: number(tokens[2]),
			time_constant: number(tokens[4]),
		},
		"cancel" => Automation::Cancel {
			time: number(tokens[1]),
		},
		other => panic!("unknown call {other}"),
	}
}

fn node_kind(name: &str) -> Option<NodeKind> {
	Some(match name {
		"oscillator" => NodeKind::Oscillator,
		"gain" => NodeKind::Gain,
		"filter" => NodeKind::BiquadFilter,
		"panner" => NodeKind::StereoPanner,
		"merger" => NodeKind::ChannelMerger { inputs: 2 },
		"bufferSource" => NodeKind::BufferSource,
		"convolver" => NodeKind::Convolver,
		"delay" => NodeKind::Delay,
		"compressor" => NodeKind::DynamicsCompressor,
		"waveShaper" => NodeKind::WaveShaper,
		_ => return None,
	})
}

fn param_kind(name: &str) -> ParamKind {
	[
		ParamKind::Frequency,
		ParamKind::Gain,
		ParamKind::Q,
		ParamKind::Pan,
		ParamKind::DelayTime,
		ParamKind::Threshold,
		ParamKind::Knee,
		ParamKind::Ratio,
		ParamKind::Attack,
		ParamKind::Release,
		ParamKind::PlaybackRate,
	]
	.into_iter()
	.find(|kind| kind.name() == name)
	.unwrap_or_else(|| panic!("unknown parameter {name}"))
}

fn f32s(values: &Value) -> Vec<f32> {
	values
		.as_array()
		.expect("an array")
		.iter()
		.map(|v| match v.get("$num").and_then(Value::as_str) {
			Some("-0") => -0.0,
			Some(other) => panic!("special number {other}"),
			None => v.as_f64().expect("number") as f32,
		})
		.collect()
}

/// Replays a recorded graph through the `Graph` trait. A graph with buffers is replayed only when every buffer
/// is a sample of the case's `registry` (the corpus holds summaries, not samples, so any other buffer cannot be
/// remade); each is found by its frames, sample rate, and channel count, and the replay must then write the
/// recorded summary back, which checks the summaries too.
fn replay(
	graph: &Value,
	registry: &[(usize, String, SampleData, Option<Pitch>)],
) -> Option<LogGraph> {
	let mut log = LogGraph::new(
		graph["sampleRate"].as_f64().expect("rate"),
		graph["channels"].as_u64().expect("channels") as u32,
	);
	let mut recorded_buffers = Vec::new();
	for buffer in graph["buffers"].as_array().expect("buffers") {
		if buffer["kind"] != "audio" {
			return None;
		}
		let (length, rate) = (
			buffer["length"].as_u64()? as usize,
			buffer["sampleRate"].as_f64()?,
		);
		let count = buffer["channels"].as_array()?.len();
		let mut found = registry.iter().filter(|(_, _, data, _)| {
			data.frames() == length && data.sample_rate == rate && data.channels.len() == count
		});
		let (_, _, data, _) = found.next()?;
		if found.next().is_some_and(|(_, _, other, _)| other != data) {
			return None; // ambiguous
		}
		let id = log.create_buffer(count as u32, length, rate);
		for (channel, samples) in data.channels.iter().enumerate() {
			log.buffer_channel_mut(id, channel as u32)
				.copy_from_slice(samples);
		}
		recorded_buffers.push(id);
	}
	let nodes = graph["nodes"].as_array().expect("nodes");
	let waves: Vec<_> = graph["waves"]
		.as_array()
		.expect("waves")
		.iter()
		.map(|wave| {
			log.create_periodic_wave(
				&f32s(&wave["real"]),
				&f32s(&wave["imag"]),
				wave["disableNormalization"].as_bool().expect("flag"),
			)
		})
		.collect();
	let ids: Vec<NodeId> = nodes
		.iter()
		.map(
			|node| match node_kind(node["kind"].as_str().expect("kind")) {
				Some(kind) => log.create_node(kind),
				None => log.destination(),
			},
		)
		.collect();
	for (index, node) in nodes.iter().enumerate() {
		let id = ids[index];
		if let Some(fields) = node.get("fields") {
			for (key, value) in fields.as_object().expect("fields") {
				match (key.as_str(), value) {
					("type", Value::String(text)) if text == "custom" => {}
					("type", Value::String(text)) => match node["kind"].as_str().expect("kind") {
						"oscillator" => log.set_oscillator_type(
							id,
							match text.as_str() {
								"square" => OscillatorType::Square,
								"sawtooth" => OscillatorType::Sawtooth,
								"triangle" => OscillatorType::Triangle,
								_ => OscillatorType::Sine,
							},
						),
						_ => log.set_filter_type(
							id,
							match text.as_str() {
								"highpass" => FilterType::Highpass,
								"allpass" => FilterType::Allpass,
								other => panic!("filter type {other}"),
							},
						),
					},
					("wave", Value::String(text)) => {
						let number: usize = text[1..].parse().expect("a wave number");
						log.set_periodic_wave(id, waves[number]);
					}
					("buffer", Value::String(text)) => {
						let number: usize = text[1..].parse().expect("a buffer number");
						log.set_buffer(id, Some(recorded_buffers[number]));
					}
					("loop", Value::Bool(flag)) => log.set_loop(id, *flag),
					("oversample", Value::String(text)) => log.set_oversample(
						id,
						if text == "2x" {
							Oversample::X2
						} else {
							Oversample::X4
						},
					),
					("channelCount", number) => {
						log.set_channel_count(id, number.as_u64().expect("count") as u32);
					}
					("channelCountMode", Value::String(text)) => log.set_channel_count_mode(
						id,
						match text.as_str() {
							"max" => ChannelCountMode::Max,
							"clamped-max" => ChannelCountMode::ClampedMax,
							"explicit" => ChannelCountMode::Explicit,
							other => panic!("channel count mode {other}"),
						},
					),
					("channelInterpretation", Value::String(text)) => log
						.set_channel_interpretation(
							id,
							if text == "discrete" {
								ChannelInterpretation::Discrete
							} else {
								ChannelInterpretation::Speakers
							},
						),
					other => panic!("a field the replay does not know: {other:?}"),
				}
			}
		}
		if let Some(params) = node.get("params") {
			for (key, calls) in params.as_object().expect("params") {
				let param = log.param(id, param_kind(key));
				for call in calls.as_array().expect("calls") {
					log.automate(param, parse_call(call.as_str().expect("call text")));
				}
			}
		}
		for (key, method) in [("start", true), ("stop", false)] {
			if let Some(times) = node.get(key) {
				for time in times.as_array().expect("times") {
					let time = time.as_f64().expect("time");
					if method {
						log.start(id, time)
					} else {
						log.stop(id, time)
					}
				}
			}
		}
		for _ in 0..node.get("disconnects").and_then(Value::as_u64).unwrap_or(0) {
			log.disconnect(id);
		}
	}
	// Connections last, because a connection may point at a node made after its source.
	for (index, node) in nodes.iter().enumerate() {
		for target in node
			.get("to")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
		{
			let text = target.as_str().expect("target text");
			let (name, ports) = text
				.split_once(' ')
				.map_or((text, None), |(n, p)| (n, Some(p)));
			let (output, input) = ports.map_or((0, 0), |p| {
				let words: Vec<&str> = p.split(' ').collect();
				(
					words[1].parse().expect("output"),
					words[3].parse().expect("input"),
				)
			});
			let (node_text, param) = name
				.split_once('.')
				.map_or((name, None), |(n, p)| (n, Some(p)));
			let target_node = ids[node_text[1..].parse::<usize>().expect("a node number")];
			let target = match param {
				Some(param) => Target::Param(log.param(target_node, param_kind(param))),
				None => Target::Node(target_node),
			};
			log.connect(ids[index], target, output, input);
		}
	}
	Some(log)
}

/// Every recorded graph that can be remade (no buffers, or only samples of the case's registry), replayed through
/// the trait, writes itself back byte for byte.
#[test]
fn recorded_graphs_replay_to_the_same_bytes() {
	let (mut replayed, mut skipped) = (0usize, 0usize);
	for (group, cases) in groups() {
		for case in &cases {
			let id = case["id"].as_str().expect("id");
			if case.get("graph").is_none() {
				continue; // an error case records no graph
			}
			let Some(log) = replay(&case["graph"], &parse_registry(case)) else {
				skipped += 1;
				continue;
			};
			let length = case["graph"]["length"].as_u64();
			assert_eq!(
				log.finish(length).to_json("      "),
				graph_text_in_file(&group, id),
				"{id}"
			);
			replayed += 1;
		}
	}
	println!(
		"replayed {replayed} recorded graphs; {skipped} skipped because they hold buffers that are not samples"
	);
	assert!(replayed > 0);
}

/// A tiny graph around one node, to test the comparator on the paths it treats differently.
#[cfg(test)]
mod comparator {
	use super::*;
	use serde_json::json;

	fn graph(node: Value, wave_real: Value) -> Value {
		json!({
			"nodes": [{"id": "n0", "kind": "destination"}, node],
			"waves": [{"id": "w0", "real": wave_real, "imag": [0], "disableNormalization": false}]
		})
	}

	fn gain_node(call: &str, start: f64) -> Value {
		json!({"id": "n1", "kind": "gain", "params": {"gain": [call]}, "start": [start]})
	}

	fn same(a: &Value, b: &Value) -> Result<bool, String> {
		compare(a, b, "case")
	}

	#[test]
	fn negative_zero_differs_from_zero_in_a_call() {
		let a = graph(gain_node("set -0 @0", 0.0), json!([0]));
		let b = graph(gain_node("set 0 @0", 0.0), json!([0]));
		assert!(same(&a, &b).is_err());
	}

	#[test]
	fn a_start_time_off_by_one_tiny_step_differs() {
		let a = graph(gain_node("set 1 @0", 0.5), json!([0]));
		let b = graph(gain_node("set 1 @0", 0.5 + 1e-16), json!([0]));
		assert!(same(&a, &b).is_err());
	}

	#[test]
	fn a_time_in_a_call_is_exact_but_a_gain_value_has_the_floor() {
		let a = graph(gain_node("set 1e-16 @0.5", 0.0), json!([0]));
		let b = graph(gain_node("set 0 @0.5", 0.0), json!([0]));
		assert_eq!(same(&a, &b), Ok(true));
		let c = graph(gain_node("set 0 @0.5000000001", 0.0), json!([0]));
		assert!(same(&b, &c).is_err());
	}

	#[test]
	fn other_parameters_are_exact() {
		let node = |call: &str| json!({"id": "n1", "kind": "panner", "params": {"pan": [call]}});
		let a = graph(node("set 1e-16 @0"), json!([0]));
		let b = graph(node("set 0 @0"), json!([0]));
		assert!(same(&a, &b).is_err());
	}

	#[test]
	fn a_wave_coefficient_has_the_floor_and_a_negative_zero_object_matches_a_tiny_number() {
		let node = gain_node("set 1 @0", 0.0);
		let a = graph(node.clone(), json!([1e-16, {"$num": "-0"}]));
		let b = graph(node.clone(), json!([0, 5e-17]));
		assert_eq!(same(&a, &b), Ok(true));
		let c = graph(node, json!([1e-14, 0]));
		assert!(same(&a, &c).is_err());
	}
}
