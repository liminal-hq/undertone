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

/// The greatest common divisor of two `u64`s by Stein's binary method: shifts and subtractions only, with no division, so it is several times faster than Euclid's algorithm on the small numbers a pattern's time is made of.
fn gcd_u64(mut a: u64, mut b: u64) -> u64 {
	if a == 0 {
		return b;
	}
	if b == 0 {
		return a;
	}
	let shift = (a | b).trailing_zeros();
	a >>= a.trailing_zeros();
	loop {
		b >>= b.trailing_zeros();
		if a > b {
			core::mem::swap(&mut a, &mut b);
		}
		b -= a;
		if b == 0 {
			return a << shift;
		}
	}
}

/// The greatest common divisor of two unsigned numbers, taking the `u64` path whenever both fit.
fn gcd(a: u128, b: u128) -> u128 {
	if (a | b) >> 64 == 0 {
		return u128::from(gcd_u64(a as u64, b as u64));
	}
	let (mut a, mut b) = (a, b);
	while b != 0 {
		(a, b) = (b, a % b);
	}
	a
}

/// The magnitude (exclusive) below which a numerator and a denominator take the typed fast path: any product or sum of two such numbers fits in an `i64`, so there is no overflow check and no 128-bit division.
const SMALL: u128 = 1 << 31;

/// Whether a fraction's numerator and denominator are both below [`SMALL`] in magnitude.
fn is_small(f: &Fraction) -> bool {
	(f.n.unsigned_abs() | f.d.unsigned_abs()) < SMALL
}

const OVERFLOW: &str = "Fraction overflow";

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
		if denominator == 1 {
			return Fraction { n: numerator, d: 1 };
		}
		let (n, d) = if denominator < 0 {
			(
				numerator.checked_neg().expect(OVERFLOW),
				denominator.checked_neg().expect(OVERFLOW),
			)
		} else {
			(numerator, denominator)
		};
		let g = gcd(n.unsigned_abs(), d.unsigned_abs()) as i128;
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
		if self.d == 1 {
			self.n
		} else if is_small(self) {
			i128::from((self.n as i64).div_euclid(self.d as i64))
		} else {
			self.n.div_euclid(self.d)
		}
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
	/// Knuth's method: only the gcd of the two denominators, and of the sum's numerator with it, is needed, because both operands are already in lowest terms.
	fn add(self, other: Fraction) -> Fraction {
		if self.d == 1 && other.d == 1 {
			return Fraction {
				n: self.n.checked_add(other.n).expect(OVERFLOW),
				d: 1,
			};
		}
		if is_small(&self) && is_small(&other) {
			// Typed fast path: every product below fits in an i64.
			let (a, b, c, d) = (self.n as i64, self.d as i64, other.n as i64, other.d as i64);
			let g = gcd_u64(b as u64, d as u64) as i64;
			if g == 1 {
				return Fraction {
					n: i128::from(a * d + c * b),
					d: i128::from(b * d),
				};
			}
			let (bg, dg) = (b / g, d / g);
			let t = a * dg + c * bg;
			let g2 = gcd_u64(t.unsigned_abs(), g as u64) as i64;
			return Fraction {
				n: i128::from(t / g2),
				d: i128::from(bg * (d / g2)),
			};
		}
		let g = gcd(self.d as u128, other.d as u128) as i128;
		let (bg, dg) = (self.d / g, other.d / g);
		let t = self
			.n
			.checked_mul(dg)
			.and_then(|x| other.n.checked_mul(bg).and_then(|y| x.checked_add(y)))
			.expect(OVERFLOW);
		let g2 = gcd(t.unsigned_abs(), g as u128) as i128;
		Fraction {
			n: t / g2,
			d: bg.checked_mul(other.d / g2).expect(OVERFLOW),
		}
	}
}

impl Sub for Fraction {
	type Output = Fraction;
	#[allow(clippy::suspicious_arithmetic_impl)] // subtraction is addition of the negation
	fn sub(self, other: Fraction) -> Fraction {
		self + Fraction {
			n: other.n.checked_neg().expect(OVERFLOW),
			d: other.d,
		}
	}
}

