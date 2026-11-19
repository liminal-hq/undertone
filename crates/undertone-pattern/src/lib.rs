// The pattern query core and mini-notation crate of Undertone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Pattern query core and mini-notation for Undertone.
//!
//! This crate is the pure, audio-free part of Undertone: exact rational time ([`Fraction`]), spans and events ([`Span`], [`Hap`]), and the [`js`] module that reproduces the JavaScript number and string behaviour the reference depends on.
//!
//! The crate uses `alloc` types only and takes its floating-point maths from one small module, so a `no_std` build needs only a maths provider (see the `std` feature).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod error;
pub mod fraction;
pub mod hap;
pub mod js;
pub(crate) mod math;
pub mod mini;
pub mod pattern;
pub mod value;

pub use error::{Error, Result};
pub use fraction::Fraction;
pub use hap::{Hap, Span};
pub use pattern::{Node, Pattern, cat, compress, fast, pure, seq, silence, slow, stack, timecat};
pub use value::{Datum, MapFn, ParsedScale, Value};

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
