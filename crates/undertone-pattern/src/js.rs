// The JavaScript number and string behaviour the reference depends on, reproduced exactly
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The JavaScript behaviours that the TypeScript reference's results depend on.
//!
//! The reference is written in JavaScript, so its output carries the language's rules: `Math.round` rounds halves toward positive infinity, numbers print with the shortest text that reads back the same (and switch to exponent form at fixed thresholds), `Number("...")` has its own grammar, `\s` matches a particular set of characters, and string positions count UTF-16 code units. Each of those is a function here, so the rest of the crate never guesses.

use crate::math;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

/// `Math.round`: the integer nearest to `x`, with halves rounding toward positive infinity (so `-2.5` gives `-2`, and `-0.4` gives negative zero).
///
/// ```
/// use undertone_pattern::js::round;
/// assert_eq!(round(2.5), 3.0);
/// assert_eq!(round(-2.5), -2.0);
/// assert_eq!(round(-1.5), -1.0);
/// assert!(round(-0.4).is_sign_negative());
/// ```
pub fn round(x: f64) -> f64 {
	if !x.is_finite() {
		return x;
	}
	let floor = math::floor(x);
	let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
	if rounded == 0.0 && x < 0.0 {
		-0.0
	} else {
		rounded
	}
}

/// `Number.isInteger`: true for a finite number with no fractional part.
///
/// ```
/// use undertone_pattern::js::is_integer;
/// assert!(is_integer(4.0));
/// assert!(!is_integer(1.5));
/// assert!(!is_integer(f64::INFINITY));
/// ```
pub fn is_integer(x: f64) -> bool {
	x.is_finite() && math::floor(x) == x
}

/// `String(x)` for a number: the shortest digits that read back as the same value, in JavaScript's layout.
///
/// Integers up to `1e21` print in full, small fractions down to `1e-6` print in full, and anything outside those bounds uses exponent form (`1e+21`, `1e-7`). Negative zero prints as `0`.
///
/// ```
/// use undertone_pattern::js::number_to_string;
/// assert_eq!(number_to_string(0.1 + 0.2), "0.30000000000000004");
/// assert_eq!(number_to_string(7.0), "7");
/// assert_eq!(number_to_string(1e21), "1e+21");
/// assert_eq!(number_to_string(1.5e-7), "1.5e-7");
/// assert_eq!(number_to_string(-0.0), "0");
/// assert_eq!(number_to_string(f64::NAN), "NaN");
/// ```
pub fn number_to_string(x: f64) -> String {
	if x.is_nan() {
		return "NaN".to_string();
	}
	if x == 0.0 {
		return "0".to_string();
	}
	if x.is_infinite() {
		return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
	}
	let sign = if x < 0.0 { "-" } else { "" };
	// Rust's `{:e}` writes the shortest digits that round-trip, as `d.ddde<exp>`.
	let scientific = alloc::format!("{:e}", x.abs());
	let (mantissa, exponent) = scientific
		.split_once('e')
		.expect("a float in exponent form has an `e`");
	let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
	let exponent: i32 = exponent.parse().expect("the exponent is an integer");
	let k = digits.len() as i32;
	// `n` is the position of the decimal point relative to the digits (ECMAScript's `n`).
	let n = exponent + 1;
	let body = if k <= n && n <= 21 {
		let mut text = digits.clone();
		for _ in 0..(n - k) {
			text.push('0');
		}
		text
	} else if 0 < n && n <= 21 {
		let (head, tail) = digits.split_at(n as usize);
		alloc::format!("{head}.{tail}")
	} else if -6 < n && n <= 0 {
		let mut text = String::from("0.");
		for _ in 0..(-n) {
			text.push('0');
		}
		text.push_str(&digits);
		text
	} else {
		let e = n - 1;
		let sign_e = if e < 0 { '-' } else { '+' };
		let (first, rest) = digits.split_at(1);
		if rest.is_empty() {
			alloc::format!("{first}e{sign_e}{}", e.abs())
		} else {
			alloc::format!("{first}.{rest}e{sign_e}{}", e.abs())
		}
	};
	alloc::format!("{sign}{body}")
}