impl Mul for Fraction {
	type Output = Fraction;
	/// Cross-reduces first, so the products stay as small as possible and, both operands being in lowest terms, the result already is.
	fn mul(self, other: Fraction) -> Fraction {
		if self.n == 0 || other.n == 0 {
			return Fraction { n: 0, d: 1 };
		}
		if self.d == 1 && other.d == 1 {
			return Fraction {
				n: self.n.checked_mul(other.n).expect(OVERFLOW),
				d: 1,
			};
		}
		if is_small(&self) && is_small(&other) {
			let (a, b, c, d) = (self.n as i64, self.d as i64, other.n as i64, other.d as i64);
			let g1 = gcd_u64(a.unsigned_abs(), d as u64) as i64;
			let g2 = gcd_u64(c.unsigned_abs(), b as u64) as i64;
			return Fraction {
				n: i128::from((a / g1) * (c / g2)),
				d: i128::from((b / g2) * (d / g1)),
			};
		}
		let g1 = gcd(self.n.unsigned_abs(), other.d as u128) as i128;
		let g2 = gcd(other.n.unsigned_abs(), self.d as u128) as i128;
		Fraction {
			n: (self.n / g1).checked_mul(other.n / g2).expect(OVERFLOW),
			d: (self.d / g2).checked_mul(other.d / g1).expect(OVERFLOW),
		}
	}
}

impl Div for Fraction {
	type Output = Fraction;
	/// # Panics
	///
	/// Panics when dividing by zero, as the reference throws `Division by zero fraction`.
	fn div(self, other: Fraction) -> Fraction {
		assert!(other.n != 0, "Division by zero fraction");
		// The reciprocal of a fraction in lowest terms is in lowest terms; only the sign moves to the numerator.
		let recip = if other.n < 0 {
			Fraction {
				n: other.d.checked_neg().expect(OVERFLOW),
				d: -other.n,
			}
		} else {
			Fraction {
				n: other.d,
				d: other.n,
			}
		};
		self * recip
	}
}

impl PartialOrd for Fraction {
	fn partial_cmp(&self, other: &Fraction) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for Fraction {
	fn cmp(&self, other: &Fraction) -> Ordering {
		if self.d == other.d {
			return self.n.cmp(&other.n);
		}
		if is_small(self) && is_small(other) {
			return (self.n as i64 * other.d as i64).cmp(&(other.n as i64 * self.d as i64));
		}
		let left = self.n.checked_mul(other.d).expect(OVERFLOW);
		let right = other.n.checked_mul(self.d).expect(OVERFLOW);
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
	use alloc::string::ToString;

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

	/// A small deterministic generator, so the tests need no dependency.
	fn next(state: &mut u64) -> u64 {
		*state = state
			.wrapping_mul(6364136223846793005)
			.wrapping_add(1442695040888963407);
		*state >> 33
	}

	/// The operations, written the plain way (cross-multiply, then reduce with `new`), against the fast paths, over small, mid-sized, and large values.
	#[test]
	fn fast_paths_agree_with_the_plain_definitions() {
		let mut state = 7;
		for round in 0..20_000 {
			let bound: i128 = match round % 4 {
				0 => 12,
				1 => 3_000,
				2 => 1 << 30,
				_ => 1 << 40,
			};
			let mut pick = |positive: bool| {
				let v = i128::from(next(&mut state)) % bound;
				if positive { v + 1 } else { v - bound / 2 }
			};
			let (a, b, c, d) = (pick(false), pick(true), pick(false), pick(true));
			let (x, y) = (Fraction::new(a, b), Fraction::new(c, d));
			assert_eq!(x + y, Fraction::new(a * d + c * b, b * d), "{x} + {y}");
			assert_eq!(x - y, Fraction::new(a * d - c * b, b * d), "{x} - {y}");
			assert_eq!(x * y, Fraction::new(a * c, b * d), "{x} * {y}");
			if c != 0 {
				let want = Fraction::new(a * d, b * c);
				assert_eq!(x / y, want, "{x} / {y}");
			}
			assert_eq!(x.cmp(&y), (a * d).cmp(&(c * b)), "{x} cmp {y}");
			assert_eq!(x.floor(), a.div_euclid(b), "floor {x}");
			// Results are always in lowest terms with a positive denominator.
			for r in [x + y, x - y, x * y] {
				assert!(
					r.d > 0 && gcd(r.n.unsigned_abs(), r.d as u128) <= 1 || r.n == 0 && r.d == 1
				);
			}
		}
	}

	#[test]
	fn overflow_panics_and_never_wraps() {
		let big = Fraction::from_int(i128::MAX / 2 + 1);
		let result = std::panic::catch_unwind(|| big + big);
		assert!(result.is_err());
		let result = std::panic::catch_unwind(|| big * Fraction::from_int(2));
		assert!(result.is_err());
		let huge = Fraction::new(i128::MAX, 3);
		let result = std::panic::catch_unwind(|| huge * huge);
		assert!(result.is_err());
		let result = std::panic::catch_unwind(|| {
			Fraction::new(1, i128::MAX) + Fraction::new(1, i128::MAX - 1)
		});
		assert!(result.is_err());
	}
}
