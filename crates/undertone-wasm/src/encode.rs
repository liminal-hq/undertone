// The flat hap encoding and the checked fraction conversions: plain Rust, no JavaScript, so it is tested natively
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! How haps and times cross the boundary as numbers (section 3 of `docs/rust-migration/results/M6-BOUNDARY.md`).
//!
//! A query's haps become one `Float64Array` of [`STRIDE`] numbers per hap, in the order the tree gives them:
//!
//! | Slot | Number |
//! | --- | --- |
//! | 0, 1 | part begin: numerator, denominator |
//! | 2, 3 | part end |
//! | 4, 5 | whole begin (both 0 when the hap has no whole) |
//! | 6, 7 | whole end (both 0 when the hap has no whole) |
//! | 8 | the index of the hap's value in the values array |
//!
//! A fraction whose numerator or denominator is beyond a JavaScript safe integer (|x| > 2^53 − 1, possible because the
//! pattern crate's fractions are `i128`, D-13) is written as `NaN` and the index of its exact `n/d` text in the list of
//! big fractions. A numerator is never `NaN` otherwise, and a denominator is never 0 otherwise, so both markers are
//! unambiguous.

use undertone::pattern::{Fraction, Hap, Span, Value, js};

/// Numbers per hap in the flat encoding.
pub const STRIDE: usize = 9;

/// The largest integer a JavaScript number holds exactly: 2^53 − 1 (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The bound on the fractions the exact-arithmetic helpers take (|x| < 2^63), so no sum or product of two of them can outgrow `i128` (and so none can panic).
pub const MAX_HELPER_PART: i128 = i64::MAX as i128;

/// Haps encoded for JavaScript: the numbers, the values (borrowed, by index), and the texts of big fractions.
#[derive(Debug, Default, PartialEq)]
pub struct Encoded<'a> {
	/// [`STRIDE`] numbers per hap.
	pub times: Vec<f64>,
	/// The value of each hap, by the index in slot 8.
	pub values: Vec<&'a Value>,
	/// The exact `n/d` texts of fractions beyond the safe range, by the index after a `NaN` numerator.
	pub big: Vec<String>,
}

fn fits(part: i128) -> bool {
	part.unsigned_abs() <= MAX_SAFE_INTEGER as u128
}

/// Whether a fraction crosses as two plain numbers.
pub fn is_safe(fraction: &Fraction) -> bool {
	fits(fraction.numerator()) && fits(fraction.denominator())
}

fn push_fraction(fraction: &Fraction, times: &mut Vec<f64>, big: &mut Vec<String>) {
	if is_safe(fraction) {
		times.push(fraction.numerator() as f64);
		times.push(fraction.denominator() as f64);
	} else {
		times.push(f64::NAN);
		times.push(big.len() as f64);
		big.push(fraction.to_ratio_string());
	}
}

/// Encodes haps in the flat layout.
pub fn encode(haps: &[Hap<Value>]) -> Encoded<'_> {
	let mut out = Encoded {
		times: Vec::with_capacity(haps.len() * STRIDE),
		values: Vec::with_capacity(haps.len()),
		big: Vec::new(),
	};
	for hap in haps {
		push_fraction(&hap.part.begin, &mut out.times, &mut out.big);
		push_fraction(&hap.part.end, &mut out.times, &mut out.big);
		match &hap.whole {
			Some(whole) => {
				push_fraction(&whole.begin, &mut out.times, &mut out.big);
				push_fraction(&whole.end, &mut out.times, &mut out.big);
			}
			None => out.times.extend_from_slice(&[0.0; 4]),
		}
		out.times.push(out.values.len() as f64);
		out.values.push(&hap.value);
	}
	out
}

