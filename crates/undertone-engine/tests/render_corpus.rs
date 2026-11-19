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

mod common;

use common::{render_case, stats};
use serde_json::Value;
use std::path::Path;

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
