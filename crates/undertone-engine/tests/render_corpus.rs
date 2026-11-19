// Renders every layer 3 corpus score through the in-house renderer and checks it runs and stays finite
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A smoke test for [`RenderGraph`]: each layer 3 case that has a `score` is booked on an [`Engine`] over a
//! `RenderGraph` (the same booking the graph runner makes on a `LogGraph`) and rendered, and the output must
//! be finite, with no panic. This is not a golden comparison: layer 4's browser references are made later
//! (`docs/rust-migration/CONFORMANCE.md`), so the test prints a summary of each case's peak and RMS and
//! checks only that the numbers are sane. Nothing in it was listened to.
//!
//! Render cases (a `program` and `render` options) are booked up front from their recorded score, with the
//! options' sample rate, channels, master bus, seed, and length; the booking-window pauses of the real
//! renderer are not reproduced (every voice is booked before the first quantum). Cases that record an error
//! rather than a graph have no score and are skipped.

use serde_json::Value;
use std::path::Path;
use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::Graph;
use undertone_engine::master::{Limiter, LimiterOptions, MasterBusOptions};
use undertone_engine::params::resolve_params;
use undertone_engine::render_graph::RenderGraph;
use undertone_engine::surround::create_mono_fold;
use undertone_engine::window::{PendingVoice, sort_booking_order};
use undertone_pattern::Value as PatternValue;
use undertone_pattern::random::Seed;

/// The longest a smoke render runs, in seconds, however long the score is.
const MAX_SECONDS: f64 = 12.0;

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

fn master_options(master: &Value) -> MasterBusOptions {
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

fn voices(case: &Value) -> Vec<PendingVoice> {
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
struct Rendered {
	channels: Vec<Vec<f32>>,
	seconds: f64,
}

/// Books a case on an `Engine` over a `RenderGraph`, renders it, and returns the samples (`None` for a case
/// the booking itself refuses, which the corpus records as an error).
fn render_case(case: &Value) -> Option<Rendered> {
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
	let mut pending = voices(case);
	sort_booking_order(&mut pending);
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
	graph.set_length_frames((seconds * sample_rate).round() as u64);
	Some(Rendered {
		channels: graph.render_all(),
		seconds,
	})
}

fn stats(channels: &[Vec<f32>]) -> (f64, f64) {
	let mut peak = 0.0_f64;
	let (mut sum, mut count) = (0.0_f64, 0usize);
	for sample in channels.iter().flatten() {
		peak = peak.max(f64::from(sample.abs()));
		sum += f64::from(*sample).powi(2);
		count += 1;
	}
	(peak, (sum / count.max(1) as f64).sqrt())
}

fn corpus_files() -> Vec<std::path::PathBuf> {
	let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cases/3");
	let mut files: Vec<_> = std::fs::read_dir(dir)
		.expect("conformance/cases/3 exists")
		.map(|entry| entry.expect("a directory entry").path())
		.filter(|path| path.extension().is_some_and(|e| e == "json"))
		.collect();
	files.sort();
	files
}

#[test]
fn every_layer_3_score_renders_finite_samples() {
	let (mut rendered, mut refused, mut silent) = (0, Vec::new(), Vec::new());
	let mut summary = String::new();
	let mut loudest: (f64, String) = (0.0, String::new());
	for path in corpus_files() {
		let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("reads"))
			.expect("the corpus file is JSON");
		let group = file["group"].as_str().expect("group").to_string();
		for case in file["cases"].as_array().expect("cases") {
			let id = case["id"].as_str().expect("id");
			if case.get("error").is_some() || case.get("score").is_none() {
				continue;
			}
			let Some(result) = render_case(case) else {
				refused.push(id.to_string());
				continue;
			};
			let channels = &result.channels;
			assert!(
				channels.iter().flatten().all(|s| s.is_finite()),
				"{id}: a sample is not finite"
			);
			let (peak, rms) = stats(channels);
			assert!(peak < 64.0, "{id}: peak {peak} is out of any sane range");
			if peak == 0.0 {
				silent.push(id.to_string());
			}
			if peak > loudest.0 {
				loudest = (peak, id.to_string());
			}
			summary.push_str(&format!(
				"{group:<12} {id:<48} {:>2}ch {:>6.2}s peak {peak:>8.4} rms {rms:>8.4}\n",
				channels.len(),
				result.seconds
			));
			rendered += 1;
		}
	}
	println!("{summary}");
	println!(
		"rendered {rendered} cases; refused by the booking: {refused:?}; silent: {silent:?}; loudest: {} ({:.3})",
		loudest.1, loudest.0
	);
	assert!(rendered >= 150, "only {rendered} cases rendered");
	assert!(
		silent.len() * 10 < rendered,
		"too many silent renders: {silent:?}"
	);
}

/// The real-time factor of a 10 second stereo render: `cargo test --release -p undertone-engine --test
/// render_corpus -- --ignored --nocapture`. A dense score (a voice every 0.2 seconds, each through a filter,
/// the reverb and the delay, on a master bus) so the convolver, the delay, and the compressor all run.
#[test]
#[ignore = "a timing, not a test: run it by hand in a release build"]
fn real_time_factor_of_a_ten_second_stereo_render() {
	let patch = |note: &str, sound: &str| {
		format!(
			r#"{{"attack":0.01,"decay":0.1,"delayFeedback":0.4,"delayLevel":0.3,"delayTime":0.25,"duration":0.5,"filterCutoff":1800,"filterEnvAmount":2000,"filterAttack":0.01,"filterDecay":0.2,"filterSustain":0.3,"filterRelease":0.2,"gainLevel":0.4,"pitch":"{note}","release":0.2,"roomLevel":0.4,"roomSize":3,"soundType":"{sound}","sustain":0.6}}"#
		)
	};
	let notes = ["c3", "e3", "g3", "b3", "d4"];
	let score: Vec<Value> = (0..50)
		.map(|i| {
			let note = notes[i % notes.len()];
			let sound = ["sawtooth", "square", "triangle"][i % 3];
			let line = format!("v{i} @{} {}", i as f64 * 0.2, patch(note, sound));
			Value::String(line)
		})
		.collect();
	let case: Value = serde_json::json!({
		"score": score,
		"render": { "sampleRate": 48000, "channels": 2, "cps": 0.1, "cycles": 1, "tail": 0 }
	});
	let started = std::time::Instant::now();
	let result = render_case(&case).expect("the booking works");
	let elapsed = started.elapsed().as_secs_f64();
	let (peak, rms) = stats(&result.channels);
	println!(
		"rendered {:.1} s of stereo in {elapsed:.3} s: {:.1}x real time (peak {peak:.3}, rms {rms:.3})",
		result.seconds,
		result.seconds / elapsed
	);
}
