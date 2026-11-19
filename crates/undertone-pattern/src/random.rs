// Seeded random sources: FNV-1a string hashing and the mulberry32 generator, as the reference writes them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Seeded randomness that is a pure function of its seed.
//!
//! The reference hashes a string seed with FNV-1a over its UTF-16 code units and runs mulberry32 from the hash; a random signal's value at an instant is the first output for the seed string `"<seed>|<kind>|<n>/<d>"`. Nothing here reads a clock or global state, so a value never depends on query order, windows, or threads.

use crate::fraction::Fraction;
use crate::js;
use alloc::string::String;

/// The seed of a random signal: a number or a string, formatted into the key the way JavaScript's template string does.
#[derive(Clone, Debug, PartialEq)]
pub enum Seed {
	/// A number (`7` formats as `7`, `1.5` as `1.5`, `-0` as `0`, and `NaN` as `NaN`, as a template string does).
	Num(f64),
	/// Any string.
	Str(String),
}

impl Seed {
	/// The text a template string `${seed}` gives.
	pub fn key_text(&self) -> String {
		match self {
			Seed::Num(n) => js::number_to_string(*n),
			Seed::Str(s) => s.clone(),
		}
	}
}

impl From<f64> for Seed {
	fn from(seed: f64) -> Seed {
		Seed::Num(seed)
	}
}

impl From<&str> for Seed {
	fn from(seed: &str) -> Seed {
		Seed::Str(seed.into())
	}
}

impl From<String> for Seed {
	fn from(seed: String) -> Seed {
		Seed::Str(seed)
	}
}

/// FNV-1a over UTF-16 code units: the hash of a string seed. It takes code units, not `char`s, because JavaScript strings can hold a lone surrogate half that a Rust string cannot.
///
/// ```
/// use undertone_pattern::random::fnv1a_utf16;
/// assert_eq!(fnv1a_utf16([0x61u16]), 0xe40c292c);
/// // A lone surrogate hashes as the one code unit it is.
/// assert_ne!(fnv1a_utf16([0xd83du16]), fnv1a_utf16([0xfffdu16]));
/// ```
pub fn fnv1a_utf16(units: impl IntoIterator<Item = u16>) -> u32 {
	let mut hash: u32 = 0x811c_9dc5;
	for unit in units {
		hash ^= u32::from(unit);
		hash = hash.wrapping_mul(0x0100_0193);
	}
	hash
}

/// FNV-1a over the UTF-16 code units of `text`: a stable string hash that does not depend on the platform.
///
/// ```
/// use undertone_pattern::random::fnv1a;
/// assert_eq!(fnv1a(""), 0x811c9dc5);
/// assert_eq!(fnv1a("a"), 0xe40c292c);
/// // An emoji is two UTF-16 code units, so it hashes as two.
/// assert_eq!(fnv1a("\u{1F600}"), undertone_pattern::random::fnv1a_utf16([0xd83d, 0xde00]));
/// ```
pub fn fnv1a(text: &str) -> u32 {
	fnv1a_utf16(text.encode_utf16())
}

/// JavaScript's `value >>> 0`: the number truncated toward zero and wrapped into `0..2^32`. `NaN`, the infinities, and negative zero all become 0.
///
/// ```
/// use undertone_pattern::random::to_uint32;
/// assert_eq!(to_uint32(-1.0), 4_294_967_295);
/// assert_eq!(to_uint32(4_294_967_297.0), 1);
/// assert_eq!(to_uint32(2.999), 2);
/// assert_eq!(to_uint32(-1.5), 4_294_967_295);
/// assert_eq!(to_uint32(f64::NAN), 0);
/// assert_eq!(to_uint32(f64::NEG_INFINITY), 0);
/// assert_eq!(to_uint32(-0.0), 0);
/// ```
pub fn to_uint32(value: f64) -> u32 {
	if !value.is_finite() {
		return 0;
	}
	// `%` on doubles is the exact remainder (JavaScript's `%`), so a huge integer wraps without losing bits. The result is below 2^32 in size, so the cast truncates toward zero without saturating.
	let wrapped = (value % 4_294_967_296.0) as i64;
	wrapped.rem_euclid(4_294_967_296) as u32
}

/// A seeded random generator (mulberry32): the same seed gives the same numbers on every device, independent of any other random source.
///
/// It is the reference's `seededRandom`. Build one with [`seeded_random`] or the `from_` constructors; take numbers with [`SeededRandom::next_value`] or as an [`Iterator`] that never ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeededRandom {
	state: u32,
}

impl SeededRandom {
	/// A generator for a numeric or string seed: a number goes through `seed >>> 0`, a string is hashed with FNV-1a.
	pub fn from_seed(seed: &Seed) -> SeededRandom {
		match seed {
			Seed::Num(n) => SeededRandom::from_number(*n),
			Seed::Str(s) => SeededRandom::from_text(s),
		}
	}

