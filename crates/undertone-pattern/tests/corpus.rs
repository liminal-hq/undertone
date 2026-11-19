// Runs the layer 1 conformance corpus against the Rust pattern core and compares structurally
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Layer 1 of the corpus: each case is a program, some query spans, and the haps the TypeScript reference returned.
//!
//! **How haps are compared (decision D-23).** The Rust haps are sorted as the recorder sorts them, written as the same compact JSON the corpus holds (`{"whole":[..],"part":[..],"value":..}`), and read back, so both sides are JSON values compared structurally. Fractions (`"n/d"` strings), other strings, structure, the number of haps, and the `whole` and `part` spans must be **exact**. A float equals the recorded one if it is identical (same text), or within a relative `1e-14`, or within an absolute `1e-15` near zero: the same floors as the layer 3 rule in CONFORMANCE.md. The engine's maths is `libm` everywhere, which can differ from JavaScriptCore in the last bit. Special values (`NaN`, the infinities, negative zero) are objects and must be exact. Every case that passes only through the tolerance is counted and listed in the report, so nothing hides.
//!
//! **What is not covered** is listed in `NOT_COVERED` with the reason, and the test checks that list against what it finds, so a program cannot drop out silently.

mod common;

use common::encode::{encode_hap, encode_value, sort_haps};
use common::interpret::{Failure, interpret};
use common::json::{self, Json};
use std::collections::BTreeMap;
use undertone_pattern::{Fraction, Span};

/// Programs the spike does not implement, with the reason. Everything else must be equal.
const NOT_COVERED: &[(&str, &str)] = &[(
	"notes-chord-01",
	"chord() and voicing() need chord.ts (the chords group, RF-15)",
)];

/// The relative tolerance of a float, as in the layer 3 rule.
const REL_TOLERANCE: f64 = 1e-14;
/// The absolute floor of a float near zero.
const ABS_FLOOR: f64 = 1e-15;

/// Whether two floats are identical or within the tolerance.
fn close(expected: f64, actual: f64) -> bool {
	if expected == actual {
		return true;
	}
	let diff = (expected - actual).abs();
	diff <= ABS_FLOOR || diff <= REL_TOLERANCE * expected.abs().max(actual.abs())
}

