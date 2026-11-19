// Signals: continuous patterns (sine, saw, rand, perlin, ...) read at the onset of each event
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Signals, the continuous patterns.
//!
//! A signal is a pattern with no rhythm of its own: a value that changes smoothly (or randomly) through cycle time, such as a sine wave or a stream of random numbers. You read a signal by giving it a rhythm: [`Pattern::segment`] cuts it into `n` events per cycle, and any event of a structured pattern can read it at its onset.
//!
//! A signal has no structure: a query over any span returns one hap with no `whole`, whose part is the span and whose value is the signal at the span's begin. Its point sampler ([`Pattern::sample_at`]) is the exact value at an instant, which is how every reader (`segment`, `euclid`, arithmetic, the controls) reads it: at an event's **onset**. It is never averaged over the event, and never read at the event's middle. One event, one value.
//!
//! # The signals
//!
//! Each periodic signal repeats once per cycle and runs from 0 to 1. The phase is the position inside the cycle, read exactly from rational cycle time, so the value at cycle 3¼ is the value at ¼.
//!
//! | Signal   | At 0 | At ¼ | At ½ | At ¾ | Shape                                                    |
//! | -------- | ---- | ---- | ---- | ---- | -------------------------------------------------------- |
//! | `saw`    | 0    | 0.25 | 0.5  | 0.75 | Rises linearly from 0 to 1, then jumps back to 0.        |
//! | `isaw`   | 1    | 0.75 | 0.5  | 0.25 | Falls linearly from 1 to 0, then jumps back to 1.        |
//! | `sine`   | 0.5  | 1    | 0.5  | 0    | `0.5 + 0.5·sin(2π·phase)`.                               |
//! | `cosine` | 1    | 0.5  | 0    | 0.5  | `0.5 + 0.5·cos(2π·phase)`: `sine` a quarter cycle ahead. |
//! | `tri`    | 0    | 0.5  | 1    | 0.5  | Rises from 0 to 1 by the half, then falls back to 0.     |
//! | `square` | 0    | 0    | 1    | 1    | 0 for the first half of the cycle, 1 for the second.     |
//!
//! Every one has a bipolar form running from -1 to 1, `2v - 1` of the unipolar value (`saw2`, `isaw2`, `sine2`, and so on): [`periodic`] with `bipolar` set, or [`by_name`] with the reference's name. [`signal_from_fn`] makes your own from a function of the cycle time. The random signals are [`rand`], [`rand2`], [`irand`], [`choose`], [`brand`], [`brand_by`], and [`perlin`].
//!
//! ```
//! use undertone_pattern::signal::{periodic, Shape};
//! use undertone_pattern::{Fraction, Pattern, Span};
//! let values = |p: Pattern<f64>| {
//!     let mut haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
//!     haps.sort_by_key(|h| h.part.begin);
//!     // To six places: the sine at 1/2 is 0.5000000000000001, as in JavaScript.
//!     haps.iter().map(|h| (h.value * 1e6).round() / 1e6).collect::<Vec<f64>>()
//! };
//! // Four events per cycle, read at 0, 1/4, 1/2, and 3/4.
//! assert_eq!(values(periodic(Shape::Sine, false).segment(4.0).unwrap()), [0.5, 1.0, 0.5, 0.0]);
//! assert_eq!(values(periodic(Shape::Saw, false).range(0.0, 8.0).segment(8.0).unwrap()), [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]);
//! ```
//!
//! # Structure comes from the left
//!
//! When a structured pattern and a signal meet, the structured pattern supplies the events and the signal supplies values. A signal never adds or removes events: `segment(4).add(sine)` keeps four events per cycle, and `s("hh*8").pan(sine2)` is eight hats, each panned by the sine at its onset. Events at the same instant read the same value: to make two of them differ, read different signals, or the same random signal with different seeds.
//!
//! # Combinators
//!
//! The pattern combinators move a signal in time the way they move events: `fast(f)` reads at `t·f` and `slow(f)` at `t/f`; `rev` mirrors each cycle (at `c + x` it reads `c + 1 - x`); `every(n, f)` picks the transformed signal on cycles 0, n, 2n, and the plain one otherwise; `cat` and `arrange` play one signal per cycle or section, each experiencing its own consecutive cycles; `seq` and `timecat` squeeze each signal into its share of the cycle; and `euclid` on a signal gives the rhythm's events, each holding the signal's value at its onset.
//!
//! A mix of signals and ordinary patterns works in `cat`, `seq`, `timecat`, `stack`, `arrange`, and `every`: a control reads the child that is active at the event's onset, the signal at its exact value and the ordinary pattern at the event covering that instant (a rest leaves the control unset). So `cat(saw2, pure(0))` is a rising saw in one cycle and 0 in the next, and gives the same values however the playback is cut into windows. In a `stack`, overlapping layers have no single value, so the first layer with a value wins. A pattern that holds a signal anywhere is treated as a signal by `euclid` and `segment`.
//!
//! # Randomness and seeds
//!
//! Random signals are **deterministic**: each value is a pure function of the seed, the kind of signal, and the exact rational time at which it is read, so the same seed gives the same sequence however the pattern is queried, in whatever order, in whatever window sizes, on whatever thread or device. Successive cycles read different times, so they get different values; wrap the signal in `arrange` to repeat one cycle's values. The default seed is 0; choose another with [`Pattern::seed`] **directly on the random signal**, before anything else is chained. See [`random`](crate::random) for the scheme.
//!
//! In the tree a signal is a [`Signal`] node of data: a [`SignalKind`] and a [`Seed`]. A random signal rebuilds with another seed through [`Pattern::seed`], with no closure and no registry, which is why a tree holding signals can be printed, hashed, and sent to another thread with [`Pattern::serialize`]. The one exception is a signal made from your own function ([`signal_from_fn`]): it is a [`Node::Custom`], and stays on the thread that made it.
//!
//! # Ranges and arithmetic
//!
//! | Call                              | Expects input | Gives                                                  |
//! | --------------------------------- | ------------- | ------------------------------------------------------ |
//! | [`Pattern::range`] `(lo, hi)`     | 0 to 1        | `lo + v·(hi - lo)`, linear.                            |
//! | [`Pattern::range2`] `(lo, hi)`    | -1 to 1       | `lo + (v + 1)/2·(hi - lo)`, linear.                    |
//! | [`Pattern::rangex`] `(lo, hi)`    | 0 to 1        | `lo·(hi/lo)^v`, exponential: the curve for frequencies |
//!
//! A range does not clamp, and `lo` may be above `hi`. [`Pattern::arith`] (and `+ - * /` on patterns) combines each value with the other pattern read at the value's onset; [`Pattern::round`] rounds to the nearest whole number (halves round up) and [`Pattern::floor`] rounds down. A signal stays a signal through all of these. Division by zero gives infinity, which a control later treats as a rest.