/// A fraction from two JavaScript numbers: both safe integers (|x| ≤ 2^53 − 1), the denominator not 0.
pub fn fraction_from_parts(numerator: f64, denominator: f64) -> Result<Fraction, String> {
	let whole = |x: f64| js::is_integer(x) && x.abs() <= MAX_SAFE_INTEGER;
	if !whole(numerator) || !whole(denominator) || denominator == 0.0 {
		return Err(format!(
			"a time must be two safe integers with a denominator that is not 0, got {}/{}",
			js::number_to_string(numerator),
			js::number_to_string(denominator)
		));
	}
	Ok(Fraction::new(numerator as i128, denominator as i128))
}

/// A fraction from its text (`"n/d"` or `"n"`), for times beyond the safe range. Any `i128` but `i128::MIN` is taken (its negation would overflow).
pub fn fraction_from_text(text: &str) -> Result<Fraction, String> {
	let refuse = || format!("a time must be a fraction written n/d or n, got \"{text}\"");
	let part = |digits: &str| match digits.parse::<i128>() {
		Ok(i128::MIN) | Err(_) => Err(refuse()),
		Ok(x) => Ok(x),
	};
	match text.split_once('/') {
		Some((n, d)) => {
			let (n, d) = (part(n)?, part(d)?);
			if d == 0 {
				return Err(refuse());
			}
			Ok(Fraction::new(n, d))
		}
		None => Ok(Fraction::from_int(part(text)?)),
	}
}

/// A fraction from the two values a host query or sampler receives: plain numbers when the fraction is safe, else `NaN` and the text. Used to build the arguments of a callback (the decoded side is [`decode_part`]).
pub enum Part {
	/// Two safe integers.
	Numbers(f64, f64),
	/// `NaN` and the exact text.
	Text(String),
}

/// The callback form of a fraction: two numbers, or `NaN` and its text.
pub fn callback_part(fraction: &Fraction) -> Part {
	if is_safe(fraction) {
		Part::Numbers(fraction.numerator() as f64, fraction.denominator() as f64)
	} else {
		Part::Text(fraction.to_ratio_string())
	}
}

/// One fraction of a flat encoding that came from JavaScript (a host query's result): two numbers, or `NaN` and an index into `big`.
pub fn decode_part(numerator: f64, denominator: f64, big: &[String]) -> Result<Fraction, String> {
	if numerator.is_nan() {
		let index = index_of(denominator, big.len()).ok_or_else(|| {
			format!(
				"a big fraction's index {} is not in the list",
				js::number_to_string(denominator)
			)
		})?;
		return fraction_from_text(&big[index]);
	}
	fraction_from_parts(numerator, denominator)
}

fn index_of(slot: f64, len: usize) -> Option<usize> {
	(js::is_integer(slot) && slot >= 0.0 && slot < len as f64).then_some(slot as usize)
}

/// The haps of a flat encoding that came from JavaScript, with the values already converted. Every hap's slots are checked: a bad one is an error, never a panic.
pub fn decode(times: &[f64], values: &[Value], big: &[String]) -> Result<Vec<Hap<Value>>, String> {
	if !times.len().is_multiple_of(STRIDE) {
		return Err(format!(
			"a hap encoding has {STRIDE} numbers per hap, got {} numbers",
			times.len()
		));
	}
	let mut haps = Vec::with_capacity(times.len() / STRIDE);
	for row in times.as_chunks::<STRIDE>().0 {
		let part = Span::new(
			decode_part(row[0], row[1], big)?,
			decode_part(row[2], row[3], big)?,
		);
		let whole = if row[5] == 0.0 && row[7] == 0.0 && row[4] == 0.0 && row[6] == 0.0 {
			None
		} else {
			Some(Span::new(
				decode_part(row[4], row[5], big)?,
				decode_part(row[6], row[7], big)?,
			))
		};
		let index = index_of(row[8], values.len()).ok_or_else(|| {
			format!(
				"a hap's value index {} is not in the values ({} of them)",
				js::number_to_string(row[8]),
				values.len()
			)
		})?;
		haps.push(Hap {
			whole,
			part,
			value: values[index].clone(),
		});
	}
	Ok(haps)
}

