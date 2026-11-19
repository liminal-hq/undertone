// Runs the layer 2 conformance corpus: programs booked as voices and resolved to VoiceParams
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Layer 2 of the corpus: each case is a program booked over some whole cycles at a tempo, and the start time and
//! the complete resolved [`VoiceParams`] the TypeScript reference gave each onset.
//!
//! **What runs.** The program is built with the pattern crate's own interpreter (the one layer 1 uses, shared from
//! `undertone-pattern/tests/common`), queried one cycle at a time, and each onset is booked as the reference's
//! `collectOnsets` books it: the start time is the onset in cycles times the seconds a cycle lasts (`1 / cps`), and
//! the note's own length becomes the `duration` of a gated voice, or `duration * legato` for a `legato`, unless
//! the event sets its own. Then [`resolve_params`] fills in the voice.
//!
//! **How it is compared (decision D-23).** The result is written as JSON and compared with the recorded one as a value:
//! every key, string, and structure exactly, every number identical or within a relative `1e-14` or an absolute
//! `1e-15` near zero. A case that passed only through the tolerance is counted and named. A case that expects an
//! error must give the same message.
//!
//! **What is not covered** is listed in `NOT_COVERED`, per group, with the number of cases and the reason; the test
//! fails whenever a count changes, so nothing drops out of the run silently. The groups are found by listing
//! `conformance/cases/2/`.

#[allow(dead_code)]
#[path = "../../undertone-pattern/tests/common/mod.rs"]
mod common;

use common::interpret::{Failure, interpret};
use common::json::{self, Json};
use std::collections::BTreeMap;
use undertone_engine::params::resolve_params;
use undertone_pattern::{Fraction, Span, Value};

/// Cases per group that the run cannot build yet, with the reason. Every other case of every group must be equal.
const NOT_COVERED: &[(&str, usize, &str)] = &[];

/// The groups with their case counts, so a file that silently loses cases fails.
const KNOWN: &[(&str, usize)] = &[
	("controls", 58),
	("notes", 43),
	("signals", 20),
	("chords", 71),
	("drift", 81),
	("instruments", 31),
	("channels", 31),
];

const REL_TOLERANCE: f64 = 1e-14;
const ABS_FLOOR: f64 = 1e-15;

fn close(expected: f64, actual: f64) -> bool {
	if expected == actual {
		return true;
	}
	let diff = (expected - actual).abs();
	diff <= ABS_FLOOR || diff <= REL_TOLERANCE * expected.abs().max(actual.abs())
}

/// Compares two JSON values: everything exact except numbers, which may differ within the tolerance. `Ok(true)` means
/// some number needed the tolerance.
fn compare(expected: &Json, actual: &Json, path: &str) -> Result<bool, String> {
	match (expected, actual) {
		(Json::Num(et, ev), Json::Num(at, av)) => {
			if ev == av {
				Ok(false)
			} else if close(*ev, *av) {
				Ok(true)
			} else {
				Err(format!("{path}: recorded {et}, rust {at}"))
			}
		}
		(Json::Arr(e), Json::Arr(a)) => {
			if e.len() != a.len() {
				return Err(format!(
					"{path}: {} items recorded, {} from rust",
					e.len(),
					a.len()
				));
			}
			let mut approx = false;
			for (i, (x, y)) in e.iter().zip(a).enumerate() {
				approx |= compare(x, y, &format!("{path}[{i}]"))?;
			}
			Ok(approx)
		}
		(Json::Obj(e), Json::Obj(a)) => {
			let keys = |o: &[(String, Json)]| {
				let mut keys: Vec<String> = o.iter().map(|(k, _)| k.clone()).collect();
				keys.sort();
				keys
			};
			if keys(e) != keys(a) {
				return Err(format!(
					"{path}: fields {:?} recorded, {:?} from rust",
					keys(e),
					keys(a)
				));
			}
			let mut approx = false;
			for (k, x) in e {
				let y = a.iter().find(|(key, _)| key == k).map(|(_, v)| v).unwrap();
				approx |= compare(x, y, &format!("{path}.{k}"))?;
			}
			Ok(approx)
		}
		(e, a) if e == a => Ok(false),
		(e, a) => Err(format!(
			"{path}: recorded {}, rust {}",
			e.to_compact(),
			a.to_compact()
		)),
	}
}

