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
	/// A finite number (`7` formats as `7`, `1.5` as `1.5`).
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

/// FNV-1a over the UTF-16 code units of `text`: a stable string hash that does not depend on the platform.
///
/// ```
/// use undertone_pattern::random::fnv1a;
/// assert_eq!(fnv1a(""), 0x811c9dc5);
/// assert_eq!(fnv1a("a"), 0xe40c292c);
/// ```
pub fn fnv1a(text: &str) -> u32 {
	let mut hash: u32 = 0x811c_9dc5;
	for unit in text.encode_utf16() {
		hash ^= u32::from(unit);
		hash = hash.wrapping_mul(0x0100_0193);
	}
	hash
}

/// The first number of the mulberry32 generator seeded from the string `seed`, in `[0, 1)`.
pub fn first_random(seed: &str) -> f64 {
	let mut state = fnv1a(seed);
	state = state.wrapping_add(0x6d2b_79f5);
	let mut t = state;
	t = (t ^ (t >> 15)).wrapping_mul(t | 1);
	t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
	f64::from(t ^ (t >> 14)) / 4_294_967_296.0
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
