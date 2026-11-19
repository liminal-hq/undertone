// Signals: continuous patterns (sine, saw, rand, perlin, ...) read at the onset of each event
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Signals, the continuous patterns.
//!
//! A signal has no structure: a query over any span returns one hap with no `whole`, whose part is the span and whose value is the signal at the span's begin. Its point sampler is the exact value at an instant, which is how every reader (`segment`, `euclid`, arithmetic, the controls) reads it: at an event's onset.
//!
//! In the tree a signal is a [`Signal`] node of data: a [`SignalKind`] and a [`Seed`]. A random signal rebuilds with another seed through [`Pattern::seed`], with no closure and no registry.

use crate::error::{Error, Result};
use crate::fraction::Fraction;
use crate::js;
use crate::math;
use crate::pattern::{Node, Pattern};
use crate::random::{Seed, time_random};
use crate::value::Datum;
use alloc::vec::Vec;

/// The shape of a periodic signal over one cycle, from 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
	/// Rises linearly from 0 to 1, then jumps back.
	Saw,
	/// Falls linearly from 1 to 0, then jumps back.
	Isaw,
	/// A sine, at 0.5 and rising at the start of each cycle.
	Sine,
	/// A cosine, at 1 at the start of each cycle.
	Cosine,
	/// A triangle: 0 at the start, 1 halfway.
	Tri,
	/// A square: 0 for the first half, 1 for the second.
	Square,
}

impl Shape {
	/// The shape's value at `phase`, in `[0, 1)`.
	pub fn at(self, phase: f64) -> f64 {
		match self {
			Shape::Saw => phase,
			Shape::Isaw => 1.0 - phase,
			Shape::Sine => 0.5 + 0.5 * math::sin(2.0 * core::f64::consts::PI * phase),
			Shape::Cosine => 0.5 + 0.5 * math::cos(2.0 * core::f64::consts::PI * phase),
			Shape::Tri => {
				if phase < 0.5 {
					2.0 * phase
				} else {
					2.0 - 2.0 * phase
				}
			}
			Shape::Square => {
				if phase < 0.5 {
					0.0
				} else {
					1.0
				}
			}
		}
	}

	/// The name the reference exports it under (`sine`, with `2` appended for the bipolar form).
	pub fn name(self) -> &'static str {
		match self {
			Shape::Saw => "saw",
			Shape::Isaw => "isaw",
			Shape::Sine => "sine",
			Shape::Cosine => "cosine",
			Shape::Tri => "tri",
			Shape::Square => "square",
		}
	}
}

/// What a signal computes.
#[derive(Clone, Debug, PartialEq)]
pub enum SignalKind<T> {
	/// A periodic shape, optionally mapped from `[0, 1]` onto `[-1, 1]`.
	Periodic {
		/// The shape over one cycle.
		shape: Shape,
		/// Whether it runs from -1 to 1 (`2 * shape - 1`).
		bipolar: bool,
	},
	/// A uniform random number from 0 up to (not including) 1.
	Rand,
	/// `2 * rand - 1`.
	Rand2,
	/// A random whole number from 0 to n - 1.
	Irand(f64),
	/// One of these values at random.
	Choose(Vec<T>),
	/// 1 with probability `p`, otherwise 0.
	BrandBy(f64),
	/// Smooth random motion from 0 to 1 between a random value at each whole cycle.
	Perlin,
}

/// A signal: a kind and the seed of its random stream (ignored by the periodic kinds).
#[derive(Clone, Debug, PartialEq)]
pub struct Signal<T> {
	/// What the signal computes.
	pub kind: SignalKind<T>,
	/// The seed of the random stream, `0` by default.
	pub seed: Seed,
}

/// Perlin's 2002 smootherstep, `6x^5 - 15x^4 + 10x^3`.
fn smootherstep(x: f64) -> f64 {
	x * x * x * (x * (6.0 * x - 15.0) + 10.0)
}

