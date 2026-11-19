// Patterns as an Arc node tree: queries from cycle spans to haps, built from data and no closures
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Pattern`], its [`Node`] tree, and the base constructors.
//!
//! A pattern is a function from a span of cycle time to the haps overlapping it. Here that function is not a closure but a tree of [`Node`]s that every consumer can walk: print, hash, send to another thread, or (later) serialise. The nodes are immutable and shared through `Arc`, so a transform builds a new root over the old tree.

use crate::error::{Error, Result};
use crate::fraction::Fraction;
use crate::hap::{Hap, Span};
use crate::js;
use crate::value::Datum;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec::Vec;
use core::fmt;

/// One node of a pattern tree. Every variant holds data only: fractions, numbers, and child patterns.
///
/// The two exceptions are [`Node::Foreign`] and [`Node::Custom`], the escape hatches for behaviour that only the host can supply (a JavaScript function, a hand-written query). No other variant holds a function.
pub enum Node<T> {
	/// No haps, ever.
	Silence,
	/// One hap per cycle holding the value.
	Pure(T),
	/// All children at once.
	Stack(Vec<Pattern<T>>),
	/// One child per cycle, in rotation (Tidal's `slowcat`); each child experiences its own consecutive cycles.
	Cat(Vec<Pattern<T>>),
	/// Each cycle of the child squeezed into the window `[begin, end)` of every cycle: the building block of `seq` and `timecat`.
	Compress {
		/// The window's start, within `[0, 1]`.
		begin: Fraction,
		/// The window's end, within `[0, 1]`.
		end: Fraction,
		/// The squeezed pattern.
		child: Pattern<T>,
	},
	/// The child sped up by `factor`.
	Fast {
		/// How many times faster, above zero.
		factor: Fraction,
		/// The sped-up pattern.
		child: Pattern<T>,
	},
	/// The child slowed down by `factor`.
	Slow {
		/// How many times slower, above zero.
		factor: Fraction,
		/// The slowed pattern.
		child: Pattern<T>,
	},
	/// Escape hatch: the child with each value changed by a function only the host has (a JavaScript `fmap` callback). The tree prints and hashes the function by its [`ForeignFn::id`].
	Foreign {
		/// The pattern whose values the host function changes.
		child: Pattern<T>,
		/// The host's function.
		f: Arc<dyn ForeignFn<T>>,
	},
	/// Escape hatch: a pattern the host defines by its own query (the reference's `new Pattern(query)`).
	Custom(Arc<dyn CustomQuery<T>>),
}

/// A value-changing function supplied by the host, for [`Node::Foreign`].
///
/// This is one of the two places the tree holds behaviour it cannot inspect, so the pattern is queried on the host's thread of control and cannot be sent to a worklet.
pub trait ForeignFn<T>: Send + Sync {
	/// The new value for `value`.
	fn call(&self, value: &T) -> T;
	/// A stable name for printing and hashing: a handle number, say.
	fn id(&self) -> u64;
}

/// A pattern defined by a host query, for [`Node::Custom`].
pub trait CustomQuery<T>: Send + Sync {
	/// The haps overlapping `span`.
	fn query(&self, span: Span) -> Vec<Hap<T>>;
	/// The value at the instant `t`, when [`CustomQuery::has_sampler`] is true.
	fn sample(&self, _t: Fraction) -> Option<T> {
		None
	}
	/// Whether the pattern is continuous and can be read at a point.
	fn has_sampler(&self) -> bool {
		false
	}
	/// A stable name for printing and hashing.
	fn id(&self) -> u64;
}

/// A pattern: an immutable, cheaply clonable tree of [`Node`]s.
///
/// The tree is `Send + Sync` whenever its values are, so a pattern built on one thread can be queried on another.
pub struct Pattern<T> {
	node: Arc<Node<T>>,
	sampler: bool,
}

impl<T> Clone for Pattern<T> {
	fn clone(&self) -> Self {
		Pattern {
			node: Arc::clone(&self.node),
			sampler: self.sampler,
		}
	}
}

/// Cycle `cycle` of a cat of `len` children: the child's index, and the shift that makes it experience its own consecutive cycles (what makes `<a <b c>>` unfold as a b a c).
fn cat_choice(cycle: i128, len: usize) -> (usize, Fraction) {
	let len = len as i128;
	let index = cycle.rem_euclid(len);
	let offset = Fraction::from_int(cycle - cycle.div_euclid(len));
	(index as usize, offset)
}

impl<T: Datum> Pattern<T> {
	/// A pattern from a node.
	pub fn from_node(node: Node<T>) -> Pattern<T> {
		let sampler = node.has_sampler();
		Pattern {
			node: Arc::new(node),
			sampler,
		}
	}

	/// The root node of the tree.
	pub fn node(&self) -> &Node<T> {
		&self.node
	}

	/// Whether the pattern carries a point sampler: it is continuous (a signal), or built over something that is.
	pub fn has_sampler(&self) -> bool {
		self.sampler
	}

	/// Every hap overlapping `span`, in the order the tree produces them.
	///
	/// ```
	/// use undertone_pattern::{pure, Fraction, Span};
	/// let haps = pure(1.0).query(Span::new(Fraction::from_int(0), Fraction::new(3, 2)));
	/// assert_eq!(haps.len(), 2);
	/// assert_eq!(haps[1].part.end, Fraction::new(3, 2));
	/// assert_eq!(haps[1].whole.unwrap().end, Fraction::from_int(2));
	/// ```
	pub fn query(&self, span: Span) -> Vec<Hap<T>> {
		self.node.query(span)
	}

	/// The pattern's value at the instant `t`: the sampler's when there is one, otherwise the value of the first hap over `[t, next cycle)` whose part covers `t` (`None` in a rest).
	pub fn sample_at(&self, t: Fraction) -> Option<T> {
		if self.sampler {
			return self.node.sample(t);
		}
		self.query(Span::new(t, t.next_sam()))
			.into_iter()
			.find(|hap| hap.part.begin <= t && t < hap.part.end)
			.map(|hap| hap.value)
	}

	/// Speeds the pattern up: `fast(2)` squeezes two cycles into every one.
	///
	/// The factor is a JavaScript number, as in the reference, so `0.75` and `1.5` work and a non-positive factor is an error.
	///
	/// ```
	/// use undertone_pattern::{pure, Fraction, Span};
	/// let fast = pure(1.0).fast(2.0).unwrap();
	/// assert_eq!(fast.query(Span::new(Fraction::from_int(0), Fraction::from_int(1))).len(), 2);
	/// assert_eq!(pure(1.0).fast(0.0).unwrap_err().message(), "fast() factor must be positive, got 0");
	/// ```
	pub fn fast(&self, factor: f64) -> Result<Pattern<T>> {
		let f = Fraction::from_f64(factor)?;
		if f.numerator() <= 0 {
			return Err(Error::new(alloc::format!(
				"fast() factor must be positive, got {}",
				js::number_to_string(factor)
			)));
		}
		Ok(Pattern::from_node(Node::Fast {
			factor: f,
			child: self.clone(),
		}))
	}

	/// Slows the pattern down: `slow(2)` stretches one cycle over two.
	pub fn slow(&self, factor: f64) -> Result<Pattern<T>> {
		let f = Fraction::from_f64(factor)?;
		if f.numerator() <= 0 {
			return Err(Error::new(alloc::format!(
				"slow() factor must be positive, got {}",
				js::number_to_string(factor)
			)));
		}
		Ok(Pattern::from_node(Node::Slow {
			factor: f,
			child: self.clone(),
		}))
	}
}

