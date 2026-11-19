// Round-trips every resolved voice parameter object of the layer 2 corpus through VoiceParams
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Layer 2 of the conformance corpus records, for each booked event, the complete `VoiceParams` after the
//! reference's `resolveParams`. Each of those objects must parse into [`VoiceParams`] and serialise back
//! to the same JSON: every key exactly, every non-number exactly, and numbers by the D-23 float rule
//! (within 1e-14 relative or 1e-15 absolute).
//!
//! The only keys removed first are `degree` and `chord`: they are `ControlPatch` fields, not
//! `VoiceParams` fields, and they only appear in a recorded object when a pattern reaches play time with
//! `n()` or `chord()` unresolved (the reference's spread passes them through).

use std::path::PathBuf;

use serde_json::Value;
use undertone_engine::params::VoiceParams;

const GROUPS: [&str; 3] = ["controls", "notes", "signals"];
const PATCH_ONLY_KEYS: [&str; 2] = ["degree", "chord"];

fn corpus_file(group: &str) -> Value {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../../conformance/cases/2")
		.join(format!("{group}.json"));
	let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
	serde_json::from_str(&text).expect("the corpus file is JSON")
}

/// Compares two JSON values: numbers by the D-23 rule, everything else exactly.
fn same(a: &Value, b: &Value) -> bool {
	match (a, b) {
		(Value::Number(x), Value::Number(y)) => {
			let (x, y) = (x.as_f64().expect("f64"), y.as_f64().expect("f64"));
			let diff = (x - y).abs();
			diff <= 1e-15 || diff <= 1e-14 * x.abs().max(y.abs())
		}
		(Value::Array(x), Value::Array(y)) => {
			x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
		}
		(Value::Object(x), Value::Object(y)) => {
			x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| same(p, q)))
		}
		_ => a == b,
	}
}

#[test]
fn every_layer_2_resolved_object_round_trips() {
	let mut total = 0usize;
	let mut with_patch_keys = 0usize;
	for group in GROUPS {
		let file = corpus_file(group);
		let mut in_group = 0usize;
		for case in file["cases"].as_array().expect("cases") {
			let id = case["id"].as_str().expect("id");
			for event in case
				.get("events")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
			{
				let mut object = event["params"].clone();
				let map = object.as_object_mut().expect("params is an object");
				for key in PATCH_ONLY_KEYS {
					if map.remove(key).is_some() {
						with_patch_keys += 1;
					}
				}
				let parsed: VoiceParams = serde_json::from_value(object.clone())
					.unwrap_or_else(|e| panic!("{id}: {e}: {object}"));
				let back = serde_json::to_value(&parsed).expect("serialises");
				assert!(same(&object, &back), "{id}: {object} came back as {back}");
				in_group += 1;
			}
		}
		assert!(in_group > 0, "group {group} has no resolved objects");
		total += in_group;
		println!("layer 2 {group}: {in_group} resolved objects round-trip");
	}
	println!("total {total} (of which {with_patch_keys} carried degree or chord)");
	assert_eq!(total, 879);
}

/// No layer 2 case runs without controls (every case starts from `note`, `sound`, or `s`), so `empty()` is
/// checked through the first `controls` case, `note("c3 e3 g3 e3").gain(0.5)`: undo the two things it set and
/// what remains is the reference's `DEFAULT_PARAMS`.
#[test]
fn empty_is_what_the_first_corpus_case_resolves_to_without_its_controls() {
	let file = corpus_file("controls");
	let case = &file["cases"][0];
	assert_eq!(case["id"], "controls-gain-number-01");
	let mut params: VoiceParams =
		serde_json::from_value(case["events"][0]["params"].clone()).expect("parses");
	assert_eq!(params.gain_level, 0.5);
	params.gain_level = 0.8;
	params.pitch = None;
	assert_eq!(params, VoiceParams::empty());
}