/// Whether a UTF-16 code unit matches JavaScript's `\s` (and so what `String.prototype.trim` strips).
///
/// This is not Rust's `char::is_whitespace`: JavaScript includes U+FEFF and leaves out U+0085.
///
/// ```
/// use undertone_pattern::js::is_whitespace;
/// assert!(is_whitespace(0x00a0));
/// assert!(is_whitespace(0xfeff));
/// assert!(!is_whitespace(0x0085));
/// ```
pub fn is_whitespace(unit: u16) -> bool {
	matches!(
		unit,
		0x0009..=0x000d
			| 0x0020
			| 0x00a0
			| 0x1680
			| 0x2000..=0x200a
			| 0x2028
			| 0x2029
			| 0x202f
			| 0x205f
			| 0x3000
			| 0xfeff
	)
}

/// `String.prototype.trim`: removes JavaScript whitespace from both ends.
///
/// ```
/// use undertone_pattern::js::trim;
/// assert_eq!(trim("\u{a0} C4:major \n"), "C4:major");
/// ```
pub fn trim(text: &str) -> &str {
	let is_ws = |c: char| c.len_utf16() == 1 && is_whitespace(c as u32 as u16);
	text.trim_matches(is_ws)
}

/// The length of a string in UTF-16 code units, which is what JavaScript's `.length` and the reference's error positions count.
///
/// ```
/// use undertone_pattern::js::utf16_len;
/// assert_eq!(utf16_len("a b"), 3);
/// assert_eq!(utf16_len("a\u{1f3b5}"), 3);
/// ```
pub fn utf16_len(text: &str) -> usize {
	text.encode_utf16().count()
}

/// The UTF-16 code units of a string.
pub fn utf16_units(text: &str) -> Vec<u16> {
	text.encode_utf16().collect()
}

/// `Number(text)`: JavaScript's string-to-number conversion, `NaN` where the text is not a number.
///
/// Surrounding whitespace is ignored, the empty string is `0`, and `0x`, `0o`, and `0b` prefixes read hexadecimal, octal, and binary. Decimal text may have a sign, a fraction, and an exponent, and `Infinity` is a number. Numeric separators, `nan`, and `inf` are not.
///
/// ```
/// use undertone_pattern::js::string_to_number;
/// assert_eq!(string_to_number("1.5"), 1.5);
/// assert_eq!(string_to_number("  -3  "), -3.0);
/// assert_eq!(string_to_number("0x10"), 16.0);
/// assert_eq!(string_to_number("1e3"), 1000.0);
/// assert_eq!(string_to_number(""), 0.0);
/// assert!(string_to_number("..").is_nan());
/// assert!(string_to_number("inf").is_nan());
/// ```
pub fn string_to_number(text: &str) -> f64 {
	let text = trim(text);
	if text.is_empty() {
		return 0.0;
	}
	let bytes = text.as_bytes();
	if bytes.len() > 2 && bytes[0] == b'0' {
		let radix = match bytes[1] {
			b'x' | b'X' => Some(16),
			b'o' | b'O' => Some(8),
			b'b' | b'B' => Some(2),
			_ => None,
		};
		if let Some(radix) = radix {
			let mut value = 0.0_f64;
			for &b in &bytes[2..] {
				match (b as char).to_digit(radix) {
					Some(d) => value = value * f64::from(radix) + f64::from(d),
					None => return f64::NAN,
				}
			}
			return value;
		}
	}
	let (sign, unsigned) = match bytes[0] {
		b'-' => (-1.0, &text[1..]),
		b'+' => (1.0, &text[1..]),
		_ => (1.0, text),
	};
	if unsigned == "Infinity" {
		return sign * f64::INFINITY;
	}
	if is_decimal_literal(unsigned) {
		return match unsigned.parse::<f64>() {
			Ok(value) => sign * value,
			Err(_) => f64::NAN,
		};
	}
	f64::NAN
}

