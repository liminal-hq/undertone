// The pattern query core and mini-notation crate of Undertone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Pattern query core and mini-notation for Undertone.
//!
//! This crate is the pure, audio-free part of Undertone: exact rational time ([`Fraction`]), spans and events ([`Span`], [`Hap`]), and the [`js`] module that reproduces the JavaScript number and string behaviour the reference depends on.
//!
//! The crate uses `alloc` types only, and its floating-point maths comes from one small module with two back-ends: the pure-Rust `libm` crate (the default, so it is `no_std` and gives the same numbers on every target, decision D-23) or the standard library (`--no-default-features --features std`).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

#[cfg(test)]
#[macro_use]
extern crate std;

pub mod chord;
pub mod control;
pub mod controls;
pub(crate) mod ddpow;
pub mod drift;
pub mod error;
pub mod fraction;
pub mod hap;
pub mod instruments;
pub mod js;
pub(crate) mod math;
pub mod mini;
pub mod pattern;
pub mod pitch;
pub mod query;
pub mod random;
pub mod serialize;
pub mod signal;
pub mod value;

pub use controls::{CONTROLS, Control, ControlInput, ControlMap, ControlSpec};
pub use error::{Error, Result};
pub use fraction::Fraction;
pub use hap::{Hap, Span};
pub use pattern::{
	ArithOp, Node, Pattern, arrange, cat, compress, fast, mini, pure, rev, seq, silence, slow,
	stack, timecat,
};
#[cfg(feature = "std")]
pub use query::ForeignTable;
pub use query::{ForeignHost, ForeignId, Query};
pub use serialize::Wire;
pub use value::{Datum, LayerMap, MapFn, ParsedScale, Value};

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
