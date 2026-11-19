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
//! The [`graph`] module holds the [`graph::Graph`] trait, the Web Audio calls the engine books voices with, and
//! [`graph::LogGraph`], which records them in the layer 3 corpus format.
//!
//! The [`engine`] module holds [`engine::Engine`], which books [`params::VoiceParams`] on a graph the way the
//! TypeScript's `playVoice` does. [`voice`] is the voice itself, [`pan`] its placement, [`effects`] the shared
//! orbit reverb and delay, [`master`] the master bus, and [`waves`], [`noise`], and [`pitch_curve`] its sound.
//! [`render`] plans an offline render of a pattern and books it on any graph, and [`score`] compiles a tick-timed
//! cue to a looping pattern.
//! [`surround`] holds the speaker ring, the fold-down of channel gains, `enable_multichannel`, and the mono fold, [`window`] plans an offline render booked in windows,
//! and [`warn`] holds the warnings the engine gives once.
//!
//! The [`params`] module holds [`params::VoiceParams`], the complete parameters of one voice. Its serde
//! support is behind the `serde` cargo feature.

extern crate alloc;

pub mod effects;
pub mod engine;
pub mod graph;

/// Instruments as data: [`fm_voice`](instruments::fm_voice), [`fm_presets`](instruments::fm_presets), `Pattern::voice`, and [`layer`](instruments::layer), re-exported from the pattern crate (they are pure data, and the engine depends on that crate).
pub use undertone_pattern::instruments;
pub mod master;
pub mod math;
pub mod noise;
pub mod pan;
pub mod params;
pub mod pitch_curve;
pub mod random;
pub mod render;
pub mod score;
pub mod surround;
pub mod voice;
pub mod warn;
pub mod waves;
pub mod window;

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
