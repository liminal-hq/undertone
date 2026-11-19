// Number printing for the layer 3 graph format: nine significant digits, written as JavaScript writes them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The recorder rounds every number it writes to nine significant digits (`Number(value.toPrecision(9))`) and
//! prints it with JavaScript's own number-to-text rules. This module does the same, without `std`'s float
//! printing choices getting in the way: Rust rounds a tie to even where `toPrecision` rounds it up, and Rust
//! never writes an exponent, where JavaScript does for numbers under `1e-6` and from `1e21`.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

/// The significant digits of a finite, positive, nonzero number, and where its decimal point goes: the value is
/// `0.d1d2d3... * 10^point`.
struct Decimal {
	digits: Vec<u8>,
	point: i32,
}

/// Splits `{:e}`-style text (`d.ddde<exp>`) into digits and a decimal point position.
fn split_scientific(text: &str) -> (Vec<u8>, i32) {
	let (mantissa, exponent) = text
		.split_once('e')
		.expect("scientific text has an exponent");
	let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
	let exponent: i32 = exponent.parse().expect("the exponent is an integer");
	(digits, exponent + 1)
}

fn strip_zeros(digits: &mut Vec<u8>) {
	while digits.len() > 1 && digits.last() == Some(&b'0') {
		digits.pop();
	}
}

/// The shortest digits that read back as the same `f64`, which is what JavaScript prints.
fn shortest(value: f64) -> Decimal {
	let (digits, point) = split_scientific(&format!("{value:e}"));
	Decimal { digits, point }
}

/// The value rounded to nine significant digits, a tie rounded up as `toPrecision` does.
fn nine(value: f64) -> Decimal {
	// Forty digits after the first are exact for any digit string that can matter to a tie.
	let (mut digits, mut point) = split_scientific(&format!("{value:.40e}"));
	let round_up = digits[9] >= b'5';
	digits.truncate(9);
	if round_up {
		let mut carry = true;
		for digit in digits.iter_mut().rev() {
			if *digit == b'9' {
				*digit = b'0';
			} else {
				*digit += 1;
				carry = false;
				break;
			}
		}
		if carry {
			digits.insert(0, b'1');
			digits.truncate(9);
			point += 1;
		}
	}
	strip_zeros(&mut digits);
	Decimal { digits, point }
}

/// Lays digits out as JavaScript's `Number::toString` does.
fn layout(negative: bool, decimal: &Decimal) -> String {
	let digits = core::str::from_utf8(&decimal.digits).expect("digits are ASCII");
	let k = digits.len() as i32;
	let n = decimal.point;
	let mut out = String::new();
	if negative {
		out.push('-');
	}
	if k <= n && n <= 21 {
		out.push_str(digits);
		out.extend(core::iter::repeat_n('0', (n - k) as usize));
	} else if 0 < n && n <= 21 {
		out.push_str(&digits[..n as usize]);
		out.push('.');
		out.push_str(&digits[n as usize..]);
	} else if -6 < n && n <= 0 {
		out.push_str("0.");
		out.extend(core::iter::repeat_n('0', (-n) as usize));
		out.push_str(digits);
	} else {
		let exponent = n - 1;
		out.push_str(&digits[..1]);
		if k > 1 {
			out.push('.');
			out.push_str(&digits[1..]);
		}
		out.push('e');
		out.push(if exponent < 0 { '-' } else { '+' });
		out.push_str(&format!("{}", exponent.abs()));
	}
	out
}

/// The text JavaScript's `String(Number(value.toPrecision(9)))` gives: `NaN`, `Infinity`, `-Infinity`, `-0`, and
/// otherwise the number at nine significant digits (`0.271240576`, `1e-7`, `44100`).
///
/// ```
/// use undertone_engine::graph::nine_digits_text;
///
/// assert_eq!(nine_digits_text(0.2712405763), "0.271240576");
/// assert_eq!(nine_digits_text(44100.0), "44100");
/// assert_eq!(nine_digits_text(1.0 / 3.0), "0.333333333");
/// assert_eq!(nine_digits_text(1.5e-7), "1.5e-7");
/// assert_eq!(nine_digits_text(-0.0), "-0");
/// ```
pub fn nine_digits_text(value: f64) -> String {
	if value.is_nan() {
		return String::from("NaN");
	}
	if value.is_infinite() {
		return String::from(if value > 0.0 { "Infinity" } else { "-Infinity" });
	}
	if value == 0.0 {
		return String::from(if value.is_sign_negative() { "-0" } else { "0" });
	}
	layout(value < 0.0, &nine(value.abs()))
}