/// The fraction `Fraction.from(value)` gives, as exact text: the reference's continued-fraction rule, through the pattern crate. Bounded at |x| < 2^63 so the conversion is exact and cannot overflow.
pub fn fraction_from_number(value: f64) -> Result<String, String> {
	if value.abs() >= MAX_HELPER_PART as f64 {
		return Err(format!(
			"fractionFromNumber() takes a number below 2^63 in size, got {}",
			js::number_to_string(value)
		));
	}
	Fraction::from_f64(value)
		.map(|f| f.to_ratio_string())
		.map_err(|e| e.message().into())
}

/// Exact arithmetic on two fraction texts, for the bridge's `Fraction` beyond 2^53 (B3): `add`, `sub`, `mul`, `div` give the result's text, `cmp` gives `-1`, `0`, or `1`. Each part must be below 2^63 in size, so the `i128` arithmetic cannot overflow.
pub fn fraction_op(op: &str, a: &str, b: &str) -> Result<String, String> {
	let read = |text: &str| -> Result<Fraction, String> {
		let f = fraction_from_text(text)?;
		if f.numerator().abs() > MAX_HELPER_PART || f.denominator() > MAX_HELPER_PART {
			return Err(format!(
				"fractionOp() takes fractions whose parts are below 2^63 in size, got {text}"
			));
		}
		Ok(f)
	};
	let (a, b) = (read(a)?, read(b)?);
	let result = match op {
		"add" => a + b,
		"sub" => a - b,
		"mul" => a * b,
		"div" if b.numerator() == 0 => return Err("Division by zero fraction".into()),
		"div" => a / b,
		"cmp" => {
			return Ok(String::from(match a.cmp(&b) {
				core::cmp::Ordering::Less => "-1",
				core::cmp::Ordering::Equal => "0",
				core::cmp::Ordering::Greater => "1",
			}));
		}
		_ => {
			return Err(format!(
				"fractionOp() has no operation \"{op}\"; use add, sub, mul, div, or cmp"
			));
		}
	};
	Ok(result.to_ratio_string())
}

#[cfg(test)]
mod tests {
	use super::*;
	use undertone::pattern::{pure, seq};

	fn span(a: (i128, i128), b: (i128, i128)) -> Span {
		Span::new(Fraction::new(a.0, a.1), Fraction::new(b.0, b.1))
	}

	#[test]
	fn haps_encode_nine_numbers_each_and_decode_back() {
		let p = seq(vec![pure(Value::Num(1.0)), pure(Value::Str("b".into()))]);
		let haps = p.query(span((1, 3), (7, 4)));
		let encoded = encode(&haps);
		assert_eq!(encoded.times.len(), haps.len() * STRIDE);
		assert!(encoded.big.is_empty());
		assert_eq!(
			&encoded.times[..STRIDE],
			&[1.0, 3.0, 1.0, 2.0, 0.0, 1.0, 1.0, 2.0, 0.0]
		);
		let values: Vec<Value> = encoded.values.iter().map(|v| (*v).clone()).collect();
		assert_eq!(decode(&encoded.times, &values, &encoded.big).unwrap(), haps);
	}

	#[test]
	fn a_hap_with_no_whole_has_zero_denominators() {
		let haps = [Hap {
			whole: None,
			part: span((0, 1), (1, 2)),
			value: Value::Num(-0.0),
		}];
		let encoded = encode(&haps);
		assert_eq!(&encoded.times[4..8], &[0.0; 4]);
		let decoded = decode(&encoded.times, &[Value::Num(-0.0)], &[]).unwrap();
		assert_eq!(decoded[0].whole, None);
	}