use crate::error::{Error, Result};
use crate::fraction::Fraction;
use crate::hap::{Hap, Span};
use crate::js;
use crate::math;
use crate::pattern::{ArithOp, Node, Pattern};
use crate::query::Query;
use crate::random::{Seed, time_random};
use crate::value::{Datum, MapFn};
use alloc::sync::Arc;
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

/// A periodic signal of the given shape, from 0 to 1, or from -1 to 1 when `bipolar` (`2v - 1`).
///
/// The value is read exactly from the cycle time's phase, so cycle 3¼ reads what ¼ does, negative cycles included.
///
/// ```
/// use undertone_pattern::signal::{periodic, Shape};
/// use undertone_pattern::Fraction;
/// let sine = periodic::<f64>(Shape::Sine, false);
/// assert_eq!(sine.sample_at(Fraction::new(1, 4)), Some(1.0));
/// assert_eq!(sine.sample_at(Fraction::new(13, 4)), Some(1.0));
/// let saw2 = periodic::<f64>(Shape::Saw, true);
/// assert_eq!(saw2.sample_at(Fraction::new(1, 4)), Some(-0.5));
/// let haps = sine.query(undertone_pattern::Span::new(Fraction::new(1, 8), Fraction::from_int(1)));
/// assert_eq!(haps.len(), 1);
/// assert!(haps[0].whole.is_none());
/// ```
pub fn periodic<T: Datum>(shape: Shape, bipolar: bool) -> Pattern<T> {
	signal(SignalKind::Periodic { shape, bipolar })
}

