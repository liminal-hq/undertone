// The synth engine and scheduler crate of Undertone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Synth engine and scheduler for Undertone.
//!
//! This crate will turn patterns from [`undertone_pattern`] into sound.
//!
//! The [`math`] module holds the transcendental maths the recorded graphs depend on. It uses the
//! pure-Rust `libm` crate by default, so the same numbers come out on every platform; build with
//! `--no-default-features` for the platform C library.
//!
//! The [`params`] module holds [`params::VoiceParams`], the complete parameters of one voice. Its serde
//! support is behind the `serde` cargo feature.

pub mod math;
pub mod params;
pub mod random;

/// The name of this crate, as a placeholder item until the engine lands.
///
/// ```
/// assert_eq!(undertone_engine::name(), "undertone-engine");
/// ```
pub fn name() -> &'static str {
	env!("CARGO_PKG_NAME")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn names_the_crate() {
		assert_eq!(name(), "undertone-engine");
	}
}
