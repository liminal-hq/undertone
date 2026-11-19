// Runs the `wav` conformance corpus: encode_wav against the bytes the TypeScript's encodeWav wrote
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The `wav` corpus (`conformance/cases/wav/wav.json`) is not a layer: a WAV file is bytes. Each case holds the
//! samples of every channel (32 bit floats, written as the doubles they are, with the corpus's `{"$num": ...}`
//! form for `NaN`, the infinities, and negative zero), the sample rate, the options, and either the bytes
//! `encodeWav` wrote, as hex, or the message of its error. Every case must be **byte for byte** equal: there is no
//! tolerance, because the encoder does integer arithmetic on the samples and the dither is a seeded integer
//! generator.

use serde_json::Value;
use std::path::Path;
use undertone_engine::wav::{BitDepth, WavOptions, encode_wav};
use undertone_pattern::random::Seed;

/// The cases the file must hold, so a file that silently loses cases fails.
const KNOWN_CASES: usize = 34;

/// A sample as written in the corpus.
fn sample(value: &Value) -> f32 {
	match value {
		Value::Number(n) => n.as_f64().expect("a number") as f32,
		Value::Object(map) => match map["$num"].as_str().expect("a special number") {
			"NaN" => f32::NAN,
			"Infinity" => f32::INFINITY,
			"-Infinity" => f32::NEG_INFINITY,
			"-0" => -0.0,
			other => panic!("special number {other}"),
		},
		other => panic!("sample {other}"),
	}
}

fn options(value: &Value) -> WavOptions {
	WavOptions {
		bit_depth: match value.get("bitDepth").and_then(Value::as_u64) {
			None | Some(16) => BitDepth::Sixteen,
			Some(24) => BitDepth::TwentyFour,
			Some(32) => BitDepth::ThirtyTwo,
			Some(other) => panic!("bit depth {other}"),
		},
		dither: value.get("dither").and_then(Value::as_bool),
		seed: value.get("seed").map(|seed| match seed.as_str() {
			Some(text) => Seed::Str(text.to_string()),
			None => Seed::Num(seed.as_f64().expect("a numeric seed")),
		}),
		channel_mask: value
			.get("channelMask")
			.map(|mask| mask.as_u64().expect("a mask") as u32),
	}
}

fn hex(bytes: &[u8]) -> String {
	bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn every_wav_case_is_byte_for_byte_equal() {
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cases/wav/wav.json");
	let file: Value =
		serde_json::from_str(&std::fs::read_to_string(&path).expect("the corpus reads"))
			.expect("the corpus is JSON");
	assert_eq!(file["format"], "wav");
	let cases = file["cases"].as_array().expect("cases");
	assert_eq!(cases.len(), KNOWN_CASES, "a case was added or lost");

	let mut failures = Vec::new();
	let (mut bytes_equal, mut errors_equal) = (0, 0);
	for case in cases {
		let id = case["id"].as_str().expect("id");
		let channels: Vec<Vec<f32>> = case["channels"]
			.as_array()
			.expect("channels")
			.iter()
			.map(|channel| {
				channel
					.as_array()
					.expect("samples")
					.iter()
					.map(sample)
					.collect()
			})
			.collect();
		let rate = case["sampleRate"].as_f64().expect("sampleRate");
		let actual = encode_wav(rate, &channels, &options(&case["options"]));
		match (case.get("bytes"), case.get("error"), actual) {
			(Some(expected), None, Ok(bytes)) => {
				if hex(&bytes) == expected.as_str().expect("hex") {
					bytes_equal += 1;
				} else {
					failures.push(format!(
						"{id}: bytes differ\n  recorded: {expected}\n  rust:     {}",
						hex(&bytes)
					));
				}
			}
			(None, Some(message), Err(error)) => {
				if error.message() == message.as_str().expect("message") {
					errors_equal += 1;
				} else {
					failures.push(format!(
						"{id}: error {:?}, recorded {message}",
						error.message()
					));
				}
			}
			(expected, recorded, actual) => failures.push(format!(
				"{id}: recorded bytes {expected:?} error {recorded:?}, rust {actual:?}"
			)),
		}
	}
	println!(
		"wav: {bytes_equal} byte-equal files and {errors_equal} equal errors of {KNOWN_CASES}"
	);
	assert!(
		failures.is_empty(),
		"wav differences:\n{}",
		failures.join("\n")
	);
}