/// The fields of a `ControlPatch` that are not `VoiceParams` fields: they reach a recorded object only when `n()` or
/// `chord()` is unresolved at play time.
const PATCH_ONLY_KEYS: [&str; 2] = ["degree", "chord"];

/// Books the onsets of one cycle as the reference's `collectOnsets` does: `(start seconds, the event's control map
/// with its gate length filled in)`.
fn collect_onsets(
	pattern: &common::interpret::Pat,
	cycle: i128,
	cycle_seconds: f64,
	gated: bool,
) -> Result<Vec<(f64, Value)>, String> {
	let span = Span::new(Fraction::from_int(cycle), Fraction::from_int(cycle + 1));
	let mut voices = Vec::new();
	let haps = pattern
		.try_query(span)
		.map_err(|e| e.message().to_string())?;
	for hap in haps {
		let Some(whole) = hap.whole else { continue };
		if whole.begin != hap.part.begin {
			continue; // a tail overlapping the window, not an onset
		}
		let start = whole.begin.to_f64() * cycle_seconds;
		let event_seconds = (whole.end - whole.begin).to_f64() * cycle_seconds;
		// An explicit duration wins; legato scales the event's own length and gates even a one-shot;
		// otherwise a gated span holds for the whole event. `{ duration, ...value }`: the value's own keys win.
		let legato = hap.value.get("legato").and_then(Value::as_number);
		let gate = match legato {
			Some(legato) => Some(event_seconds * legato),
			None if gated => Some(event_seconds),
			None => None,
		};
		let mut value = hap.value;
		if let (Some(gate), Value::Map(map)) = (gate, &mut value) {
			map.entry("duration".into()).or_insert(Value::Num(gate));
		}
		voices.push((start, value));
	}
	Ok(voices)
}

#[derive(Default)]
struct Tally {
	/// Cases equal, whether exactly or within the tolerance.
	equal: usize,
	tolerant: Vec<String>,
	not_covered: usize,
	failed: Vec<String>,
	total: usize,
	/// Resolved objects compared.
	objects: usize,
	/// Resolved objects that were `degree` or `chord` carriers (the key was left out of the comparison).
	with_patch_keys: usize,
}