impl<T: Datum> Pattern<T> {
	/// The pattern with each value changed by a host function: the escape hatch for `fmap` with a closure.
	pub fn foreign_map(&self, f: Arc<dyn ForeignFn<T>>) -> Pattern<T> {
		Pattern::from_node(Node::Foreign {
			child: self.clone(),
			f,
		})
	}

	/// A pattern defined by a host query: the escape hatch for `new Pattern(query)`.
	pub fn custom(query: Arc<dyn CustomQuery<T>>) -> Pattern<T> {
		Pattern::from_node(Node::Custom(query))
	}

	/// Distributes the pattern over a euclidean rhythm: `pulses` onsets spread as evenly as possible across `steps` slots per cycle (Bjorklund's algorithm), rotated left by `rotation` slots. The whole pattern is squeezed into each onset slot.
	///
	/// The arguments are JavaScript numbers, as in the reference, so a fractional count is an error with the reference's message.
	///
	/// ```
	/// use undertone_pattern::{pure, Fraction, Span};
	/// let tresillo = pure(1.0).euclid(3.0, 8.0, 0.0).unwrap();
	/// let haps = tresillo.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	/// let onsets: Vec<_> = haps.iter().map(|h| h.part.begin).collect();
	/// assert_eq!(onsets, [Fraction::from_int(0), Fraction::new(3, 8), Fraction::new(3, 4)]);
	/// ```
	pub fn euclid(&self, pulses: f64, steps: f64, rotation: f64) -> Result<Pattern<T>> {
		let slots = rotate(&bjorklund(pulses, steps)?, rotation)?;
		Ok(seq(slots
			.into_iter()
			.map(|on| if on { self.clone() } else { silence() })
			.collect()))
	}
}