	#[test]
	fn a_big_fraction_crosses_as_text() {
		let big = Fraction::new(1 << 60, 3);
		let haps = [Hap {
			whole: Some(Span::new(Fraction::from_int(0), big)),
			part: Span::new(Fraction::from_int(0), big),
			value: Value::Bool(true),
		}];
		let encoded = encode(&haps);
		assert!(encoded.times[2].is_nan());
		assert_eq!(encoded.times[3], 0.0);
		assert_eq!(
			encoded.big,
			["1152921504606846976/3", "1152921504606846976/3"]
		);
		assert_eq!(encoded.times[7], 1.0);
		let decoded = decode(&encoded.times, &[Value::Bool(true)], &encoded.big).unwrap();
		assert_eq!(decoded, haps);
		// The boundary itself: 2^53 − 1 is safe, 2^53 is not.
		assert!(is_safe(&Fraction::from_int((1 << 53) - 1)));
		assert!(!is_safe(&Fraction::from_int(1 << 53)));
	}

	#[test]
	fn bad_encodings_are_errors_not_panics() {
		assert!(
			decode(&[0.0; 8], &[], &[])
				.unwrap_err()
				.contains("9 numbers per hap")
		);
		let row = [0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 3.0];
		assert!(
			decode(&row, &[Value::Num(1.0)], &[])
				.unwrap_err()
				.contains("value index 3")
		);
		let zero = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0];
		assert!(
			decode(&zero, &[Value::Num(1.0)], &[])
				.unwrap_err()
				.contains("got 0/0")
		);
		let nan = [f64::NAN, 5.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0];
		assert!(
			decode(&nan, &[Value::Num(1.0)], &[])
				.unwrap_err()
				.contains("index 5")
		);
		let half = [0.5, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0];
		assert!(decode(&half, &[Value::Num(1.0)], &[]).is_err());
	}

	#[test]
	fn times_from_numbers_and_texts_are_checked() {
		assert_eq!(
			fraction_from_parts(2.0, -4.0).unwrap(),
			Fraction::new(-1, 2)
		);
		assert_eq!(
			fraction_from_parts(1.0, 0.0).unwrap_err(),
			"a time must be two safe integers with a denominator that is not 0, got 1/0"
		);
		assert!(fraction_from_parts(f64::NAN, 1.0).is_err());
		assert!(fraction_from_parts(9_007_199_254_740_992.0, 1.0).is_err());
		assert_eq!(fraction_from_text("-3/2").unwrap(), Fraction::new(-3, 2));
		assert_eq!(fraction_from_text("4").unwrap(), Fraction::from_int(4));
		assert!(fraction_from_text("1/0").is_err());
		assert!(fraction_from_text("x").is_err());
		assert!(fraction_from_text(&i128::MIN.to_string()).is_err());
	}

	#[test]
	fn the_helpers_do_exact_arithmetic_without_overflow() {
		assert_eq!(fraction_op("add", "1/3", "1/6").unwrap(), "1/2");
		assert_eq!(fraction_op("sub", "1/3", "1/2").unwrap(), "-1/6");
		assert_eq!(fraction_op("mul", "2/3", "9/4").unwrap(), "3/2");
		assert_eq!(fraction_op("div", "1/3", "-1/3").unwrap(), "-1/1");
		assert_eq!(fraction_op("cmp", "1/3", "1/2").unwrap(), "-1");
		assert_eq!(
			fraction_op("div", "1", "0").unwrap_err(),
			"Division by zero fraction"
		);
		// Beyond 2^53, exactly: (2^53 + 1) + 1.
		assert_eq!(
			fraction_op("add", "9007199254740993", "1").unwrap(),
			"9007199254740994/1"
		);
		// The largest parts allowed cannot overflow.
		let max = i64::MAX.to_string();
		let min = format!("-{max}");
		assert!(fraction_op("mul", &max, &max).is_ok());
		assert!(fraction_op("sub", &min, &max).is_ok());
		assert!(fraction_op("add", &format!("1/{max}"), &format!("1/{}", i64::MAX - 1)).is_ok());
		assert!(fraction_op("add", "9223372036854775808", "1").is_err());
		assert!(fraction_op("pow", "1", "1").is_err());
		assert_eq!(fraction_from_number(0.75).unwrap(), "3/4");
		assert_eq!(
			fraction_from_number(f64::NAN).unwrap_err(),
			"Cannot convert NaN to a fraction"
		);
		assert!(fraction_from_number(1e300).is_err());
	}
}