/// A signal from your own function of the cycle time: `f` receives the time in cycles as a number (3.25 a quarter into cycle 3, not its phase), so `|t| t % 1.0` is `saw`.
///
/// The function is not data, so the pattern is a [`Node::Custom`]: it works on the thread that made it, and [`Pattern::serialize`] refuses it. A function must be a pure function of its argument, because the scheduler may ask in any order and more than once.
///
/// ```
/// use undertone_pattern::signal::signal_from_fn;
/// use undertone_pattern::Fraction;
/// let saw = signal_from_fn(|t: f64| t % 1.0);
/// assert_eq!(saw.sample_at(Fraction::new(13, 4)), Some(0.25));
/// assert!(saw.serialize().is_err());
/// ```
pub fn signal_from_fn<T: Datum>(f: impl Fn(f64) -> T + Send + Sync + 'static) -> Pattern<T> {
	struct FromFn<F>(F);
	impl<T: Datum, F: Fn(f64) -> T + Send + Sync> Query<T> for FromFn<F> {
		fn query(&self, span: Span, out: &mut Vec<Hap<T>>) {
			if span.begin < span.end {
				out.push(Hap {
					whole: None,
					part: span,
					value: (self.0)(span.begin.to_f64()),
				});
			}
		}
		fn sample(&self, t: Fraction) -> Option<T> {
			Some((self.0)(t.to_f64()))
		}
		fn has_sampler(&self) -> bool {
			true
		}
	}
	Pattern::custom(Arc::new(FromFn(f)))
}

/// A random number from 0 up to (not including) 1 at each instant; choose a seed with [`Pattern::seed`].
///
/// ```
/// use undertone_pattern::signal::rand;
/// use undertone_pattern::Fraction;
/// let r = rand::<f64>();
/// let v = r.sample_at(Fraction::new(1, 3)).unwrap();
/// assert!((0.0..1.0).contains(&v));
/// // The same instant always gives the same value.
/// assert_eq!(r.sample_at(Fraction::new(2, 6)), Some(v));
/// ```
pub fn rand<T: Datum>() -> Pattern<T> {
	signal(SignalKind::Rand)
}

/// `rand` from -1 up to 1: `2·rand - 1`.
///
/// ```
/// use undertone_pattern::signal::{rand, rand2};
/// use undertone_pattern::Fraction;
/// let t = Fraction::new(5, 7);
/// let (a, b) = (rand::<f64>().sample_at(t).unwrap(), rand2::<f64>().sample_at(t).unwrap());
/// assert_eq!(b, 2.0 * a - 1.0);
/// ```
pub fn rand2<T: Datum>() -> Pattern<T> {
	signal(SignalKind::Rand2)
}

/// Smooth random motion from 0 to 1: Perlin-style value noise. It picks a random value at each whole cycle and glides between neighbours with Perlin's smootherstep curve `6x⁵ - 15x⁴ + 10x³`, so it passes exactly through those values at whole cycles and has no corners. It has its own random stream, apart from [`rand`]'s.
///
/// ```
/// use undertone_pattern::signal::perlin;
/// use undertone_pattern::Fraction;
/// let p = perlin::<f64>();
/// // At a whole cycle it equals that cycle's random value, and it never leaves 0 to 1.
/// let at_start = p.sample_at(Fraction::from_int(2)).unwrap();
/// assert!((0.0..1.0).contains(&at_start));
/// assert!((0..8).all(|i| (0.0..=1.0).contains(&p.sample_at(Fraction::new(i, 8)).unwrap())));
/// ```
pub fn perlin<T: Datum>() -> Pattern<T> {
	signal(SignalKind::Perlin)
}

/// A random whole number from 0 to `n - 1` (`floor(rand·n)` at the same seed and instant). `n` must be a positive integer.
///
/// ```
/// use undertone_pattern::signal::irand;
/// use undertone_pattern::Fraction;
/// let die = irand::<f64>(6.0).unwrap();
/// assert!((0..24).all(|i| die.sample_at(Fraction::new(i, 7)).unwrap() < 6.0));
/// assert_eq!(irand::<f64>(0.0).unwrap_err().message(), "irand() needs a positive integer, got 0");
/// ```
pub fn irand<T: Datum>(n: f64) -> Result<Pattern<T>> {
	if !js::is_integer(n) || n <= 0.0 {
		return Err(Error::new(alloc::format!(
			"irand() needs a positive integer, got {}",
			js::number_to_string(n)
		)));
	}
	Ok(signal(SignalKind::Irand(n)))
}