/// Compares two JSON values structurally. Everything is exact except numbers, which may differ within the tolerance.
///
/// Returns `Ok(true)` when some number differed and was accepted, `Ok(false)` when the values are identical, and the path of the first difference otherwise.
fn compare(expected: &Json, actual: &Json, path: &str) -> Result<bool, String> {
	match (expected, actual) {
		(Json::Num(et, ev), Json::Num(at, av)) => {
			if et == at {
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
			let keys = |o: &[(String, Json)]| o.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>();
			if keys(e) != keys(a) {
				return Err(format!(
					"{path}: fields {:?} recorded, {:?} from rust",
					keys(e),
					keys(a)
				));
			}
			let mut approx = false;
			for ((k, x), (_, y)) in e.iter().zip(a) {
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

fn corpus_path(group: &str) -> std::path::PathBuf {
	std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
		.join(format!("../../conformance/cases/1/{group}.json"))
}

#[derive(Default)]
struct Tally {
	/// Programs equal, whether exactly or within the tolerance.
	equal: usize,
	/// Of those, the ones that needed the tolerance, by id.
	tolerant: Vec<String>,
	not_covered: usize,
	failed: Vec<String>,
	total: usize,
}

/// Checks one case. `Ok(true)` means it passed only through the float tolerance.
fn check_case(case: &Json) -> Result<bool, String> {
	let id = case.get("id").and_then(Json::as_str).unwrap();
	let program = case.get("program").unwrap();
	let built = interpret(program);
	if let Some(expected) = case.get("error").and_then(Json::as_str) {
		return match built {
			Err(Failure::Error(message)) if message == expected => Ok(false),
			Err(Failure::Uncovered(what)) => Err(format!("{id}: not covered: {what}")),
			Err(Failure::Error(message)) => Err(format!(
				"{id}: wrong error\n  expected: {expected}\n  actual:   {message}"
			)),
			Ok(_) => Err(format!(
				"{id}: expected the error {expected:?} but the program built"
			)),
		};
	}
	let pattern = match built {
		Ok(p) => p,
		Err(Failure::Uncovered(what)) => return Err(format!("{id}: not covered: {what}")),
		Err(Failure::Error(message)) => return Err(format!("{id}: unexpected error {message:?}")),
	};
	let mut approx = false;
	let queries = case.get("queries").and_then(Json::as_arr).unwrap();
	let expected_haps = case.get("haps").and_then(Json::as_arr).unwrap();
	for (query, expected) in queries.iter().zip(expected_haps) {
		let q = query.as_arr().unwrap();
		let (from, to) = (q[0].as_str().unwrap(), q[1].as_str().unwrap());
		let span = Span::new(Fraction::parse(from).unwrap(), Fraction::parse(to).unwrap());
		let actual: Vec<Json> = sort_haps(pattern.query(span))
			.iter()
			.map(|h| json::parse(&encode_hap(h)).expect("encoded haps are JSON"))
			.collect();
		let wanted = expected.as_arr().unwrap();
		if actual.len() != wanted.len() {
			return Err(format!(
				"{id}: query {from} to {to}: {} haps from rust against {} recorded\n  program:  {}",
				actual.len(),
				wanted.len(),
				program.to_compact()
			));
		}
		for (i, (w, a)) in wanted.iter().zip(&actual).enumerate() {
			match compare(w, a, &format!("hap {i}")) {
				Ok(differed) => approx |= differed,
				Err(difference) => {
					return Err(format!(
						"{id}: query {from} to {to}: {difference}\n  recorded: {}\n  rust:     {}\n  program:  {}",
						w.to_compact(),
						a.to_compact(),
						program.to_compact()
					));
				}
			}
		}
	}
	if let Some(samples) = case.get("samples").and_then(Json::as_arr) {
		for sample in samples {
			let pair = sample.as_arr().unwrap();
			let t = Fraction::parse(pair[0].as_str().unwrap()).unwrap();
			let text = pattern
				.sample_at(t)
				.map_or("null".to_string(), |v| encode_value(&v));
			let actual = json::parse(&text).expect("encoded values are JSON");
			match compare(&pair[1], &actual, "sample") {
				Ok(differed) => approx |= differed,
				Err(difference) => {
					return Err(format!(
						"{id}: sample at {}: {difference}\n  program:  {}",
						pair[0].as_str().unwrap(),
						program.to_compact()
					));
				}
			}
		}
	}
	Ok(approx)
}

#[test]
fn layer_one_corpus_is_equal() {
	let mut groups: BTreeMap<String, Tally> = BTreeMap::new();
	let mut uncovered_seen = Vec::new();
	for group in ["core", "combinators", "notes", "controls", "signals"] {
		let text = std::fs::read_to_string(corpus_path(group)).expect("the corpus file exists");
		let file = json::parse(&text).expect("the corpus file is JSON");
		assert_eq!(file.get("corpus").and_then(Json::as_f64), Some(1.0));
		let tally = groups.entry(group.into()).or_default();
		for case in file.get("cases").and_then(Json::as_arr).unwrap() {
			tally.total += 1;
			let id = case.get("id").and_then(Json::as_str).unwrap();
			match check_case(case) {
				Ok(approx) => {
					tally.equal += 1;
					if approx {
						tally.tolerant.push(id.to_string());
					}
				}
				Err(message) if message.contains(": not covered: ") => {
					uncovered_seen.push(id.to_string());
					tally.not_covered += 1;
				}
				Err(message) => tally.failed.push(message),
			}
		}
	}
	let mut report = String::from(
		"\nlayer 1 group        equal / total   exact   tolerance only   not covered   failed\n",
	);
	let mut tolerant_ids = Vec::new();
	for (group, t) in &groups {
		report.push_str(&format!(
			"{group:<20} {:>5} / {:<5}   {:>5}   {:>14}   {:>11}   {:>6}\n",
			t.equal,
			t.total,
			t.equal - t.tolerant.len(),
			t.tolerant.len(),
			t.not_covered,
			t.failed.len()
		));
		tolerant_ids.extend(t.tolerant.iter().cloned());
	}
	let (equal, total): (usize, usize) = groups
		.values()
		.fold((0, 0), |(e, t), g| (e + g.equal, t + g.total));
	report.push_str(&format!(
		"{:<20} {equal:>5} / {total:<5}   {:>5}   {:>14}\n",
		"all",
		equal - tolerant_ids.len(),
		tolerant_ids.len()
	));
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
	let expected_uncovered: Vec<&str> = NOT_COVERED.iter().map(|(id, _)| *id).collect();
	assert_eq!(
		uncovered_seen
			.iter()
			.map(String::as_str)
			.collect::<Vec<_>>(),
		expected_uncovered,
		"the not-covered list changed"
	);
	assert_eq!(total, 309, "the corpus has 309 layer 1 programs");
}

// --- The tolerance must not hide real errors ---

fn j(text: &str) -> Json {
	json::parse(text).unwrap()
}

#[test]
fn the_tolerance_accepts_a_last_bit_difference() {
	let hap = |v: &str| {
		j(&format!(
			r#"{{"whole":["0/1","1/1"],"part":["0/1","1/1"],"value":{v}}}"#
		))
	};
	assert_eq!(
		compare(&hap("311.12698372208087"), &hap("311.1269837220809"), "h"),
		Ok(true)
	);
	assert_eq!(compare(&hap("0.5"), &hap("0.5"), "h"), Ok(false));
	// Near zero the absolute floor applies.
	assert_eq!(
		compare(
			&hap("2.220446049250313e-16"),
			&hap("-2.220446049250313e-16"),
			"h"
		),
		Ok(true)
	);
}

#[test]
fn the_tolerance_does_not_hide_real_errors() {
	let hap = |whole: &str, v: &str| {
		j(&format!(
			r#"{{"whole":["0/1","{whole}"],"part":["0/1","{whole}"],"value":{v}}}"#
		))
	};
	// A number off by 1e-9 fails.
	assert!(compare(&hap("1/1", "0.5"), &hap("1/1", "0.500000001"), "h").is_err());
	assert!(compare(&hap("1/1", "300"), &hap("1/1", "300.000001"), "h").is_err());
	// A tiny value that is wrong beyond the floor fails.
	assert!(compare(&hap("1/1", "0"), &hap("1/1", "1e-9"), "h").is_err());
	// A wrong fraction fails, even one that is numerically close.
	assert!(compare(&hap("1/1", "0.5"), &hap("2/1", "0.5"), "h").is_err());
	assert!(
		compare(
			&j(r#"["333333333333/1000000000000"]"#),
			&j(r#"["1/3"]"#),
			"f"
		)
		.is_err()
	);
	// A missing hap fails.
	assert!(compare(&j("[1,2]"), &j("[1]"), "haps").is_err());
	// A different string or a special value fails.
	assert!(compare(&j(r#""a""#), &j(r#""b""#), "v").is_err());
	assert!(compare(&j(r#"{"$num":"-0"}"#), &j("0"), "v").is_err());
	assert!(compare(&j("null"), &j("0"), "v").is_err());
}

/// A recorded case whose Rust haps differ by a real amount must make `check_case` fail, not pass.
#[test]
fn a_case_with_a_wrong_number_or_a_missing_hap_fails() {
	let case = |haps: &str| {
		j(&format!(
			r#"{{"id":"t","program":[["pure",0.5]],"queries":[["0","1"]],"haps":[{haps}]}}"#
		))
	};
	let good = r#"{"whole":["0/1","1/1"],"part":["0/1","1/1"],"value":0.5}"#;
	assert_eq!(check_case(&case(&format!("[{good}]"))), Ok(false));
	let off = r#"{"whole":["0/1","1/1"],"part":["0/1","1/1"],"value":0.500000001}"#;
	assert!(check_case(&case(&format!("[{off}]"))).is_err());
	assert!(check_case(&case(&format!("[{good},{good}]"))).is_err());
	assert!(check_case(&case("[]")).is_err());
}
