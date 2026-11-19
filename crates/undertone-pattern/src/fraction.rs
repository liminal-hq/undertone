// Exact rational cycle time on i128, in lowest terms
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Exact rational time on `i128`.

use crate::error::{Error, Result};
use crate::{js, math};
use alloc::string::String;
use core::cmp::Ordering;
use core::fmt;
use core::ops::{Add, Div, Mul, Sub};

fn gcd(mut a: i128, mut b: i128) -> i128 {
	while b != 0 {
		(a, b) = (b, a % b);
	}
	a
}

/// An exact rational number on `i128`, always in lowest terms with a positive denominator.
///
/// Pattern time is measured in cycles as fractions, so triplets and euclidean rhythms stay exact over any number of cycles. Arithmetic panics rather than wrapping if a value outgrows `i128`, which no pattern of realistic size reaches.
///
/// ```
/// use undertone_pattern::Fraction;
/// let third = Fraction::new(1, 3);
/// assert_eq!(third + third + third, Fraction::from_int(1));
/// assert_eq!(Fraction::new(2, -4), Fraction::new(-1, 2));
/// assert_eq!(Fraction::new(7, 4).floor(), 1);
/// ```
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Fraction {
	n: i128,
	d: i128,
}

impl Fraction {
	/// The fraction `numerator / denominator`, reduced, with the sign carried on the numerator.
	///
	/// # Panics
	///
	/// Panics when `denominator` is zero.
	pub fn new(numerator: i128, denominator: i128) -> Fraction {
		assert!(denominator != 0, "Fraction denominator cannot be 0");
		let (n, d) = if denominator < 0 {
			(-numerator, -denominator)
		} else {
			(numerator, denominator)
		};
		let g = gcd(n.abs(), d);
		let g = if g == 0 { 1 } else { g };
		Fraction { n: n / g, d: d / g }
	}

	/// The whole number `value` as a fraction.
	pub fn from_int(value: i128) -> Fraction {
		Fraction { n: value, d: 1 }
	}

	/// The numerator, in lowest terms.
	pub fn numerator(&self) -> i128 {
		self.n
	}

	/// The denominator, in lowest terms and always positive.
	pub fn denominator(&self) -> i128 {
		self.d
	}

	/// Converts a JavaScript number the way the reference's `Fraction.from` does.
	///
	/// Integers are exact. Any other finite number goes through the same continued-fraction approximation as the reference (exact for anything a person types, like `0.25` or `1.5`), so a factor such as `fast(0.75)` lands on the same fraction.
	///
	/// ```
	/// use undertone_pattern::Fraction;
	/// assert_eq!(Fraction::from_f64(0.75).unwrap(), Fraction::new(3, 4));
	/// assert_eq!(Fraction::from_f64(-1.5).unwrap(), Fraction::new(-3, 2));
	/// assert_eq!(Fraction::from_f64(f64::NAN).unwrap_err().message(), "Cannot convert NaN to a fraction");
	/// ```
	pub fn from_f64(value: f64) -> Result<Fraction> {
		if js::is_integer(value) {
			return Ok(Fraction::from_int(value as i128));
		}
		if !value.is_finite() {
			return Err(Error::new(alloc::format!(
				"Cannot convert {} to a fraction",
				js::number_to_string(value)
			)));
		}
		let sign = if value < 0.0 { -1.0 } else { 1.0 };
		let target = value.abs();
		let (mut h1, mut h2, mut k1, mut k2) = (1.0_f64, 0.0_f64, 0.0_f64, 1.0_f64);
		let mut rest = target;
		loop {
			let whole = math::floor(rest);
			let (next_h, next_k) = (whole * h1 + h2, whole * k1 + k2);
			(h2, k2) = (h1, k1);
			(h1, k1) = (next_h, next_k);
			rest = 1.0 / (rest - whole);
			if !((target - h1 / k1).abs() > target * f64::EPSILON && k1 < 1e9) {
				break;
			}
		}
		Ok(Fraction::new((sign * h1) as i128, k1 as i128))
	}

	/// The largest integer not greater than this value.
	pub fn floor(&self) -> i128 {
		self.n.div_euclid(self.d)
	}

	/// The start of the cycle this time falls in.
	pub fn sam(&self) -> Fraction {
		Fraction::from_int(self.floor())
	}

	/// The start of the next cycle.
	pub fn next_sam(&self) -> Fraction {
		Fraction::from_int(self.floor() + 1)
	}

	/// The position within the current cycle, in `[0, 1)`.
	pub fn cycle_pos(&self) -> Fraction {
		*self - self.sam()
	}

	/// This value as the nearest `f64`, computed as `numerator / denominator` the way the reference does.
	pub fn to_f64(&self) -> f64 {
		self.n as f64 / self.d as f64
	}

	/// The smaller of two fractions.
	pub fn min(self, other: Fraction) -> Fraction {
		if self <= other { self } else { other }
	}

	/// The larger of two fractions.
	pub fn max(self, other: Fraction) -> Fraction {
		if self >= other { self } else { other }
	}