/// One of `values` at random at each instant: `choose(vec![-1.0, 0.0, 1.0])`. At least one value is needed.
///
/// ```
/// use undertone_pattern::signal::choose;
/// use undertone_pattern::Fraction;
/// let pick = choose(vec![-1.0, 0.0, 1.0]).unwrap();
/// let value = pick.sample_at(Fraction::new(3, 5)).unwrap();
/// assert!([-1.0, 0.0, 1.0].contains(&value));
/// assert_eq!(choose::<f64>(vec![]).unwrap_err().message(), "choose() needs at least one value");
/// ```
pub fn choose<T: Datum>(values: Vec<T>) -> Result<Pattern<T>> {
	if values.is_empty() {
		return Err(Error::new("choose() needs at least one value"));
	}
	Ok(signal(SignalKind::Choose(values)))
}

/// 1 with probability `p` (0 to 1), otherwise 0.
///
/// ```
/// use undertone_pattern::signal::brand_by;
/// use undertone_pattern::Fraction;
/// assert!((0..16).all(|i| brand_by::<f64>(1.0).unwrap().sample_at(Fraction::new(i, 3)) == Some(1.0)));
/// assert!((0..16).all(|i| brand_by::<f64>(0.0).unwrap().sample_at(Fraction::new(i, 3)) == Some(0.0)));
/// assert_eq!(
///     brand_by::<f64>(2.0).unwrap_err().message(),
///     "brandBy() probability must be between 0 and 1, got 2"
/// );
/// ```
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
///
/// ```
/// use undertone_pattern::signal::brand;
/// use undertone_pattern::Fraction;
/// let v = brand::<f64>().sample_at(Fraction::new(1, 3)).unwrap();
/// assert!(v == 0.0 || v == 1.0);
/// ```
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

/// `+ - * /` on patterns, the operators of the reference's `.add`, `.sub`, `.mul`, and `.div`.
///
/// A number applies to every value (`pattern + 1.0`). A pattern on the right is read at each onset of the left side, so structure comes from the left; where the right side has no value the event is dropped. A signal stays a signal.
///
/// ```
/// use undertone_pattern::signal::{periodic, Shape};
/// use undertone_pattern::Fraction;
/// let sine = periodic::<f64>(Shape::Sine, false);
/// let saw = periodic::<f64>(Shape::Saw, false);
/// let sum = &sine + &saw;
/// assert!(sum.has_sampler());
/// let t = Fraction::new(1, 4);
/// assert_eq!(sum.sample_at(t), Some(1.0 + 0.25));
/// assert_eq!((&sine * 2.0 - 1.0).sample_at(t), Some(1.0));
/// ```
macro_rules! pattern_operator {
	($Trait:ident, $method:ident, $Op:ident) => {
		impl<T: Datum> core::ops::$Trait<&Pattern<T>> for &Pattern<T> {
			type Output = Pattern<T>;
			fn $method(self, rhs: &Pattern<T>) -> Pattern<T> {
				self.arith(ArithOp::$Op, rhs)
			}
		}
		impl<T: Datum> core::ops::$Trait<Pattern<T>> for Pattern<T> {
			type Output = Pattern<T>;
			fn $method(self, rhs: Pattern<T>) -> Pattern<T> {
				self.arith(ArithOp::$Op, &rhs)
			}
		}
		impl<T: Datum> core::ops::$Trait<f64> for &Pattern<T> {
			type Output = Pattern<T>;
			fn $method(self, rhs: f64) -> Pattern<T> {
				self.fmap(MapFn::$Op(rhs))
			}
		}
		impl<T: Datum> core::ops::$Trait<f64> for Pattern<T> {
			type Output = Pattern<T>;
			fn $method(self, rhs: f64) -> Pattern<T> {
				self.fmap(MapFn::$Op(rhs))
			}
		}
	};
}

pattern_operator!(Add, add, Add);
pattern_operator!(Sub, sub, Sub);
pattern_operator!(Mul, mul, Mul);
pattern_operator!(Div, div, Div);

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
