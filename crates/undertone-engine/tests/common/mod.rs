// Helpers shared by the render tests: corpus JSON to voices, and a case's score booked and rendered on a RenderGraph
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

#![allow(dead_code, reason = "each test crate uses some of the helpers")]

use serde_json::Value;
use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::Graph;
use undertone_engine::master::{Limiter, LimiterOptions, MasterBusOptions};
use undertone_engine::params::{Pitch, resolve_params};
use undertone_engine::render_graph::RenderGraph;
use undertone_engine::samples::SampleData;
use undertone_engine::surround::create_mono_fold;
use undertone_engine::window::{PendingVoice, last_room_sizes, sort_booking_order};
use undertone_pattern::Value as PatternValue;
use undertone_pattern::random::Seed;

/// The longest a render runs, in seconds, however long the options say.
pub const MAX_SECONDS: f64 = 12.0;

/// A corpus JSON value as a pattern value (the `{"$num": ...}` special numbers included).
pub fn to_value(json: &Value) -> PatternValue {
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

/// The master bus options a case's `master` object describes.
pub fn master_options(master: &Value) -> MasterBusOptions {
	let Some(object) = master.as_object() else {
		return MasterBusOptions::default();
	};
	let number = |key: &str| object.get(key).and_then(Value::as_f64);
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

/// The voices of a case's `score` lines, resolved as the engine resolves a patch.
pub fn voices(case: &Value) -> Vec<PendingVoice> {
	case["score"]
		.as_array()
		.map(|lines| {
			lines
				.iter()
				.map(|line| {
					let line = line.as_str().expect("a score line is text");
					let (_name, rest) = line.split_once(" @").expect("a score line has a time");
					let (at, patch) = rest.split_once(' ').expect("a score line has a patch");
					let patch: Value = serde_json::from_str(patch).expect("the patch is JSON");
					PendingVoice {
						start_time: at.parse().expect("the time is a number"),
						params: resolve_params(&to_value(&patch)),
					}
				})
				.collect()
		})
		.unwrap_or_default()
}

/// What rendering a case gave.
pub struct Rendered {
	/// The samples of each output channel.
	pub channels: Vec<Vec<f32>>,
	/// The render's length in seconds.
	pub seconds: f64,
}

/// Books a case on an `Engine` over a `RenderGraph`, renders it, and returns the samples (`None` for a case
/// the booking itself refuses, which the corpus records as an error).
pub fn render_case(case: &Value) -> Option<Rendered> {
	render_case_frames(case, None)
}

/// [`render_case`] with the render's length in frames given (a layer 4 case records the browser's), in place of the length worked out from the options.
pub fn render_case_frames(case: &Value, frames: Option<u64>) -> Option<Rendered> {
	let output = case.get("output");
	let render = case.get("render");
	let field = |key: &str| {
		render
			.and_then(|r| r.get(key))
			.or_else(|| output.and_then(|o| o.get(key)))
	};
	let sample_rate = field("sampleRate")
		.and_then(Value::as_f64)
		.unwrap_or(44_100.0);
	let channels = field("channels")
		.and_then(Value::as_u64)
		.map_or(2, |c| c as u32);
	let max_channels = field("maxChannels")
		.and_then(Value::as_u64)
		.map_or(channels, |c| c as u32)
		.max(channels);
	let multichannel = field("multichannel")
		.and_then(Value::as_bool)
		.unwrap_or(channels > 2);
	let mono_fold = field("monoFold").and_then(Value::as_bool) == Some(true);
	let master = match field("master") {
		None => render.map(|_| MasterBusOptions::default()),
		Some(Value::Bool(false) | Value::Null) => None,
		Some(Value::Bool(true)) => Some(MasterBusOptions::default()),
		Some(options) => Some(master_options(options)),
	};
	let seed = match field("seed") {
		None => Seed::Num(0.0),
		Some(Value::String(text)) => Seed::Str(text.clone()),
		Some(number) => Seed::Num(number.as_f64().expect("seed")),
	};

	// The render is as wide as the hardware allows; the destination starts at the recorded channel count.
	let mut graph = RenderGraph::new(sample_rate, max_channels, 0);
	let destination = graph.destination();
	graph.set_channel_count(destination, channels);
	let setup = OutputSetup {
		master,
		multichannel,
		seed,
	};
	let mut engine = Engine::new(graph, setup).ok()?;
	let into = if mono_fold {
		let into = engine.output();
		create_mono_fold(engine.graph_mut(), into)
	} else {
		engine.output()
	};
	// The decoded samples a case registers, all up front (the `before` and `clearBefore` timing is the layer 3
	// runner's concern).
	for sample in case
		.get("registry")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
	{
		let channels = sample["channels"]
			.as_array()?
			.iter()
			.map(|channel| {
				channel
					.as_array()
					.into_iter()
					.flatten()
					.map(|value| value.as_f64().unwrap_or(0.0) as f32)
					.collect()
			})
			.collect();
		let base_note = sample.get("baseNote").map(|note| match note {
			Value::String(name) => Pitch::Name(name.clone()),
			other => Pitch::Hz(other.as_f64().unwrap_or(261.63)),
		});
		let data = SampleData::new(sample["sampleRate"].as_f64()?, channels);
		engine
			.samples_mut()
			.register_sample(sample["name"].as_str()?, data, base_note)
			.ok()?;
	}
	let mut pending = voices(case);
	sort_booking_order(&mut pending);
	// A reverb's room size is fixed per orbit for the whole render (the last one booked wins), as `renderToBuffer` does.
	let pending = last_room_sizes(&pending, |params| engine.is_voice_skipped(params));
	let mut end = 0.0_f64;
	for voice in &pending {
		let playback = engine.play_to(into, &voice.params, voice.start_time).ok()?;
		end = end.max(playback.end_time);
	}
	let mut graph = engine.into_graph();

	// A render case's length is its options'; a voices case runs to the end of its last voice.
	let seconds = match render {
		Some(options) => {
			let cycle = match (
				options.get("cps").and_then(Value::as_f64),
				options.get("bpm").and_then(Value::as_f64),
			) {
				(Some(cps), _) => 1.0 / cps,
				(None, Some(bpm)) => 240.0 / bpm,
				(None, None) => 2.0,
			};
			let cycles = options.get("cycles").and_then(Value::as_f64).unwrap_or(1.0);
			let tail = options.get("tail").and_then(Value::as_f64).unwrap_or(0.0);
			(cycles * cycle + tail).max(0.05)
		}
		None => (end + 0.1).max(0.25),
	}
	.min(MAX_SECONDS);
	let frames = frames.unwrap_or_else(|| (seconds * sample_rate).round() as u64);
	graph.set_length_frames(frames);
	Some(Rendered {
		channels: graph.render_all(),
		seconds,
	})
}

/// The peak and the RMS of every sample of every channel.
pub fn stats(channels: &[Vec<f32>]) -> (f64, f64) {
	let mut peak = 0.0_f64;
	let (mut sum, mut count) = (0.0_f64, 0usize);
	for sample in channels.iter().flatten() {
		peak = peak.max(f64::from(sample.abs()));
		sum += f64::from(*sample).powi(2);
		count += 1;
	}
	(peak, (sum / count.max(1) as f64).sqrt())
}
