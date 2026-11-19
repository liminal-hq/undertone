// The reference's named signals as ready-made patterns of numbers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The signals of the reference, by their reference names, as patterns of numbers: [`sine`], [`saw`], [`rand`],
//! and the rest.
//!
//! In the TypeScript these are values exported from the package (`import { sine2 } from '@liminal-hq/undertone'`).
//! In Rust a pattern is built by a call, so each is a function returning a fresh [`Pattern<f64>`](Pattern)
//! (building one costs a node and queries nothing). They are thin wrappers over the pattern crate's
//! [`periodic`](undertone_pattern::signal::periodic), [`rand`](undertone_pattern::signal::rand), and friends,
//! fixed to `f64` so a control can take them without a type annotation.
//!
//! ```
//! use undertone::prelude::*;
//!
//! // Eight hats a cycle, each one place further along a slow sweep of the stereo field.
//! let hats = sound("white*8")?.pan(sine2().slow(4.0)?)?.lpf(sine().range(2000.0, 9000.0))?;
//! # let _ = hats;
//! # Ok::<(), undertone::Error>(())
//! ```

use undertone_pattern::random::Seed;
use undertone_pattern::signal::{self, Shape};
use undertone_pattern::{Pattern, Result};

macro_rules! periodic_signals {
	($($(#[$doc:meta])* $name:ident => ($shape:ident, $bipolar:literal);)*) => {
		$(
			$(#[$doc])*
			pub fn $name() -> Pattern<f64> {
				signal::periodic(Shape::$shape, $bipolar)
			}
		)*
	};
}

periodic_signals! {
	/// `saw`: rises linearly from 0 to 1 over each cycle, then jumps back to 0.
	saw => (Saw, false);
	/// `isaw`: falls linearly from 1 to 0 over each cycle, then jumps back to 1.
	isaw => (Isaw, false);
	/// `sine`: `0.5 + 0.5·sin(2π·phase)`, from 0 to 1.
	sine => (Sine, false);
	/// `cosine`: `0.5 + 0.5·cos(2π·phase)`, `sine` a quarter cycle ahead.
	cosine => (Cosine, false);
	/// `tri`: rises from 0 to 1 by the half cycle, then falls back to 0.
	tri => (Tri, false);
	/// `square`: 0 for the first half of the cycle, 1 for the second.
	square => (Square, false);
	/// `saw2`: `saw` from -1 to 1.
	saw2 => (Saw, true);
	/// `isaw2`: `isaw` from -1 to 1 (Undertone's own addition, for symmetry).
	isaw2 => (Isaw, true);
	/// `sine2`: `sine` from -1 to 1.
	sine2 => (Sine, true);
	/// `cosine2`: `cosine` from -1 to 1.
	cosine2 => (Cosine, true);
	/// `tri2`: `tri` from -1 to 1.
	tri2 => (Tri, true);
	/// `square2`: `square` from -1 to 1.
	square2 => (Square, true);
}

/// `rand`: a random number from 0 up to (not including) 1 at each instant. Choose a seed with
/// [`Pattern::seed`] directly on it.
pub fn rand() -> Pattern<f64> {
	signal::rand()
}

/// `rand2`: `2·rand - 1`, from -1 up to 1.
pub fn rand2() -> Pattern<f64> {
	signal::rand2()
}

/// `perlin`: smooth random motion from 0 to 1.
pub fn perlin() -> Pattern<f64> {
	signal::perlin()
}

/// `brand`: 1 with probability one half, otherwise 0.
pub fn brand() -> Pattern<f64> {
	signal::brand()
}

/// `brandBy(p)`: 1 with probability `p` (0 to 1), otherwise 0.
///
/// # Errors
///
/// `p` outside 0 to 1 fails with the reference's message.
pub fn brand_by(p: f64) -> Result<Pattern<f64>> {
	signal::brand_by(p)
}

/// `irand(n)`: a random whole number from 0 to `n - 1`.
///
/// # Errors
///
/// `n` must be a positive integer.
pub fn irand(n: f64) -> Result<Pattern<f64>> {
	signal::irand(n)
}

/// `choose(...values)`: one of the values, picked at random.
///
/// # Errors
///
/// An empty list fails with the reference's message.
pub fn choose(values: Vec<f64>) -> Result<Pattern<f64>> {
	signal::choose(values)
}

/// `signal(fn)`: your own signal. `f` receives the cycle time as a number (3.25 a quarter into cycle 3, not its
/// phase) and must be a pure function of it, so `|t| t % 1.0` is `saw`.
pub fn signal(f: impl Fn(f64) -> f64 + Send + Sync + 'static) -> Pattern<f64> {
	signal::signal_from_fn(f)
}

/// The seed argument of [`Pattern::seed`], so `rand().seed(seed(7.0))` reads like the reference's `rand.seed(7)`.
pub fn seed(seed: impl Into<Seed>) -> Seed {
	seed.into()
}

#[cfg(test)]
mod tests {
	use super::*;
	use undertone_pattern::Fraction;

	#[test]
	fn the_unipolar_and_bipolar_forms_agree_with_the_reference() {
		let quarter = Fraction::new(1, 4);
		assert_eq!(sine().sample_at(quarter), Some(1.0));
		assert_eq!(sine2().sample_at(quarter), Some(1.0));
		assert_eq!(saw().sample_at(quarter), Some(0.25));
		assert_eq!(saw2().sample_at(quarter), Some(-0.5));
		assert_eq!(isaw().sample_at(quarter), Some(0.75));
		assert_eq!(square().sample_at(quarter), Some(0.0));
		assert_eq!(square2().sample_at(quarter), Some(-1.0));
	}

	#[test]
	fn every_wrapper_matches_the_pattern_crates_by_name_lookup() {
		let at = Fraction::new(1, 3);
		for (name, ours) in [
			("saw", saw()),
			("isaw2", isaw2()),
			("cosine", cosine()),
			("tri2", tri2()),
			("rand", rand()),
			("rand2", rand2()),
			("perlin", perlin()),
			("brand", brand()),
		] {
			let theirs = signal::by_name::<f64>(name).unwrap();
			assert_eq!(ours.sample_at(at), theirs.sample_at(at), "{name}");
		}
	}

	#[test]
	fn a_seed_goes_directly_on_the_random_signal() {
		let a = rand().seed(seed(7.0)).unwrap();
		let b = rand().seed(Seed::Num(7.0)).unwrap();
		let at = Fraction::new(5, 7);
		assert_eq!(a.sample_at(at), b.sample_at(at));
		assert_ne!(a.sample_at(at), rand().sample_at(at));
		assert_eq!(
			rand()
				.range(0.0, 1.0)
				.seed(seed(7.0))
				.unwrap_err()
				.message(),
			"seed() works directly on rand, rand2, perlin, irand(), choose() and brand — call it before range() or segment()"
		);
	}

	#[test]
	fn a_closure_makes_a_signal() {
		let ramp = signal(|t| t % 1.0);
		assert_eq!(ramp.sample_at(Fraction::new(13, 4)), Some(0.25));
	}
}