/// Bjorklund's algorithm: distributes `pulses` onsets as evenly as possible across `steps` slots, matching the canonical euclidean rhythms (`E(3,8)` is the tresillo `x..x..x.`).
///
/// ```
/// use undertone_pattern::pattern::bjorklund;
/// let slots = bjorklund(3.0, 8.0).unwrap();
/// let text: String = slots.iter().map(|on| if *on { 'x' } else { '.' }).collect();
/// assert_eq!(text, "x..x..x.");
/// assert_eq!(bjorklund(9.0, 8.0).unwrap_err().message(), "Euclidean pulses must be between 0 and steps, got (9,8)");
/// ```
pub fn bjorklund(pulses: f64, steps: f64) -> Result<Vec<bool>> {
	if !js::is_integer(pulses) || !js::is_integer(steps) || steps <= 0.0 {
		return Err(Error::new(alloc::format!(
			"Invalid euclidean rhythm: ({},{})",
			js::number_to_string(pulses),
			js::number_to_string(steps)
		)));
	}
	if pulses < 0.0 || pulses > steps {
		return Err(Error::new(alloc::format!(
			"Euclidean pulses must be between 0 and steps, got ({},{})",
			js::number_to_string(pulses),
			js::number_to_string(steps)
		)));
	}
	let (pulses, steps) = (pulses as usize, steps as usize);
	if pulses == 0 {
		return Ok(alloc::vec![false; steps]);
	}
	let mut a: Vec<Vec<bool>> = (0..pulses).map(|_| alloc::vec![true]).collect();
	let mut b: Vec<Vec<bool>> = (0..steps - pulses).map(|_| alloc::vec![false]).collect();
	while b.len() > 1 {
		let take = a.len().min(b.len());
		let combined: Vec<Vec<bool>> = a[..take]
			.iter()
			.zip(&b[..take])
			.map(|(group, tail)| group.iter().chain(tail).copied().collect())
			.collect();
		let leftover_a: Vec<Vec<bool>> = a[take..].to_vec();
		let leftover_b: Vec<Vec<bool>> = b[take..].to_vec();
		a = combined;
		b = if leftover_a.is_empty() {
			leftover_b
		} else {
			leftover_a
		};
	}
	Ok(a.into_iter().chain(b).flatten().collect())
}

fn rotate(slots: &[bool], rotation: f64) -> Result<Vec<bool>> {
	if !js::is_integer(rotation) {
		return Err(Error::new(alloc::format!(
			"Euclidean rotation must be an integer, got {}",
			js::number_to_string(rotation)
		)));
	}
	let len = slots.len() as i128;
	let shift = (rotation as i128).rem_euclid(len) as usize;
	Ok((0..slots.len())
		.map(|i| slots[(i + shift) % slots.len()])
		.collect())
}