/// Checks one case. `Ok(Some(objects))` is equal, with how many resolved objects it compared, and whether any needed the
/// tolerance; `Err("... not covered ...")` is a case the interpreter cannot build.
fn check_case(case: &Json) -> Result<(usize, bool, usize), String> {
	let id = case.get("id").and_then(Json::as_str).unwrap();
	let program = case.get("program").expect("a layer 2 case has a program");
	let built = interpret(program);
	if let Some(expected) = case.get("error").and_then(Json::as_str) {
		return match built {
			Err(Failure::Error(message)) if message == expected => Ok((0, false, 0)),
			Err(Failure::Uncovered(what)) => Err(format!("{id}: not covered: {what}")),
			Err(Failure::Error(message)) => Err(format!(
				"{id}: wrong error\n  expected: {expected}\n  actual:   {message}"
			)),
			Ok(pattern) => {
				// The program builds and the error comes when it is queried (a bad voicing anchor).
				let cycles = case.get("cycles").and_then(Json::as_arr).unwrap();
				let (first, end) = (
					cycles[0].as_f64().unwrap() as i128,
					cycles[1].as_f64().unwrap() as i128,
				);
				let cycle_seconds = 1.0 / case.get("cps").and_then(Json::as_f64).unwrap();
				let gated = matches!(case.get("gated"), Some(Json::Bool(true)));
				for cycle in first..end {
					match collect_onsets(&pattern, cycle, cycle_seconds, gated) {
						Err(message) if message == expected => return Ok((0, false, 0)),
						Err(message) => {
							return Err(format!(
								"{id}: wrong error\n  expected: {expected}\n  actual:   {message}"
							));
						}
						Ok(_) => {}
					}
				}
				Err(format!(
					"{id}: expected the error {expected:?} but the program built and booked"
				))
			}
		};
	}
	let pattern = match built {
		Ok(p) => p,
		Err(Failure::Uncovered(what)) => return Err(format!("{id}: not covered: {what}")),
		Err(Failure::Error(message)) => return Err(format!("{id}: unexpected error {message:?}")),
	};
	let cycles = case.get("cycles").and_then(Json::as_arr).unwrap();
	let (first, end) = (
		cycles[0].as_f64().unwrap() as i128,
		cycles[1].as_f64().unwrap() as i128,
	);
	let cps = case.get("cps").and_then(Json::as_f64).unwrap();
	let gated = matches!(case.get("gated"), Some(Json::Bool(true)));
	let cycle_seconds = 1.0 / cps;
	let mut actual = Vec::new();
	for cycle in first..end {
		actual.extend(
			collect_onsets(&pattern, cycle, cycle_seconds, gated)
				.map_err(|e| format!("{id}: unexpected error {e:?}"))?,
		);
	}
	let expected = case.get("events").and_then(Json::as_arr).unwrap();
	if actual.len() != expected.len() {
		return Err(format!(
			"{id}: {} voices from rust against {} recorded\n  program: {}",
			actual.len(),
			expected.len(),
			program.to_compact()
		));
	}
	let mut approx = false;
	let mut patch_keys = 0;
	for (i, ((start, value), event)) in actual.iter().zip(expected).enumerate() {
		let params = resolve_params(value);
		let text = serde_json::to_string(&params).expect("VoiceParams serialises");
		let rust_params = json::parse(&text).expect("serde_json writes JSON");
		let mut recorded = event.get("params").unwrap().clone();
		if let Json::Obj(fields) = &mut recorded {
			let before = fields.len();
			fields.retain(|(k, _)| !PATCH_ONLY_KEYS.contains(&k.as_str()));
			patch_keys += usize::from(fields.len() != before);
		}
		let rust_at = json::parse(&json_number(*start)).unwrap();
		let context = |what: &str, difference: String| {
			format!(
				"{id}: voice {i} {what}: {difference}\n  recorded: {}\n  rust:     {}\n  program:  {}",
				event.to_compact(),
				text,
				program.to_compact()
			)
		};
		match compare(event.get("at").unwrap(), &rust_at, "at") {
			Ok(differed) => approx |= differed,
			Err(difference) => return Err(context("start time", difference)),
		}
		match compare(&recorded, &rust_params, "params") {
			Ok(differed) => approx |= differed,
			Err(difference) => return Err(context("params", difference)),
		}
	}
	Ok((actual.len(), approx, patch_keys))
}

/// A number as JSON text, JavaScript's way.
fn json_number(n: f64) -> String {
	undertone_pattern::js::number_to_string(n)
}

