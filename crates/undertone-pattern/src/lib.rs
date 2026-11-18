// The pattern query core and mini-notation crate of Undertone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Pattern query core and mini-notation for Undertone.
//!
//! This crate will hold the pure, audio-free part of Undertone: exact rational time, patterns, and the mini-notation parser.

/// The name of this crate, as a placeholder item until the pattern core lands.
///
/// ```
/// assert_eq!(undertone_pattern::name(), "undertone-pattern");
/// ```
pub fn name() -> &'static str {
	env!("CARGO_PKG_NAME")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn names_the_crate() {
		assert_eq!(name(), "undertone-pattern");
	}
}
