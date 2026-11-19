// The engine's seeded random sources: a re-export of the pattern crate's, so there is one implementation
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Seeded randomness for the engine: noise, reverb impulse responses, and any other generated audio data.
//!
//! The generator itself lives in the pattern crate, because patterns need it first (random signals and `drift` derive their values from the same FNV-1a and mulberry32 scheme), and the engine depends on the pattern crate rather than the reverse. This module re-exports it, so the engine and the patterns can never disagree about a seed.
//!
//! ```
//! use undertone_engine::random::seeded_random;
//! let mut random = seeded_random(0.0);
//! assert_eq!(random.next_value(), 0.26642920868471265);
//! ```

pub use undertone_pattern::random::{
	Seed, SeededRandom, fnv1a, fnv1a_utf16, seeded_random, time_random, to_uint32,
};