impl<T: Datum> Node<T> {
	/// Whether a pattern with this root carries a point sampler.
	fn has_sampler(&self) -> bool {
		match self {
			Node::Silence | Node::Pure(_) => false,
			Node::Stack(children) | Node::Cat(children) => {
				children.iter().any(Pattern::has_sampler)
			}
			Node::Compress { child, .. }
			| Node::Fast { child, .. }
			| Node::Slow { child, .. }
			| Node::Foreign { child, .. } => child.has_sampler(),
			Node::Custom(custom) => custom.has_sampler(),
		}
	}

	/// The haps overlapping `span`.
	pub fn query(&self, span: Span) -> Vec<Hap<T>> {
		match self {
			Node::Silence => Vec::new(),
			Node::Pure(value) => span
				.split_into_cycles()
				.into_iter()
				.map(|part| Hap {
					whole: Some(Span::new(part.begin.sam(), part.begin.next_sam())),
					part,
					value: value.clone(),
				})
				.collect(),
			Node::Stack(children) => children
				.iter()
				.flat_map(|child| child.query(span))
				.collect(),
			Node::Cat(children) => span
				.split_into_cycles()
				.into_iter()
				.flat_map(|cycle_span| {
					let (index, offset) = cat_choice(cycle_span.begin.floor(), children.len());
					let shifted = cycle_span.map(|t| t - offset);
					children[index]
						.query(shifted)
						.into_iter()
						.map(move |hap| hap.map_time(|t| t + offset))
						.collect::<Vec<_>>()
				})
				.collect(),
			Node::Compress { begin, end, child } => {
				let width = *end - *begin;
				span.split_into_cycles()
					.into_iter()
					.flat_map(|cycle_span| {
						let cycle = cycle_span.begin.sam();
						let window = Span::new(cycle + *begin, cycle + *end);
						let Some(clipped) = cycle_span.intersect(&window) else {
							return Vec::new();
						};
						let to_inner = |t: Fraction| cycle + (t - window.begin) / width;
						let to_outer = |t: Fraction| window.begin + (t - cycle) * width;
						child
							.query(clipped.map(to_inner))
							.into_iter()
							.map(|hap| hap.map_time(to_outer))
							.collect()
					})
					.collect()
			}
			Node::Fast { factor, child } => child
				.query(span.map(|t| t * *factor))
				.into_iter()
				.map(|hap| hap.map_time(|t| t / *factor))
				.collect(),
			Node::Slow { factor, child } => child
				.query(span.map(|t| t / *factor))
				.into_iter()
				.map(|hap| hap.map_time(|t| t * *factor))
				.collect(),
			Node::Foreign { child, f } => child
				.query(span)
				.into_iter()
				.map(|hap| {
					let value = f.call(&hap.value);
					hap.with_value(value)
				})
				.collect(),
			Node::Custom(custom) => custom.query(span),
		}
	}

	/// The value at the instant `t`, for a node whose pattern carries a sampler. This is the pass-through table: a combinator reads its child's sampler through the same time mapping its query uses.
	fn sample(&self, t: Fraction) -> Option<T> {
		match self {
			Node::Silence | Node::Pure(_) => None,
			Node::Stack(children) => children.iter().find_map(|child| child.sample_at(t)),
			Node::Cat(children) => {
				let (index, offset) = cat_choice(t.floor(), children.len());
				children[index].sample_at(t - offset)
			}
			Node::Compress { begin, end, child } => {
				let cycle = t.sam();
				let pos = t - cycle;
				if pos < *begin || pos >= *end {
					return None;
				}
				child.sample_at(cycle + (pos - *begin) / (*end - *begin))
			}
			Node::Fast { factor, child } => child.sample_at(t * *factor),
			Node::Slow { factor, child } => child.sample_at(t / *factor),
			Node::Foreign { child, f } => child.sample_at(t).map(|value| f.call(&value)),
			Node::Custom(custom) => custom.sample(t),
		}
	}
}