/// Whether `text` is an unsigned decimal literal: digits with an optional fraction, or a fraction alone, then an optional exponent.
fn is_decimal_literal(text: &str) -> bool {
	let bytes = text.as_bytes();
	let mut i = 0;
	let digits = |from: usize| {
		bytes[from..]
			.iter()
			.take_while(|b| b.is_ascii_digit())
			.count()
	};
	let int_digits = digits(i);
	i += int_digits;
	let mut frac_digits = 0;
	if i < bytes.len() && bytes[i] == b'.' {
		i += 1;
		frac_digits = digits(i);
		i += frac_digits;
	}
	if int_digits == 0 && frac_digits == 0 {
		return false;
	}
	if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
		i += 1;
		if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
			i += 1;
		}
		let exp_digits = digits(i);
		if exp_digits == 0 {
			return false;
		}
		i += exp_digits;
	}
	i == bytes.len()
}

/// Whether a character matches JavaScript's `.` (any character except a line terminator).
///
/// ```
/// use undertone_pattern::js::is_dot;
/// assert!(is_dot('a'));
/// assert!(!is_dot('\n'));
/// assert!(!is_dot('\u{2028}'));
/// ```
pub fn is_dot(c: char) -> bool {
	!matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rounds_halves_toward_positive_infinity() {
		assert_eq!(round(0.5), 1.0);
		assert_eq!(round(1.5), 2.0);
		assert_eq!(round(-0.5).to_bits(), (-0.0_f64).to_bits());
		assert_eq!(round(-1.5), -1.0);
		assert_eq!(round(2.4999), 2.0);
		assert_eq!(round(0.499_999_999_999_999_94), 0.0);
		assert_eq!(round(4_503_599_627_370_497.0), 4_503_599_627_370_497.0);
		assert!(round(f64::NAN).is_nan());
	}

	#[test]
	fn prints_numbers_as_javascript_does() {
		let cases: &[(f64, &str)] = &[
			(0.0, "0"),
			(1.0, "1"),
			(-1.5, "-1.5"),
			(100.0, "100"),
			(123456789012345680000.0, "123456789012345680000"),
			(1e21, "1e+21"),
			(1.2345e25, "1.2345e+25"),
			(0.000001, "0.000001"),
			(0.0000001, "1e-7"),
			(1.5e-7, "1.5e-7"),
			(0.1, "0.1"),
			(2.220446049250313e-16, "2.220446049250313e-16"),
			(261.6255653005986, "261.6255653005986"),
			(f64::INFINITY, "Infinity"),
			(f64::NEG_INFINITY, "-Infinity"),
			(5e-324, "5e-324"),
			(1.7976931348623157e308, "1.7976931348623157e+308"),
		];
		for (value, text) in cases {
			assert_eq!(number_to_string(*value), *text, "{value:e}");
		}
	}

	#[test]
	fn reads_numbers_as_javascript_does() {
		let cases: &[(&str, f64)] = &[
			("0", 0.0),
			("-0.5", -0.5),
			(".5", 0.5),
			("5.", 5.0),
			("+2", 2.0),
			("1e-2", 0.01),
			("0b101", 5.0),
			("0o17", 15.0),
			("Infinity", f64::INFINITY),
			("-Infinity", f64::NEG_INFINITY),
		];
		for (text, value) in cases {
			assert_eq!(string_to_number(text), *value, "{text}");
		}
		for text in [
			"-", ".", "..", "1.2.3", "e5", "0x", "1e", "nan", "inf", "0x1g", "- 1", "1_0",
		] {
			assert!(string_to_number(text).is_nan(), "{text}");
		}
	}

	#[test]
	fn trims_as_javascript_does() {
		assert_eq!(trim("\u{feff} a\u{3000}"), "a");
		assert_eq!(trim("\u{85}a"), "\u{85}a");
	}
}