	/// A generator for a numeric seed (`seed >>> 0`: fractions truncate, negatives wrap, `NaN` and the infinities are 0).
	pub fn from_number(seed: f64) -> SeededRandom {
		SeededRandom {
			state: to_uint32(seed),
		}
	}

	/// A generator for a string seed.
	pub fn from_text(seed: &str) -> SeededRandom {
		SeededRandom { state: fnv1a(seed) }
	}

	/// A generator for a string seed given as UTF-16 code units, which may hold a lone surrogate half (a JavaScript string can; a Rust string cannot).
	pub fn from_utf16(seed: &[u16]) -> SeededRandom {
		SeededRandom {
			state: fnv1a_utf16(seed.iter().copied()),
		}
	}

	/// The next number, uniform in `[0, 1)`.
	pub fn next_value(&mut self) -> f64 {
		self.state = self.state.wrapping_add(0x6d2b_79f5);
		let mut t = self.state;
		t = (t ^ (t >> 15)).wrapping_mul(t | 1);
		t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
		f64::from(t ^ (t >> 14)) / 4_294_967_296.0
	}
}

impl Iterator for SeededRandom {
	type Item = f64;

	fn next(&mut self) -> Option<f64> {
		Some(self.next_value())
	}
}

/// A seeded random generator, as the reference's `seededRandom(seed)`.
///
/// A number seed goes through `seed >>> 0`; a string seed is hashed with FNV-1a over its UTF-16 code units. The first values for seed 0 are the reference's (see the `random` corpus group, which compares 64 values of 103 seeds).
///
/// ```
/// use undertone_pattern::random::seeded_random;
/// let mut a = seeded_random(0.0);
/// assert_eq!(a.next_value(), 0.26642920868471265);
/// assert_eq!(a.next_value(), 0.0003297457005828619);
/// // The same seed repeats; a string seed is a different stream.
/// assert_eq!(seeded_random(0.0).next_value(), 0.26642920868471265);
/// assert_ne!(seeded_random("0").next_value(), 0.26642920868471265);
/// // 2^32 + 1 wraps to 1.
/// assert_eq!(seeded_random(4_294_967_297.0), seeded_random(1.0));
/// ```
pub fn seeded_random(seed: impl Into<Seed>) -> SeededRandom {
	SeededRandom::from_seed(&seed.into())
}

/// The first number of the mulberry32 generator seeded from the string `seed`, in `[0, 1)`.
pub fn first_random(seed: &str) -> f64 {
	SeededRandom::from_text(seed).next_value()
}

/// The value of a random signal at the exact cycle time `t`: a pure function of the seed, the signal's kind (`rand` or `perlin`), and `t` in lowest terms.
///
/// ```
/// use undertone_pattern::random::{time_random, Seed};
/// use undertone_pattern::Fraction;
/// let a = time_random(&Seed::Num(0.0), "rand", Fraction::new(1, 3));
/// let b = time_random(&Seed::Num(0.0), "rand", Fraction::new(2, 6));
/// assert_eq!(a, b);
/// assert!((0.0..1.0).contains(&a));
/// ```
pub fn time_random(seed: &Seed, kind: &str, t: Fraction) -> f64 {
	first_random(&alloc::format!(
		"{}|{kind}|{}/{}",
		seed.key_text(),
		t.numerator(),
		t.denominator()
	))
}

#[cfg(test)]
mod tests {
	use super::*;
	use alloc::vec::Vec;

	#[test]
	fn numeric_seeds_wrap_like_unsigned_shift() {
		assert_eq!(to_uint32(9_007_199_254_740_993.0), 0);
		assert_eq!(to_uint32(-4_294_967_296.0), 0);
		assert_eq!(to_uint32(1e300), 0);
		assert_eq!(to_uint32(f64::MAX), 0);
		assert_eq!(to_uint32(4_294_967_295.9), 4_294_967_295);
		assert_eq!(to_uint32(-2_147_483_648.0), 2_147_483_648);
		assert_eq!(to_uint32(0.5), 0);
		assert_eq!(to_uint32(-0.5), 0);
	}

	#[test]
	fn utf16_and_text_agree_for_text() {
		let units: Vec<u16> = "caf\u{e9} \u{1F3B5}".encode_utf16().collect();
		assert_eq!(
			SeededRandom::from_utf16(&units),
			SeededRandom::from_text("caf\u{e9} \u{1F3B5}")
		);
	}

	#[test]
	fn the_iterator_matches_next_value() {
		let mut a = seeded_random("song");
		let firsts: Vec<f64> = seeded_random("song").take(3).collect();
		assert_eq!(firsts, [a.next_value(), a.next_value(), a.next_value()]);
	}

	#[test]
	fn the_key_text_follows_javascript_number_printing() {
		assert_eq!(Seed::Num(-0.0).key_text(), "0");
		assert_eq!(Seed::Num(1e21).key_text(), "1e+21");
		assert_eq!(Seed::Num(f64::NAN).key_text(), "NaN");
		assert_eq!(Seed::Num(f64::NEG_INFINITY).key_text(), "-Infinity");
	}
}