impl<T: Datum> Signal<T> {
	/// The signal's exact value at the instant `t`.
	pub fn at(&self, t: Fraction) -> T {
		let uniform = || time_random(&self.seed, "rand", t);
		match &self.kind {
			SignalKind::Periodic { shape, bipolar } => {
				let value = shape.at(t.cycle_pos().to_f64());
				T::from_number(if *bipolar { 2.0 * value - 1.0 } else { value })
			}
			SignalKind::Rand => T::from_number(uniform()),
			SignalKind::Rand2 => T::from_number(2.0 * uniform() - 1.0),
			SignalKind::Irand(n) => T::from_number(math::floor(uniform() * n)),
			SignalKind::Choose(options) => {
				options[math::floor(uniform() * options.len() as f64) as usize].clone()
			}
			SignalKind::BrandBy(p) => T::from_number(if uniform() < *p { 1.0 } else { 0.0 }),
			SignalKind::Perlin => {
				let i = t.floor();
				let a = time_random(&self.seed, "perlin", Fraction::from_int(i));
				let b = time_random(&self.seed, "perlin", Fraction::from_int(i + 1));
				T::from_number(a + (b - a) * smootherstep(t.cycle_pos().to_f64()))
			}
		}
	}

	/// Whether `seed()` can rebuild this signal with another seed.
	pub fn is_seedable(&self) -> bool {
		!matches!(self.kind, SignalKind::Periodic { .. })
	}
}

fn signal<T: Datum>(kind: SignalKind<T>) -> Pattern<T> {
	Pattern::from_node(Node::Signal(Signal {
		kind,
		seed: Seed::Num(0.0),
	}))
}

/// A periodic signal of the given shape, from 0 to 1, or from -1 to 1 when `bipolar`.
///
/// ```
/// use undertone_pattern::signal::{periodic, Shape};
/// use undertone_pattern::{Fraction, Span};
/// let sine = periodic::<f64>(Shape::Sine, false);
/// let haps = sine.query(Span::new(Fraction::new(1, 8), Fraction::from_int(1)));
/// assert_eq!(haps.len(), 1);
/// assert!(haps[0].whole.is_none());
/// ```
pub fn periodic<T: Datum>(shape: Shape, bipolar: bool) -> Pattern<T> {
	signal(SignalKind::Periodic { shape, bipolar })
}

/// A random number from 0 up to (not including) 1 at each instant; choose a seed with [`Pattern::seed`].
pub fn rand<T: Datum>() -> Pattern<T> {
	signal(SignalKind::Rand)
}

/// `rand` from -1 up to 1.
pub fn rand2<T: Datum>() -> Pattern<T> {
	signal(SignalKind::Rand2)
}

/// Smooth random motion from 0 to 1.
pub fn perlin<T: Datum>() -> Pattern<T> {
	signal(SignalKind::Perlin)
}

/// A random whole number from 0 to `n - 1`.
pub fn irand<T: Datum>(n: f64) -> Result<Pattern<T>> {
	if !js::is_integer(n) || n <= 0.0 {
		return Err(Error::new(alloc::format!(
			"irand() needs a positive integer, got {}",
			js::number_to_string(n)
		)));
	}
	Ok(signal(SignalKind::Irand(n)))
}

/// One of `values` at random at each instant.
pub fn choose<T: Datum>(values: Vec<T>) -> Result<Pattern<T>> {
	if values.is_empty() {
		return Err(Error::new("choose() needs at least one value"));
	}
	Ok(signal(SignalKind::Choose(values)))
}

/// 1 with probability `p` (0 to 1), otherwise 0.
pub fn brand_by<T: Datum>(p: f64) -> Result<Pattern<T>> {
	if !(0.0..=1.0).contains(&p) {
		return Err(Error::new(alloc::format!(
			"brandBy() probability must be between 0 and 1, got {}",
			js::number_to_string(p)
		)));
	}
	Ok(signal(SignalKind::BrandBy(p)))
}

/// 0 or 1 at random, evenly: `brand_by(0.5)`.
pub fn brand<T: Datum>() -> Pattern<T> {
	signal(SignalKind::BrandBy(0.5))
}

/// A signal by the name the reference exports it under (`sine`, `saw2`, `rand`, `perlin`, `brand`, ...), or `None` for an unknown name.
///
/// ```
/// use undertone_pattern::signal::by_name;
/// assert!(by_name::<f64>("cosine2").is_some());
/// assert!(by_name::<f64>("wobble").is_none());
/// ```
pub fn by_name<T: Datum>(name: &str) -> Option<Pattern<T>> {
	let shapes = [
		Shape::Saw,
		Shape::Isaw,
		Shape::Sine,
		Shape::Cosine,
		Shape::Tri,
		Shape::Square,
	];
	for shape in shapes {
		if name == shape.name() {
			return Some(periodic(shape, false));
		}
		if name.strip_suffix('2') == Some(shape.name()) {
			return Some(periodic(shape, true));
		}
	}
	match name {
		"rand" => Some(rand()),
		"rand2" => Some(rand2()),
		"perlin" => Some(perlin()),
		"brand" => Some(brand()),
		_ => None,
	}
}