/// The empty pattern: querying it never returns haps.
///
/// ```
/// use undertone_pattern::{silence, Fraction, Span};
/// let rest = silence::<f64>();
/// assert!(rest.query(Span::new(Fraction::from_int(0), Fraction::from_int(4))).is_empty());
/// ```
pub fn silence<T: Datum>() -> Pattern<T> {
	Pattern::from_node(Node::Silence)
}

/// A pattern that repeats `value` once per cycle.
pub fn pure<T: Datum>(value: T) -> Pattern<T> {
	Pattern::from_node(Node::Pure(value))
}

/// Plays all the patterns simultaneously (chords, layers, parallel lines).
pub fn stack<T: Datum>(patterns: Vec<Pattern<T>>) -> Pattern<T> {
	Pattern::from_node(Node::Stack(patterns))
}

/// Plays one pattern per cycle, in rotation (Tidal's `slowcat`). No patterns give [`silence`].
///
/// ```
/// use undertone_pattern::{cat, pure, Fraction, Span};
/// let alternating = cat(vec![pure(1.0), pure(2.0)]);
/// let haps = alternating.query(Span::new(Fraction::from_int(0), Fraction::from_int(3)));
/// let values: Vec<f64> = haps.iter().map(|h| h.value).collect();
/// assert_eq!(values, [1.0, 2.0, 1.0]);
/// ```
pub fn cat<T: Datum>(patterns: Vec<Pattern<T>>) -> Pattern<T> {
	if patterns.is_empty() {
		return silence();
	}
	Pattern::from_node(Node::Cat(patterns))
}

/// Squeezes each cycle of `pattern` into the window `[begin, end)` of each cycle. A window with no width is [`silence`].
pub fn compress<T: Datum>(begin: Fraction, end: Fraction, pattern: Pattern<T>) -> Pattern<T> {
	if (end - begin).numerator() <= 0 {
		return silence();
	}
	Pattern::from_node(Node::Compress {
		begin,
		end,
		child: pattern,
	})
}

/// Plays the patterns one after another within a single cycle, each taking its `weight` of the cycle.
///
/// Weights are JavaScript numbers and must be positive; fractional weights such as `1.5` work.
///
/// ```
/// use undertone_pattern::{pure, timecat, Fraction, Span};
/// let p = timecat(vec![(1.0, pure(1.0)), (3.0, pure(2.0))]).unwrap();
/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
/// assert_eq!(haps[1].part.begin, Fraction::new(1, 4));
/// let err = timecat(vec![(0.0, pure(1.0))]).unwrap_err();
/// assert_eq!(err.message(), "timecat() weights must be positive, got 0");
/// ```
pub fn timecat<T: Datum>(pairs: Vec<(f64, Pattern<T>)>) -> Result<Pattern<T>> {
	for (weight, _) in &pairs {
		if !weight.is_finite() || *weight <= 0.0 {
			return Err(Error::new(alloc::format!(
				"timecat() weights must be positive, got {}",
				js::number_to_string(*weight)
			)));
		}
	}
	if pairs.is_empty() {
		return Ok(silence());
	}
	let mut total = Fraction::from_int(0);
	for (weight, _) in &pairs {
		total = total + Fraction::from_f64(*weight)?;
	}
	let mut pos = Fraction::from_int(0);
	let mut parts = Vec::with_capacity(pairs.len());
	for (weight, pattern) in pairs {
		let w = Fraction::from_f64(weight)?;
		let begin = pos / total;
		pos = pos + w;
		parts.push(compress(begin, pos / total, pattern));
	}
	// The windows never overlap, so at most one part has a value at any instant.
	Ok(stack(parts))
}

/// Plays the patterns one after another within a single cycle, each taking an equal share.
///
/// ```
/// use undertone_pattern::{pure, seq, Fraction, Span};
/// let p = seq(vec![pure(1.0), pure(2.0), pure(3.0)]);
/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
/// assert_eq!(haps.len(), 3);
/// ```
pub fn seq<T: Datum>(patterns: Vec<Pattern<T>>) -> Pattern<T> {
	timecat(patterns.into_iter().map(|p| (1.0, p)).collect())
		.expect("weights of 1 are always positive")
}