#[test]
fn layer_two_corpus_is_equal() {
	let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cases/2");
	let mut names: Vec<String> = std::fs::read_dir(&dir)
		.expect("the corpus directory exists")
		.map(|e| e.unwrap().path())
		.filter(|p| p.extension().is_some_and(|x| x == "json"))
		.map(|p| p.file_stem().unwrap().to_string_lossy().into_owned())
		.collect();
	names.sort();
	let mut groups: BTreeMap<String, Tally> = BTreeMap::new();
	for group in &names {
		let text = std::fs::read_to_string(dir.join(format!("{group}.json")))
			.expect("the corpus file exists");
		let file = json::parse(&text).expect("the corpus file is JSON");
		assert_eq!(file.get("corpus").and_then(Json::as_f64), Some(1.0));
		assert_eq!(file.get("layer").and_then(Json::as_f64), Some(2.0));
		let tally = groups.entry(group.clone()).or_default();
		for case in file.get("cases").and_then(Json::as_arr).unwrap() {
			tally.total += 1;
			let id = case.get("id").and_then(Json::as_str).unwrap();
			match check_case(case) {
				Ok((objects, approx, patch_keys)) => {
					tally.equal += 1;
					tally.objects += objects;
					tally.with_patch_keys += patch_keys;
					if approx {
						tally.tolerant.push(id.to_string());
					}
				}
				Err(message) if message.contains(": not covered: ") => tally.not_covered += 1,
				Err(message) => tally.failed.push(message),
			}
		}
	}
	let mut report = String::from(
		"\nlayer 2 group        equal / total   exact   tolerance only   not covered   failed   objects\n",
	);
	let mut tolerant_ids = Vec::new();
	for (group, t) in &groups {
		report.push_str(&format!(
			"{group:<20} {:>5} / {:<5}   {:>5}   {:>14}   {:>11}   {:>6}   {:>7}\n",
			t.equal,
			t.total,
			t.equal - t.tolerant.len(),
			t.tolerant.len(),
			t.not_covered,
			t.failed.len(),
			t.objects
		));
		tolerant_ids.extend(t.tolerant.iter().cloned());
	}
	report.push_str(&format!(
		"passed only through the tolerance: {}\n",
		tolerant_ids.join(", ")
	));
	println!("{report}");
	let failures: Vec<&String> = groups.values().flat_map(|t| &t.failed).collect();
	assert!(
		failures.is_empty(),
		"{report}\n{}",
		failures
			.iter()
			.map(|s| s.as_str())
			.collect::<Vec<_>>()
			.join("\n\n")
	);
	let found: Vec<(&str, usize)> = groups
		.iter()
		.filter(|(_, t)| t.not_covered > 0)
		.map(|(g, t)| (g.as_str(), t.not_covered))
		.collect();
	let mut expected: Vec<(&str, usize)> = NOT_COVERED
		.iter()
		.filter(|(_, count, _)| *count > 0)
		.map(|(g, c, _)| (*g, *c))
		.collect();
	expected.sort();
	assert_eq!(found, expected, "the not-covered list changed\n{report}");
	for (group, size) in KNOWN {
		assert_eq!(
			groups.get(*group).map(|t| t.total),
			Some(*size),
			"the {group} group changed size"
		);
	}
	// The resolved objects of the first subset, all of them now that chord() runs.
	let objects = |group: &str| groups.get(group).map_or(0, |t| t.objects);
	assert_eq!(objects("controls"), 410);
	assert_eq!(objects("notes"), 289);
	assert_eq!(objects("signals"), 180);
}

// --- The comparison must not pass what is wrong ---

fn case_with(gain: &str, at: &str) -> Json {
	let params = format!(
		r#"{{"attack":0.01,"decay":0.1,"delayFeedback":0.35,"delayTime":0.3,"filterAttack":0,"filterDecay":0,"filterEnvAmount":0,"filterRelease":0,"filterSustain":1,"gainLevel":{gain},"nudgeTime":0,"release":0.05,"roomSize":3,"slideTime":0,"soundType":"sine","sustain":0}}"#
	);
	json::parse(&format!(
		r#"{{"id":"t","program":[["sound","sine"]],"cycles":[0,1],"cps":1,"gated":false,"events":[{{"at":{at},"params":{params}}}]}}"#
	))
	.unwrap()
}

#[test]
fn a_matching_case_passes_and_a_wrong_number_or_time_fails() {
	assert_eq!(check_case(&case_with("0.8", "0")), Ok((1, false, 0)));
	assert!(check_case(&case_with("0.800000001", "0")).is_err());
	assert!(check_case(&case_with("0.8", "0.5")).is_err());
}

#[test]
fn a_missing_voice_or_a_wrong_error_fails() {
	let mut case = case_with("0.8", "0");
	if let Json::Obj(fields) = &mut case {
		fields.retain(|(k, _)| k != "events");
		fields.push(("events".into(), Json::Arr(Vec::new())));
	}
	assert!(check_case(&case).is_err());
	let wrong_error = json::parse(
		r#"{"id":"t","program":[["note","c3"],["pan",3]],"cycles":[0,1],"cps":1,"gated":false,"error":"another message"}"#,
	)
	.unwrap();
	assert!(check_case(&wrong_error).is_err());
}