	/// The corpus's text form: `n/d` in lowest terms, integers included (`4/1`, never `4`).
	///
	/// ```
	/// use undertone_pattern::Fraction;
	/// assert_eq!(Fraction::new(8, 2).to_ratio_string(), "4/1");
	/// assert_eq!(Fraction::new(1, 3).to_ratio_string(), "1/3");
	/// ```
	pub fn to_ratio_string(&self) -> String {
		alloc::format!("{}/{}", self.n, self.d)
	}

	/// Reads `n/d` or a bare integer, as the corpus's `queries` and `samples` write time.
	///
	/// ```
	/// use undertone_pattern::Fraction;
	/// assert_eq!(Fraction::parse("-3/2"), Some(Fraction::new(-3, 2)));
	/// assert_eq!(Fraction::parse("4"), Some(Fraction::from_int(4)));
	/// assert_eq!(Fraction::parse("x"), None);
	/// ```
	pub fn parse(text: &str) -> Option<Fraction> {
		match text.split_once('/') {
			Some((n, d)) => {
				let (n, d) = (n.parse::<i128>().ok()?, d.parse::<i128>().ok()?);
				(d != 0).then(|| Fraction::new(n, d))
			}
			None => text.parse::<i128>().ok().map(Fraction::from_int),
		}
	}
}

impl Add for Fraction {
	type Output = Fraction;
	fn add(self, other: Fraction) -> Fraction {
		let g = gcd(self.d, other.d);
		let scale = other.d / g;
		let other_scale = self.d / g;
		let n = self
			.n
			.checked_mul(scale)
			.and_then(|a| {
				other
					.n
					.checked_mul(other_scale)
					.and_then(|b| a.checked_add(b))
			})
			.expect("Fraction overflow");
		let d = self.d.checked_mul(scale).expect("Fraction overflow");
		Fraction::new(n, d)
	}
}

impl Sub for Fraction {
	type Output = Fraction;
	fn sub(self, other: Fraction) -> Fraction {
		self + Fraction {
			n: -other.n,
			d: other.d,
		}
	}
}

impl Mul for Fraction {
	type Output = Fraction;
	fn mul(self, other: Fraction) -> Fraction {
		// Cross-reduce first so the products stay as small as possible.
		let g1 = gcd(self.n.abs(), other.d).max(1);
		let g2 = gcd(other.n.abs(), self.d).max(1);
		let n = (self.n / g1)
			.checked_mul(other.n / g2)
			.expect("Fraction overflow");
		let d = (self.d / g2)
			.checked_mul(other.d / g1)
			.expect("Fraction overflow");
		Fraction::new(n, d)
	}
}

impl Div for Fraction {
	type Output = Fraction;
	/// # Panics
	///
	/// Panics when dividing by zero, as the reference throws `Division by zero fraction`.
	fn div(self, other: Fraction) -> Fraction {
		assert!(other.n != 0, "Division by zero fraction");
		self * Fraction::new(other.d, other.n)
	}
}

impl PartialOrd for Fraction {
	fn partial_cmp(&self, other: &Fraction) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for Fraction {
	fn cmp(&self, other: &Fraction) -> Ordering {
		let left = self.n.checked_mul(other.d).expect("Fraction overflow");
		let right = other.n.checked_mul(self.d).expect("Fraction overflow");
		left.cmp(&right)
	}
}

impl fmt::Display for Fraction {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		if self.d == 1 {
			write!(f, "{}", self.n)
		} else {
			write!(f, "{}/{}", self.n, self.d)
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reduces_and_signs() {
		assert_eq!(Fraction::new(6, 8), Fraction::new(3, 4));
		assert_eq!(Fraction::new(0, -5), Fraction::from_int(0));
		assert_eq!(Fraction::new(3, -6).denominator(), 2);
	}

	#[test]
	fn floors_toward_negative_infinity() {
		assert_eq!(Fraction::new(-1, 2).floor(), -1);
		assert_eq!(Fraction::new(-3, 2).sam(), Fraction::from_int(-2));
		assert_eq!(Fraction::new(-3, 2).cycle_pos(), Fraction::new(1, 2));
	}

	#[test]
	fn arithmetic_is_exact() {
		let a = Fraction::new(1, 6);
		let b = Fraction::new(1, 4);
		assert_eq!(a + b, Fraction::new(5, 12));
		assert_eq!(a - b, Fraction::new(-1, 12));
		assert_eq!(a * b, Fraction::new(1, 24));
		assert_eq!(a / b, Fraction::new(2, 3));
		assert!(a < b);
		assert_eq!(a.max(b), b);
	}

	#[test]
	fn converts_numbers_like_the_reference() {
		for (value, n, d) in [
			(0.5, 1, 2),
			(1.5, 3, 2),
			(0.25, 1, 4),
			(2.0, 2, 1),
			(0.1, 1, 10),
			(1.0 / 3.0, 1, 3),
			(-0.75, -3, 4),
		] {
			assert_eq!(
				Fraction::from_f64(value).unwrap(),
				Fraction::new(n, d),
				"{value}"
			);
		}
		assert!(Fraction::from_f64(f64::INFINITY).is_err());
	}

	#[test]
	fn prints_and_parses() {
		assert_eq!(Fraction::new(4, 1).to_string(), "4");
		assert_eq!(Fraction::new(-3, 2).to_string(), "-3/2");
		assert_eq!(Fraction::parse("1/0"), None);
	}
}