/// The pattern with its time sped up by `factor`: the free-function form of [`Pattern::fast`].
pub fn fast<T: Datum>(pattern: &Pattern<T>, factor: f64) -> Result<Pattern<T>> {
	pattern.fast(factor)
}

/// The pattern with its time slowed down by `factor`: the free-function form of [`Pattern::slow`].
pub fn slow<T: Datum>(pattern: &Pattern<T>, factor: f64) -> Result<Pattern<T>> {
	pattern.slow(factor)
}

// --- Printing and hashing a tree ---

impl<T: Datum> Node<T> {
	fn write_tree(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		fn list<T: Datum>(
			f: &mut fmt::Formatter<'_>,
			name: &str,
			children: &[Pattern<T>],
		) -> fmt::Result {
			write!(f, "({name}")?;
			for child in children {
				f.write_str(" ")?;
				child.node.write_tree(f)?;
			}
			f.write_str(")")
		}
		match self {
			Node::Silence => f.write_str("(silence)"),
			Node::Pure(value) => write!(f, "(pure {value:?})"),
			Node::Stack(children) => list(f, "stack", children),
			Node::Cat(children) => list(f, "cat", children),
			Node::Compress { begin, end, child } => {
				write!(f, "(compress {begin} {end} ")?;
				child.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Fast { factor, child } => {
				write!(f, "(fast {factor} ")?;
				child.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Slow { factor, child } => {
				write!(f, "(slow {factor} ")?;
				child.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Foreign { child, f: foreign } => {
				write!(f, "(foreign #{} ", foreign.id())?;
				child.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Custom(custom) => write!(f, "(custom #{})", custom.id()),
		}
	}
}

/// A tree prints as an s-expression: `(fast 2 (cat (pure "a") (pure "b")))`.
impl<T: Datum> fmt::Display for Pattern<T> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		self.node.write_tree(f)
	}
}

impl<T: Datum> fmt::Debug for Pattern<T> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "Pattern{self}")
	}
}

impl<T: Datum> Pattern<T> {
	/// A stable 64-bit hash of the tree's structure and values (FNV-1a over its printed form).
	///
	/// Two trees built the same way hash the same, in every run and on every thread, so the hash can name a tree in a cache or a test.
	///
	/// ```
	/// use undertone_pattern::{pure, seq};
	/// let a = seq(vec![pure(1.0), pure(2.0)]);
	/// let b = seq(vec![pure(1.0), pure(2.0)]);
	/// let c = seq(vec![pure(1.0), pure(3.0)]);
	/// assert_eq!(a.structural_hash(), b.structural_hash());
	/// assert_ne!(a.structural_hash(), c.structural_hash());
	/// ```
	pub fn structural_hash(&self) -> u64 {
		let text: String = alloc::format!("{self}");
		let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
		for byte in text.bytes() {
			hash ^= u64::from(byte);
			hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
		}
		hash
	}
}

