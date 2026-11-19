// Runs the layer 1 conformance corpus against the Rust pattern core and compares byte for byte
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Layer 1 of the corpus: each case is a program, some query spans, and the haps the TypeScript reference returned.
//!
//! **How haps are compared.** The Rust haps are sorted as the recorder sorts them, then written as the same compact JSON the corpus holds (`{"whole":[..],"part":[..],"value":..}`), and the two texts are compared as strings. Fractions are `n/d` text in lowest terms. Numbers are the text JavaScript prints, so a one-bit difference in a float, a different sign of zero, or a different layout (`1e-7` against `0.0000001`) is a failure. The corpus file's own number text is kept by the reader (`common/json.rs`) and never reparsed.
//!
//! **What is not covered** is listed in `NOT_COVERED` with the reason, and the test checks that list against what it finds, so a program cannot drop out silently.

mod common;

use common::interpret::{Failure, interpret};
use common::json::{self, Json};
use std::collections::BTreeMap;
use undertone_pattern::{Fraction, Hap, Span, Value, js};

/// Programs the spike does not implement, with the reason. Everything else must be equal.
const NOT_COVERED: &[(&str, &str)] = &[(
	"notes-chord-01",
	"chord() and voicing() need chord.ts (the chords group, RF-15)",
)];

fn corpus_path(group: &str) -> std::path::PathBuf {
	std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
		.join(format!("../../conformance/cases/1/{group}.json"))
}

/// A value as the corpus writes it: numbers JavaScript's way, object keys sorted.
fn encode_value(value: &Value) -> String {
	match value {
		Value::Num(n) => {
			if n.is_nan() {
				"{\"$num\":\"NaN\"}".into()
			} else if n.is_infinite() {
				format!(
					"{{\"$num\":\"{}Infinity\"}}",
					if *n < 0.0 { "-" } else { "" }
				)
			} else if *n == 0.0 && n.is_sign_negative() {
				"{\"$num\":\"-0\"}".into()
			} else {
				js::number_to_string(*n)
			}
		}
		Value::Str(s) => {
			let mut out = String::new();
			json::write_string(s, &mut out);
			out
		}
		Value::Bool(b) => b.to_string(),
		Value::Map(map) => {
			let fields: Vec<String> = map
				.iter()
				.map(|(k, v)| {
					let mut key = String::new();
					json::write_string(k, &mut key);
					format!("{key}:{}", encode_value(v))
				})
				.collect();
			format!("{{{}}}", fields.join(","))
		}
	}
}

fn encode_span(span: &Span) -> String {
	format!(
		"[\"{}\",\"{}\"]",
		span.begin.to_ratio_string(),
		span.end.to_ratio_string()
	)
}

fn encode_hap(hap: &Hap<Value>) -> String {
	let whole = hap.whole.as_ref().map_or("null".to_string(), encode_span);
	format!(
		"{{\"whole\":{whole},\"part\":{},\"value\":{}}}",
		encode_span(&hap.part),
		encode_value(&hap.value)
	)
}

/// Orders haps as the recorder does: part begin, part end, whole begin, whole end (none first), then the value's compact text.
fn sort_haps(haps: Vec<Hap<Value>>) -> Vec<Hap<Value>> {
	let mut keyed: Vec<(String, Hap<Value>)> = haps
		.into_iter()
		.map(|h| (encode_value(&h.value), h))
		.collect();
	keyed.sort_by(|(ka, a), (kb, b)| {
		a.part
			.begin
			.cmp(&b.part.begin)
			.then(a.part.end.cmp(&b.part.end))
			.then_with(|| match (&a.whole, &b.whole) {
				(Some(x), Some(y)) => x.begin.cmp(&y.begin).then(x.end.cmp(&y.end)),
				(None, None) => std::cmp::Ordering::Equal,
				(None, Some(_)) => std::cmp::Ordering::Less,
				(Some(_), None) => std::cmp::Ordering::Greater,
			})
			.then_with(|| ka.cmp(kb))
	});
	keyed.into_iter().map(|(_, h)| h).collect()
}

#[derive(Default)]
struct Tally {
	equal: usize,
	not_covered: usize,
	failed: Vec<String>,
	total: usize,
}

fn check_case(case: &Json) -> Result<bool, String> {
	let id = case.get("id").and_then(Json::as_str).unwrap();
	let program = case.get("program").unwrap();
	let built = interpret(program);
	if let Some(expected) = case.get("error").and_then(Json::as_str) {
		return match built {
			Err(Failure::Error(message)) if message == expected => Ok(true),
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
	let queries = case.get("queries").and_then(Json::as_arr).unwrap();
	let expected_haps = case.get("haps").and_then(Json::as_arr).unwrap();
	for (query, expected) in queries.iter().zip(expected_haps) {
		let q = query.as_arr().unwrap();
		let span = Span::new(
			Fraction::parse(q[0].as_str().unwrap()).unwrap(),
			Fraction::parse(q[1].as_str().unwrap()).unwrap(),
		);
		let actual: Vec<String> = sort_haps(pattern.query(span))
			.iter()
			.map(encode_hap)
			.collect();
		let wanted: Vec<String> = expected
			.as_arr()
			.unwrap()
			.iter()
			.map(Json::to_compact)
			.collect();
		if actual != wanted {
			let first = actual
				.iter()
				.zip(&wanted)
				.position(|(a, w)| a != w)
				.unwrap_or(actual.len().min(wanted.len()));
			return Err(format!(
				"{id}: query {} to {}: {} haps against {} recorded; first difference at hap {first}\n  recorded: {}\n  rust:     {}\n  program:  {}",
				q[0].as_str().unwrap(),
				q[1].as_str().unwrap(),
				actual.len(),
				wanted.len(),
				wanted.get(first).map_or("(none)", |s| s.as_str()),
				actual.get(first).map_or("(none)", |s| s.as_str()),
				program.to_compact()
			));
		}
	}
	if let Some(samples) = case.get("samples").and_then(Json::as_arr) {
		for sample in samples {
			let pair = sample.as_arr().unwrap();
			let t = Fraction::parse(pair[0].as_str().unwrap()).unwrap();
			let actual = pattern
				.sample_at(t)
				.map_or("null".to_string(), |v| encode_value(&v));
			let wanted = pair[1].to_compact();
			if actual != wanted {
				return Err(format!(
					"{id}: sample at {}: recorded {wanted}, rust {actual}\n  program:  {}",
					pair[0].as_str().unwrap(),
					program.to_compact()
				));
			}
		}
	}
	Ok(true)
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
				Ok(_) => tally.equal += 1,
				Err(message) if message.contains(": not covered: ") => {
					uncovered_seen.push(id.to_string());
					tally.not_covered += 1;
				}
				Err(message) => tally.failed.push(message),
			}
		}
	}
	let mut report = String::from("\nlayer 1 group        equal / total   not covered   failed\n");
	for (group, t) in &groups {
		report.push_str(&format!(
			"{group:<20} {:>5} / {:<5}   {:>11}   {:>6}\n",
			t.equal,
			t.total,
			t.not_covered,
			t.failed.len()
		));
	}
	let (equal, total): (usize, usize) = groups
		.values()
		.fold((0, 0), |(e, t), g| (e + g.equal, t + g.total));
	report.push_str(&format!("{:<20} {equal:>5} / {total:<5}\n", "all"));
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