impl<T: Datum> Pattern<T> {
	/// Chooses the seed of a random signal (`rand`, `rand2`, `perlin`, `irand`, `choose`, `brand`, `brand_by`); the default is 0.
	///
	/// It works only directly on the random signal, before `range` or `segment` or anything else, as in the reference.
	///
	/// ```
	/// use undertone_pattern::random::Seed;
	/// use undertone_pattern::signal::rand;
	/// use undertone_pattern::Fraction;
	/// let a = rand::<f64>().seed(Seed::Num(7.0)).unwrap();
	/// let b = rand::<f64>().seed(Seed::Num(7.0)).unwrap();
	/// assert_eq!(a.sample_at(Fraction::new(1, 3)), b.sample_at(Fraction::new(1, 3)));
	/// ```
	pub fn seed(&self, seed: Seed) -> Result<Pattern<T>> {
		let Node::Signal(signal) = self.node() else {
			return Err(seed_misuse());
		};
		if !signal.is_seedable() {
			return Err(seed_misuse());
		}
		if let Seed::Num(n) = &seed
			&& !n.is_finite()
		{
			return Err(Error::new(alloc::format!(
				"seed() needs a finite number or a string, got {}",
				js::number_to_string(*n)
			)));
		}
		Ok(Pattern::from_node(Node::Signal(Signal {
			kind: signal.kind.clone(),
			seed,
		})))
	}
}

fn seed_misuse() -> Error {
	Error::new(
		"seed() works directly on rand, rand2, perlin, irand(), choose() and brand — call it before range() or segment()",
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Span, Value};

	#[test]
	fn periodic_signals_read_exactly_at_a_point() {
		let sine = periodic::<f64>(Shape::Sine, false);
		assert_eq!(
			sine.sample_at(Fraction::new(1, 8)),
			Some(0.8535533905932737)
		);
		assert_eq!(
			sine.sample_at(Fraction::new(-3, 2)),
			Some(0.5000000000000001)
		);
		let tri2 = periodic::<f64>(Shape::Tri, true);
		assert_eq!(tri2.sample_at(Fraction::new(1, 4)), Some(0.0));
	}

	#[test]
	fn a_signal_query_is_one_structureless_hap_valued_at_its_begin() {
		let saw = periodic::<f64>(Shape::Saw, false);
		let haps = saw.query(Span::new(Fraction::new(1, 2), Fraction::new(7, 2)));
		assert_eq!(haps.len(), 1);
		assert_eq!(haps[0].whole, None);
		assert_eq!(haps[0].value, 0.5);
		assert!(
			saw.query(Span::new(Fraction::from_int(1), Fraction::from_int(1)))
				.is_empty()
		);
	}

	#[test]
	fn seeds_change_the_stream_and_repeat() {
		let at = Fraction::new(5, 7);
		let a = rand::<f64>().sample_at(at);
		let b = rand::<f64>().seed(Seed::Num(1.0)).unwrap().sample_at(at);
		let c = rand::<f64>().seed(Seed::Num(1.0)).unwrap().sample_at(at);
		assert_ne!(a, b);
		assert_eq!(b, c);
		assert!(rand::<f64>().seed(Seed::Str("kick".into())).is_ok());
		assert_eq!(
			rand::<f64>()
				.seed(Seed::Num(f64::NAN))
				.unwrap_err()
				.message(),
			"seed() needs a finite number or a string, got NaN"
		);
	}

	#[test]
	fn seed_works_only_directly_on_a_random_signal() {
		let shaped = rand::<f64>().range(0.0, 2.0);
		assert!(shaped.seed(Seed::Num(1.0)).is_err());
		assert!(
			periodic::<f64>(Shape::Sine, false)
				.seed(Seed::Num(1.0))
				.is_err()
		);
	}

	#[test]
	fn constructors_check_their_arguments() {
		assert_eq!(
			irand::<f64>(0.0).unwrap_err().message(),
			"irand() needs a positive integer, got 0"
		);
		assert_eq!(
			brand_by::<f64>(2.0).unwrap_err().message(),
			"brandBy() probability must be between 0 and 1, got 2"
		);
		assert!(choose::<Value>(Vec::new()).is_err());
		let pick = choose(alloc::vec![Value::Str("a".into()), Value::Str("b".into())]).unwrap();
		assert!(pick.sample_at(Fraction::new(1, 3)).is_some());
	}
}