/// A number as the corpus JSON holds it at nine digits: the same text as [`nine_digits_text`], except that the
/// values JSON cannot print become `{"$num":"NaN"}`, `{"$num":"Infinity"}`, `{"$num":"-Infinity"}`, and
/// `{"$num":"-0"}`.
///
/// ```
/// use undertone_engine::graph::nine_digits_json;
///
/// assert_eq!(nine_digits_json(0.15), "0.15");
/// assert_eq!(nine_digits_json(0.0), "0");
/// assert_eq!(nine_digits_json(-0.0), r#"{"$num":"-0"}"#);
/// ```
pub fn nine_digits_json(value: f64) -> String {
	if value.is_finite() && !(value == 0.0 && value.is_sign_negative()) {
		nine_digits_text(value)
	} else {
		format!("{{\"$num\":\"{}\"}}", nine_digits_text(value))
	}
}

/// A number with no rounding, as `JSON.stringify` writes it (sample rates and lengths): the shortest text that
/// reads back as the same `f64`.
pub(crate) fn exact_json(value: f64) -> String {
	if !value.is_finite() || value == 0.0 {
		return nine_digits_json(value);
	}
	layout(value < 0.0, &shortest(value.abs()))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rounds_to_nine_digits() {
		assert_eq!(nine_digits_text(0.271240576_3), "0.271240576");
		assert_eq!(nine_digits_text(0.654832678_9), "0.654832679");
		assert_eq!(nine_digits_text(123456789.4), "123456789");
		assert_eq!(nine_digits_text(0.3), "0.3");
		assert_eq!(nine_digits_text(0.1 + 0.2), "0.3");
	}

	#[test]
	fn a_carry_moves_the_point() {
		assert_eq!(nine_digits_text(0.999_999_999_6), "1");
		assert_eq!(nine_digits_text(9.999_999_999_6), "10");
		assert_eq!(nine_digits_text(999_999_999.6), "1000000000");
	}

	#[test]
	fn a_tie_rounds_up_as_to_precision_does() {
		// 123456789.5 is exact in binary: ten digits, a tie at nine.
		assert_eq!(nine_digits_text(123_456_789.5), "123456790");
		assert_eq!(nine_digits_text(-123_456_789.5), "-123456790");
	}

	#[test]
	fn exponents_follow_javascript() {
		assert_eq!(nine_digits_text(0.000_001), "0.000001");
		assert_eq!(nine_digits_text(0.000_000_1), "1e-7");
		assert_eq!(nine_digits_text(1.234_567_89e-9), "1.23456789e-9");
		assert_eq!(nine_digits_text(1e21), "1e+21");
		assert_eq!(nine_digits_text(1.5e22), "1.5e+22");
		assert_eq!(nine_digits_text(1e20), "100000000000000000000");
	}

	#[test]
	fn subnormals_print_the_shortest_text_that_reads_back() {
		// toPrecision(9) of 5e-324 is 4.94065646e-324, which Number() reads back as 5e-324, and String prints that.
		assert_eq!(nine_digits_text(5e-324), "5e-324");
		assert_eq!(nine_digits_text(1e-323), "1e-323");
		assert_eq!(nine_digits_text(1e-320), "1e-320");
		assert_eq!(nine_digits_text(-5e-324), "-5e-324");
		assert_eq!(nine_digits_json(5e-324), "5e-324");
	}

	#[test]
	fn special_values() {
		assert_eq!(nine_digits_text(f64::NAN), "NaN");
		assert_eq!(nine_digits_text(f64::INFINITY), "Infinity");
		assert_eq!(nine_digits_text(f64::NEG_INFINITY), "-Infinity");
		assert_eq!(nine_digits_json(f64::NAN), r#"{"$num":"NaN"}"#);
		assert_eq!(
			nine_digits_json(f64::NEG_INFINITY),
			r#"{"$num":"-Infinity"}"#
		);
		assert_eq!(nine_digits_json(-0.0), r#"{"$num":"-0"}"#);
		assert_eq!(nine_digits_json(0.0), "0");
	}

	#[test]
	fn exact_numbers_keep_every_digit() {
		assert_eq!(exact_json(44100.0), "44100");
		assert_eq!(exact_json(0.1 + 0.2), "0.30000000000000004");
		assert_eq!(exact_json(48000.0), "48000");
	}
}