impl<T: Datum> core::hash::Hash for Pattern<T> {
	fn hash<H: core::hash::Hasher>(&self, state: &mut H) {
		state.write_u64(self.structural_hash());
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn span(a: i128, b: i128) -> Span {
		Span::new(Fraction::from_int(a), Fraction::from_int(b))
	}

	fn onsets(p: &Pattern<f64>, a: i128, b: i128) -> Vec<(Fraction, f64)> {
		p.query(span(a, b))
			.into_iter()
			.map(|h| (h.part.begin, h.value))
			.collect()
	}

	#[test]
	fn nested_alternations_unfold_per_own_cycle() {
		// <a <b c>> is a b a c.
		let inner = cat(vec![pure(2.0), pure(3.0)]);
		let outer = cat(vec![pure(1.0), inner]);
		let values: Vec<f64> = onsets(&outer, 0, 4).into_iter().map(|(_, v)| v).collect();
		assert_eq!(values, [1.0, 2.0, 1.0, 3.0]);
	}

	#[test]
	fn cat_reads_negative_cycles() {
		let p = cat(vec![pure(1.0), pure(2.0), pure(3.0)]);
		let values: Vec<f64> = onsets(&p, -3, 0).into_iter().map(|(_, v)| v).collect();
		assert_eq!(values, [1.0, 2.0, 3.0]);
	}

	#[test]
	fn seq_puts_equal_shares_in_a_cycle() {
		let p = seq(vec![pure(1.0), silence(), pure(3.0)]);
		let got = onsets(&p, 0, 1);
		assert_eq!(
			got,
			[(Fraction::from_int(0), 1.0), (Fraction::new(2, 3), 3.0)]
		);
	}

	#[test]
	fn fast_and_slow_are_inverses_on_a_sequence() {
		let p = seq(vec![pure(1.0), pure(2.0)]);
		let there = p.fast(3.0).unwrap().slow(3.0).unwrap();
		assert_eq!(onsets(&there, 0, 3), onsets(&p, 0, 3));
	}

	#[test]
	fn euclid_matches_the_canonical_necklaces() {
		for (pulses, steps, text) in [
			(3.0, 4.0, "xxx."),
			(5.0, 8.0, "x.xx.xx."),
			(4.0, 4.0, "xxxx"),
			(0.0, 3.0, "..."),
		] {
			let slots = bjorklund(pulses, steps).unwrap();
			let got: String = slots.iter().map(|on| if *on { 'x' } else { '.' }).collect();
			assert_eq!(got, text, "E({pulses},{steps})");
		}
		assert_eq!(
			bjorklund(1.5, 8.0).unwrap_err().message(),
			"Invalid euclidean rhythm: (1.5,8)"
		);
	}

	#[test]
	fn prints_and_hashes_a_tree() {
		let p = seq(vec![pure(1.0), pure(2.0)]).fast(2.0).unwrap();
		assert_eq!(
			p.to_string(),
			"(fast 2 (stack (compress 0 1/2 (pure 1.0)) (compress 1/2 1 (pure 2.0))))"
		);
		assert_eq!(p.structural_hash(), p.clone().structural_hash());
	}

	#[test]
	fn a_tree_is_send_and_sync() {
		fn assert_send_sync<X: Send + Sync>() {}
		assert_send_sync::<Pattern<f64>>();
		assert_send_sync::<Pattern<crate::Value>>();
		let p = seq(vec![pure(1.0), pure(2.0)]);
		let q = p.clone();
		let from_thread = std::thread::spawn(move || onsets(&q, 0, 2)).join().unwrap();
		assert_eq!(from_thread, onsets(&p, 0, 2));
	}

	struct AddOne;
	impl ForeignFn<f64> for AddOne {
		fn call(&self, value: &f64) -> f64 {
			value + 1.0
		}
		fn id(&self) -> u64 {
			7
		}
	}

	struct Everything;
	impl CustomQuery<f64> for Everything {
		fn query(&self, span: Span) -> Vec<Hap<f64>> {
			alloc::vec![Hap {
				whole: None,
				part: span,
				value: span.begin.to_f64(),
			}]
		}
		fn id(&self) -> u64 {
			9
		}
	}

	#[test]
	fn the_escape_hatches_work_and_print() {
		let mapped = seq(vec![pure(1.0), pure(2.0)]).foreign_map(Arc::new(AddOne));
		let values: Vec<f64> = onsets(&mapped, 0, 1).into_iter().map(|(_, v)| v).collect();
		assert_eq!(values, [2.0, 3.0]);
		let custom = Pattern::custom(Arc::new(Everything));
		assert_eq!(onsets(&custom, 2, 3), [(Fraction::from_int(2), 2.0)]);
		assert_eq!(custom.to_string(), "(custom #9)");
		assert!(mapped.to_string().starts_with("(foreign #7 "));
	}
}
