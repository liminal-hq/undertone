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
//! trait for `placement-pan-default` must write the corpus bytes, and every recorded graph without buffers is
//! replayed through the trait and must write itself back byte for byte.

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
use undertone_engine::params::resolve_params;
use undertone_engine::surround::create_mono_fold;
use undertone_engine::window::{
	PendingVoice, RENDER_QUANTUM_FRAMES, booking_windows, check_booking_window, last_room_sizes,
	sort_booking_order,
};
use undertone_pattern::control::note;
use undertone_pattern::random::Seed;
use undertone_pattern::{Value as PatternValue, js};

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
	/// `program` and `render` of a render case.
	render: Option<(Value, Value)>,
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
		for voice in pending_voices(case) {
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

/// Books a `render` case the way `renderToBuffer` does on a recording offline context: the context made from
/// the options, the destination widened for more than two channels, the master bus (on unless `master` is
/// `false`), then the score's voices in time order, all up front or in the planned windows. A pause of the
/// render sets the graph's clock to the quantized frame before its window is booked. The score is read from
/// the corpus (what the recorder's collection of onsets gave), because collecting onsets from a program
/// belongs to the scheduler.
fn book_render(case: &Case, render: &Value) -> Booked {
	let sample_rate = number_option(render, "sampleRate").unwrap_or(48_000.0);
	let channels = number_option(render, "channels").map_or(2, |count| count as u32);
	let tail = number_option(render, "tail").unwrap_or(0.0);
	let window = number_option(render, "bookingWindow");
	if let Some(window) = window
		&& let Err(error) = check_booking_window(window, sample_rate)
	{
		return Booked::Error(error.message().to_string());
	}
	let cycle_seconds = match (number_option(render, "cps"), number_option(render, "bpm")) {
		(Some(cps), None) => 1.0 / cps,
		(None, Some(bpm)) => 240.0 / bpm,
		(None, None) => 240.0 / 120.0,
		(Some(_), Some(_)) => return Booked::Error("Pass either bpm or cps, not both".into()),
	};
	let cycles = number_option(render, "cycles").unwrap_or(1.0);
	let pass_seconds = cycles * cycle_seconds;
	let length = js::round((pass_seconds + tail) * sample_rate).max(1.0) as u64;

	let master = match render.get("master") {
		Some(Value::Bool(false)) => None,
		Some(Value::Bool(true)) | None => Some(MasterBusOptions::default()),
		Some(options) => Some(master_options(options)),
	};
	let seed = render
		.get("seed")
		.map_or(Seed::Num(0.0), |seed| match seed.as_str() {
			Some(text) => Seed::Str(text.to_string()),
			None => Seed::Num(seed.as_f64().expect("seed")),
		});
	let graph = LogGraph::with_max_channels(sample_rate, channels, channels);
	let setup = OutputSetup {
		master,
		multichannel: channels > 2,
		seed,
	};
	let mut engine = match Engine::new(graph, setup) {
		Ok(engine) => engine,
		Err(error) => return Booked::Error(error.message().to_string()),
	};

	let mut voices = pending_voices(case);
	sort_booking_order(&mut voices);
	let outcome = (|| -> undertone_pattern::Result<()> {
		match window {
			None => {
				for voice in &voices {
					engine.play(&voice.params, voice.start_time)?;
				}
			}
			Some(window) => {
				let last_pause = (length as f64 - 2.0 * RENDER_QUANTUM_FRAMES as f64) / sample_rate;
				let sized = last_room_sizes(&voices, |params| engine.is_voice_skipped(params));
				let windows = booking_windows(&sized, window, last_pause);
				// Windows at time 0 are booked before the render; the rest at their pauses, in frame order.
				let mut pauses = Vec::new();
				for window in &windows {
					if window.suspend_at == 0.0 {
						for voice in &window.voices {
							engine.play(&voice.params, voice.start_time)?;
						}
					} else {
						let quantum = RENDER_QUANTUM_FRAMES as f64;
						let frame = ((window.suspend_at * sample_rate) / quantum).floor() * quantum;
						pauses.push((frame, window));
					}
				}
				pauses.sort_by(|a, b| a.0.total_cmp(&b.0));
				for (frame, window) in pauses {
					engine.graph_mut().set_current_time(frame / sample_rate);
					for voice in &window.voices {
						engine.play(&voice.params, voice.start_time)?;
					}
				}
			}
		}
		Ok(())
	})();
	match outcome {
		Ok(()) => Booked::Graph(Box::new(engine.into_graph().finish(Some(length)))),
		Err(error) => Booked::Error(error.message().to_string()),
	}
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
	if let Expected::Error(_) = case.expected {
		return book_message_only(&case.id);
	}
	match &case.render {
		Some((_, render)) => book_render(case, render),
		None => book_voices(case),
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
		render: value
			.get("program")
			.map(|program| (program.clone(), value["render"].clone())),
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

/// Replays a recorded graph without buffers through the `Graph` trait. Returns `None` for a graph with buffers
/// (their samples are not in the corpus, only their summaries).
fn replay(graph: &Value) -> Option<LogGraph> {
	if !graph["buffers"].as_array().expect("buffers").is_empty() {
		return None;
	}
	let mut log = LogGraph::new(
		graph["sampleRate"].as_f64().expect("rate"),
		graph["channels"].as_u64().expect("channels") as u32,
	);
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

/// Every recorded graph without buffers, replayed through the trait, writes itself back byte for byte.
#[test]
fn recorded_graphs_without_buffers_replay_to_the_same_bytes() {
	let (mut replayed, mut skipped) = (0usize, 0usize);
	for (group, cases) in groups() {
		for case in &cases {
			let id = case["id"].as_str().expect("id");
			if case.get("graph").is_none() {
				continue; // an error case records no graph
			}
			let Some(log) = replay(&case["graph"]) else {
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
	println!("replayed {replayed} recorded graphs; {skipped} skipped because they hold buffers");
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
