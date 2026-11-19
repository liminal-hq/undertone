// Writes haps and values as the corpus does, so Rust output can be compared as text
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The recorder's encoding of values and haps (`conformance/recorder/format.ts`), and its sort order.

#![allow(dead_code)]

use super::json;
use undertone_pattern::{Hap, Span, Value, js};

/// A value as the corpus writes it: numbers JavaScript's way, object keys sorted.
pub fn encode_value(value: &Value) -> String {
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

pub fn encode_span(span: &Span) -> String {
	format!(
		"[\"{}\",\"{}\"]",
		span.begin.to_ratio_string(),
		span.end.to_ratio_string()
	)
}

pub fn encode_hap(hap: &Hap<Value>) -> String {
	let whole = hap.whole.as_ref().map_or("null".to_string(), encode_span);
	format!(
		"{{\"whole\":{whole},\"part\":{},\"value\":{}}}",
		encode_span(&hap.part),
		encode_value(&hap.value)
	)
}

/// Orders haps as the recorder does: part begin, part end, whole begin, whole end (none first), then the value's compact text.
pub fn sort_haps(haps: Vec<Hap<Value>>) -> Vec<Hap<Value>> {
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
