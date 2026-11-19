// Patterns as an Arc node tree: queries from cycle spans to haps, built from data and no closures
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Pattern`], its [`Node`] tree, and the base constructors.
//!
//! A pattern is a function from a span of cycle time to the haps overlapping it. Here that function is not a closure but a tree of [`Node`]s that every consumer can walk: print, hash, send to another thread, or (later) serialise. The nodes are immutable and shared through `Arc`, so a transform builds a new root over the old tree.

use crate::control::{Control, ControlInput, query_with_control};
use crate::error::{Error, Result};
use crate::fraction::Fraction;
use crate::hap::{Hap, Span};
use crate::js;
use crate::signal::Signal;
use crate::value::{Datum, MapFn};
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
	/// Each cycle of the child reversed in time (a cycle-local mirror).
	Rev(Pattern<T>),
	/// `transformed` on every `n`th cycle (0, n, 2n, ...) and `base` on the others. The transform was applied to `base` when the pattern was built, so the tree holds the result, not the function.
	Every {
		/// The cycle count, above zero.
		n: i128,
		/// The pattern on the other cycles.
		base: Pattern<T>,
		/// The pattern on every `n`th cycle.
		transformed: Pattern<T>,
	},
	/// Each section plays for its own whole cycles, in order, looping, and experiences its own cycles from 0.
	Arrange(Vec<(i128, Pattern<T>)>),
	/// A voice-parameter control merged into every hap of the child, read at the hap's onset.
	WithControl {
		/// The pattern that gives the structure.
		child: Pattern<T>,
		/// Which control is set.
		control: Control,
		/// Where its value comes from.
		input: ControlInput<T>,
	},
	/// A continuous pattern with no structure (`sine`, `rand`, ...), read at a point.
	Signal(Signal<T>),
	/// The hap structure of `structure`, each holding the source's value at its onset (the reading side of a signal's `euclid`).
	Sample {
		/// The pattern read at each onset.
		source: Pattern<T>,
		/// The rhythm that gives the haps.
		structure: Pattern<bool>,
	},
	/// `count` evenly spaced haps per cycle, each holding the source's value at its onset.
	Segment {
		/// The pattern read at each onset.
		source: Pattern<T>,
		/// The number of haps per cycle, above zero.
		count: Fraction,
		/// `pure(true)` sped up by `count`, kept so a query does not rebuild it.
		structure: Pattern<bool>,
	},
	/// The child with each value changed by a named map (`fmap`, `range`, `scale`, a voice patch).
	Map {
		/// The pattern whose values change.
		child: Pattern<T>,
		/// The change.
		f: MapFn,
	},
	/// Each value of `left` combined with `right` read at the value's onset; a hap is dropped where `right` has no value.
	Arith {
		/// The pattern that gives the structure.
		left: Pattern<T>,
		/// The operation.
		op: ArithOp,
		/// The pattern read at each onset.
		right: Pattern<T>,
	},
	/// `n(pattern)`: each number of the child floored into a scale degree; anything else is a rest.
	Degrees(Pattern<T>),
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

/// A binary operation on two numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArithOp {
	/// `a + b`.
	Add,
	/// `a - b`.
	Sub,
	/// `a * b`.
	Mul,
	/// `a / b` (by 0 gives Infinity).
	Div,
}

impl ArithOp {
	/// The operation applied to two numbers.
	pub fn apply(self, a: f64, b: f64) -> f64 {
		match self {
			ArithOp::Add => a + b,
			ArithOp::Sub => a - b,
			ArithOp::Mul => a * b,
			ArithOp::Div => a / b,
		}
	}

	/// The method name the reference uses.
	pub fn name(self) -> &'static str {
		match self {
			ArithOp::Add => "add",
			ArithOp::Sub => "sub",
			ArithOp::Mul => "mul",
			ArithOp::Div => "div",
		}
	}
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

/// The section of an arrangement playing in `cycle`, and the shift that makes its pattern experience its own cycles from 0, restarting at the top of every pass.
fn section_at<T>(sections: &[(i128, Pattern<T>)], cycle: i128) -> (&Pattern<T>, Fraction) {
	let total: i128 = sections.iter().map(|(cycles, _)| cycles).sum();
	let local = cycle.rem_euclid(total);
	let mut start = 0;
	for (cycles, pattern) in sections {
		if local < start + cycles {
			return (pattern, Fraction::from_int(cycle - (local - start)));
		}
		start += cycles;
	}
	unreachable!("local is below the total, so a section holds it")
}

/// Calls `f` with each piece of `span` that lies within one cycle, in order (the allocation-free form of [`Span::split_into_cycles`]).
fn for_each_cycle(span: Span, mut f: impl FnMut(Span)) {
	let mut begin = span.begin;
	while begin < span.end {
		let end = begin.next_sam().min(span.end);
		f(Span::new(begin, end));
		begin = end;
	}
}

/// Applies `f` to every time of the haps in `haps`, in place.
fn retime<T>(haps: &mut [Hap<T>], f: impl Fn(Fraction) -> Fraction) {
	for hap in haps {
		hap.whole = hap.whole.map(|w| w.map(&f));
		hap.part = hap.part.map(&f);
	}
}

/// Queries `pattern` over `span` as if it were `offset` cycles earlier, and appends the haps moved back to their place.
fn query_shifted<T: Datum>(
	pattern: &Pattern<T>,
	span: Span,
	offset: Fraction,
	out: &mut Vec<Hap<T>>,
) {
	if offset == Fraction::from_int(0) {
		pattern.query_into(span, out);
		return;
	}
	let start = out.len();
	pattern.query_into(span.map(|t| t - offset), out);
	retime(&mut out[start..], |t| t + offset);
}

/// Keeps the haps from `start` on for which `keep` returns true (it may also change them), preserving order.
fn keep_tail<T>(out: &mut Vec<Hap<T>>, start: usize, mut keep: impl FnMut(&mut Hap<T>) -> bool) {
	let mut write = start;
	for read in start..out.len() {
		if keep(&mut out[read]) {
			out.swap(write, read);
			write += 1;
		}
	}
	out.truncate(write);
}

/// The haps of `structure` over `span`, each holding `source`'s value at its onset (dropped where `source` has none).
fn read_at<T: Datum>(source: &Pattern<T>, structure: &Pattern<bool>, span: Span) -> Vec<Hap<T>> {
	structure
		.query(span)
		.into_iter()
		.filter_map(|hap| {
			let value = source.sample_at(hap.onset())?;
			Some(Hap {
				whole: hap.whole,
				part: hap.part,
				value,
			})
		})
		.collect()
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
		let mut out = Vec::new();
		self.node.query_into(span, &mut out);
		out
	}

	/// Appends every hap overlapping `span` to `out`, in the order [`Pattern::query`] returns them: the form for a caller that queries many times and reuses one vector (clear it between queries).
	///
	/// ```
	/// use undertone_pattern::{pure, Fraction, Span};
	/// let mut haps = Vec::new();
	/// let p = pure(1.0);
	/// for cycle in 0..3 {
	///     haps.clear();
	///     p.query_into(Span::new(Fraction::from_int(cycle), Fraction::from_int(cycle + 1)), &mut haps);
	///     assert_eq!(haps.len(), 1);
	/// }
	/// ```
	pub fn query_into(&self, span: Span, out: &mut Vec<Hap<T>>) {
		self.node.query_into(span, out);
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
	/// Reverses each cycle in time (a cycle-local mirror, the classic `rev`).
	///
	/// ```
	/// use undertone_pattern::{pure, seq, Fraction, Span};
	/// let p = seq(vec![pure(1.0), pure(2.0)]).rev();
	/// let mut haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	/// haps.sort_by_key(|h| h.part.begin);
	/// assert_eq!(haps[0].value, 2.0);
	/// ```
	pub fn rev(&self) -> Pattern<T> {
		Pattern::from_node(Node::Rev(self.clone()))
	}

	/// Applies a transform on every `n`th cycle (cycles 0, n, 2n, ...). `n` is a JavaScript number and must be a positive integer.
	///
	/// The transform is a function of the pattern that runs once, here; the tree keeps the pattern it returned. That is the closure-at-construction rule: nothing in the tree calls back.
	///
	/// ```
	/// use undertone_pattern::{pure, seq, Fraction, Span};
	/// let p = seq(vec![pure(1.0), pure(2.0)]);
	/// let every = p.every(2.0, |p| p.rev()).unwrap();
	/// let values = |a, b| {
	///     let mut haps = every.query(Span::new(Fraction::from_int(a), Fraction::from_int(b)));
	///     haps.sort_by_key(|h| h.part.begin);
	///     haps.iter().map(|h| h.value).collect::<Vec<f64>>()
	/// };
	/// let (first, second) = (values(0, 1), values(1, 2));
	/// assert_eq!(first, [2.0, 1.0]);
	/// assert_eq!(second, [1.0, 2.0]);
	/// ```
	pub fn every(
		&self,
		n: f64,
		transform: impl FnOnce(&Pattern<T>) -> Pattern<T>,
	) -> Result<Pattern<T>> {
		if !js::is_integer(n) || n <= 0.0 {
			return Err(Error::new(alloc::format!(
				"every() cycle count must be a positive integer, got {}",
				js::number_to_string(n)
			)));
		}
		let transformed = transform(self);
		Ok(Pattern::from_node(Node::Every {
			n: n as i128,
			base: self.clone(),
			transformed,
		}))
	}

	/// `count` evenly spaced haps per cycle, each holding this pattern's value at its onset: the way to give a signal a rhythm.
	pub fn segment(&self, count: f64) -> Result<Pattern<T>> {
		if count.is_nan() || count <= 0.0 || !count.is_finite() {
			return Err(Error::new(alloc::format!(
				"segment() count must be positive, got {}",
				js::number_to_string(count)
			)));
		}
		let structure = pure(true).fast(count)?;
		Ok(Pattern::from_node(Node::Segment {
			source: self.clone(),
			count: Fraction::from_f64(count)?,
			structure,
		}))
	}

	/// The pattern with each value changed by a named map: `fmap` without a closure.
	pub fn map(&self, f: MapFn) -> Pattern<T> {
		Pattern::from_node(Node::Map {
			child: self.clone(),
			f,
		})
	}

	/// Combines each value with the values of `other` read at the value's onset (structure from the left; a hap is dropped where `other` has no value).
	pub fn arith(&self, op: ArithOp, other: &Pattern<T>) -> Pattern<T> {
		Pattern::from_node(Node::Arith {
			left: self.clone(),
			op,
			right: other.clone(),
		})
	}

	/// Maps values from 0..1 onto `lo..hi`, linearly (no clamping).
	pub fn range(&self, lo: f64, hi: f64) -> Pattern<T> {
		self.map(MapFn::Range { lo, hi })
	}

	/// Maps values from -1..1 onto `lo..hi`, linearly.
	pub fn range2(&self, lo: f64, hi: f64) -> Pattern<T> {
		self.map(MapFn::Range2 { lo, hi })
	}

	/// Maps values from 0..1 onto `lo..hi` exponentially (`lo * (hi / lo) ** v`), the curve for frequencies. Both bounds must be above 0.
	pub fn rangex(&self, lo: f64, hi: f64) -> Result<Pattern<T>> {
		if !(lo > 0.0 && hi > 0.0 && lo.is_finite() && hi.is_finite()) {
			return Err(Error::new(alloc::format!(
				"rangex() bounds must be positive, got {} and {}",
				js::number_to_string(lo),
				js::number_to_string(hi)
			)));
		}
		Ok(self.map(MapFn::Rangex { lo, ratio: hi / lo }))
	}

	/// Rounds each value to the nearest whole number (halves round up).
	pub fn round(&self) -> Pattern<T> {
		self.map(MapFn::Round)
	}

	/// Rounds each value down (-4.2 becomes -5).
	pub fn floor(&self) -> Pattern<T> {
		self.map(MapFn::Floor)
	}

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
		if self.has_sampler() {
			// On a signal it acts as a structure: the rhythm's haps, each holding the signal's value at its onset.
			let structure = seq(slots
				.into_iter()
				.map(|on| if on { pure(true) } else { silence() })
				.collect());
			return Ok(Pattern::from_node(Node::Sample {
				source: self.clone(),
				structure,
			}));
		}
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
			| Node::Rev(child)
			| Node::Map { child, .. }
			| Node::Foreign { child, .. } => child.has_sampler(),
			Node::Every {
				base, transformed, ..
			} => base.has_sampler() || transformed.has_sampler(),
			Node::Arrange(sections) => sections.iter().any(|(_, p)| p.has_sampler()),
			Node::Arith { left, .. } => left.has_sampler(),
			Node::Signal(_) => true,
			Node::WithControl { .. }
			| Node::Sample { .. }
			| Node::Segment { .. }
			| Node::Degrees(_) => false,
			Node::Custom(custom) => custom.has_sampler(),
		}
	}

	/// The haps overlapping `span`.
	pub fn query(&self, span: Span) -> Vec<Hap<T>> {
		let mut out = Vec::new();
		self.query_into(span, &mut out);
		out
	}

	/// Appends the haps overlapping `span` to `out`, in the order [`Node::query`] returns them.
	///
	/// This is the query itself: a node asks its children to append straight into the same vector and then rewrites the new tail in place (shifting or mirroring time, changing values, dropping haps), so a query allocates only the output, not one list per node and cycle.
	pub fn query_into(&self, span: Span, out: &mut Vec<Hap<T>>) {
		match self {
			Node::Silence => {}
			Node::Pure(value) => {
				for_each_cycle(span, |part| {
					let sam = part.begin.sam();
					out.push(Hap {
						whole: Some(Span::new(sam, sam + Fraction::from_int(1))),
						part,
						value: value.clone(),
					});
				});
			}
			Node::Stack(children) => {
				for child in children {
					child.query_into(span, out);
				}
			}
			Node::Cat(children) => for_each_cycle(span, |cycle_span| {
				let (index, offset) = cat_choice(cycle_span.begin.floor(), children.len());
				query_shifted(&children[index], cycle_span, offset, out);
			}),
			Node::Compress { begin, end, child } => {
				// Both are needed only for a clipped query or an event inside the child's cycle, so they are worked out on demand.
				let width = || *end - *begin;
				let one = Fraction::from_int(1);
				let whole_cycle = *begin == Fraction::from_int(0) && *end == one;
				for_each_cycle(span, |cycle_span| {
					let cycle = cycle_span.begin.sam();
					let window = Span::new(cycle + *begin, cycle + *end);
					let Some(clipped) = cycle_span.intersect(&window) else {
						return;
					};
					if whole_cycle {
						child.query_into(clipped, out);
						return;
					}
					// A query that covers the whole window asks for the child's whole cycle.
					let inner = if clipped == window {
						Span::new(cycle, cycle + one)
					} else {
						{
							let inverse = one / width();
							clipped.map(|t| cycle + (t - window.begin) * inverse)
						}
					};
					let start = out.len();
					child.query_into(inner, out);
					// The ends of the child's cycle (what `pure` and most leaves return) map to the ends of the window without arithmetic.
					let next_cycle = cycle + one;
					retime(&mut out[start..], |t| {
						if t == cycle {
							window.begin
						} else if t == next_cycle {
							window.end
						} else {
							window.begin + (t - cycle) * width()
						}
					});
				});
			}
			Node::Fast { factor, child } => {
				let start = out.len();
				child.query_into(span.map(|t| t * *factor), out);
				let inverse = Fraction::from_int(1) / *factor;
				retime(&mut out[start..], |t| t * inverse);
			}
			Node::Slow { factor, child } => {
				let start = out.len();
				child.query_into(span.map(|t| t / *factor), out);
				retime(&mut out[start..], |t| t * *factor);
			}
			Node::Rev(child) => for_each_cycle(span, |cycle_span| {
				// Mirror around the cycle's midpoint: t -> cycle + (cycle + 1 - t).
				let axis = cycle_span.begin.sam() * Fraction::from_int(2) + Fraction::from_int(1);
				let reflect = |s: Span| Span::new(axis - s.end, axis - s.begin);
				let start = out.len();
				child.query_into(reflect(cycle_span), out);
				for hap in &mut out[start..] {
					hap.whole = hap.whole.map(reflect);
					hap.part = reflect(hap.part);
				}
			}),
			Node::Every {
				n,
				base,
				transformed,
			} => for_each_cycle(span, |cycle_span| {
				let pick = if cycle_span.begin.floor().rem_euclid(*n) == 0 {
					transformed
				} else {
					base
				};
				pick.query_into(cycle_span, out);
			}),
			Node::Arrange(sections) => for_each_cycle(span, |cycle_span| {
				let (pattern, offset) = section_at(sections, cycle_span.begin.floor());
				query_shifted(pattern, cycle_span, offset, out);
			}),
			Node::WithControl {
				child,
				control,
				input,
			} => out.extend(query_with_control(child, *control, input, span)),
			Node::Signal(signal) => {
				if span.begin < span.end {
					out.push(Hap {
						whole: None,
						part: span,
						value: signal.at(span.begin),
					});
				}
			}
			Node::Sample { source, structure }
			| Node::Segment {
				source, structure, ..
			} => out.extend(read_at(source, structure, span)),
			Node::Map { child, f } => {
				let start = out.len();
				child.query_into(span, out);
				for hap in &mut out[start..] {
					hap.value = hap.value.apply(f);
				}
			}
			Node::Arith { left, op, right } => {
				let start = out.len();
				left.query_into(span, out);
				keep_tail(out, start, |hap| {
					let Some(other) = right.sample_at(hap.onset()) else {
						return false;
					};
					hap.value = match (hap.value.as_number(), other.as_number()) {
						(Some(a), Some(b)) => T::from_number(op.apply(a, b)),
						_ => T::from_number(f64::NAN),
					};
					true
				});
			}
			Node::Degrees(child) => {
				let start = out.len();
				child.query_into(span, out);
				keep_tail(out, start, |hap| {
					let Some(n) = hap.value.as_number().filter(|n| n.is_finite()) else {
						return false;
					};
					hap.value = T::from_degree(crate::math::floor(n));
					true
				});
			}
			Node::Foreign { child, f } => {
				let start = out.len();
				child.query_into(span, out);
				for hap in &mut out[start..] {
					hap.value = f.call(&hap.value);
				}
			}
			Node::Custom(custom) => out.extend(custom.query(span)),
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
			Node::Rev(child) => {
				// A point mirrors to a point: c + x reads c + 1 - x.
				let cycle = t.sam();
				child.sample_at(cycle + (cycle + Fraction::from_int(1) - t))
			}
			Node::Every {
				n,
				base,
				transformed,
			} => {
				let pick = if t.floor().rem_euclid(*n) == 0 {
					transformed
				} else {
					base
				};
				pick.sample_at(t)
			}
			Node::Arrange(sections) => {
				let (pattern, offset) = section_at(sections, t.floor());
				pattern.sample_at(t - offset)
			}
			Node::Signal(signal) => Some(signal.at(t)),
			Node::Map { child, f } => child.sample_at(t).map(|value| value.apply(f)),
			Node::Arith { left, op, right } => {
				let a = left.sample_at(t)?;
				let b = right.sample_at(t)?;
				Some(match (a.as_number(), b.as_number()) {
					(Some(a), Some(b)) => T::from_number(op.apply(a, b)),
					_ => T::from_number(f64::NAN),
				})
			}
			Node::WithControl { .. }
			| Node::Sample { .. }
			| Node::Segment { .. }
			| Node::Degrees(_) => None,
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

/// Plays each pattern for its own span of whole cycles, in order, looping once the total is reached: the backbone of a multi-section song.
///
/// Each section's pattern experiences its own cycles from 0 whenever its span begins, so `<a b c>` inside a section opens on `a` wherever the section falls. Cycle counts are JavaScript numbers and must be positive integers.
///
/// ```
/// use undertone_pattern::{arrange, pure, Fraction, Span};
/// let song = arrange(vec![(2.0, pure(1.0)), (1.0, pure(2.0))]).unwrap();
/// let haps = song.query(Span::new(Fraction::from_int(0), Fraction::from_int(4)));
/// let values: Vec<f64> = haps.iter().map(|h| h.value).collect();
/// assert_eq!(values, [1.0, 1.0, 2.0, 1.0]);
/// ```
pub fn arrange<T: Datum>(sections: Vec<(f64, Pattern<T>)>) -> Result<Pattern<T>> {
	for (cycles, _) in &sections {
		if !js::is_integer(*cycles) || *cycles <= 0.0 {
			return Err(Error::new(alloc::format!(
				"arrange() cycle counts must be positive integers, got {}",
				js::number_to_string(*cycles)
			)));
		}
	}
	if sections.is_empty() {
		return Ok(silence());
	}
	Ok(Pattern::from_node(Node::Arrange(
		sections
			.into_iter()
			.map(|(cycles, pattern)| (cycles as i128, pattern))
			.collect(),
	)))
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
			Node::Rev(child) => {
				f.write_str("(rev ")?;
				child.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Every {
				n,
				base,
				transformed,
			} => {
				write!(f, "(every {n} ")?;
				base.node.write_tree(f)?;
				f.write_str(" ")?;
				transformed.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Arrange(sections) => {
				f.write_str("(arrange")?;
				for (cycles, pattern) in sections {
					write!(f, " ({cycles} ")?;
					pattern.node.write_tree(f)?;
					f.write_str(")")?;
				}
				f.write_str(")")
			}
			Node::WithControl {
				child,
				control,
				input,
			} => {
				let (kind, source) = match input {
					ControlInput::Literal(p) => ("literal", p),
					ControlInput::Pattern(p) => ("pattern", p),
				};
				write!(f, "(control {} {kind} ", control.name())?;
				source.node.write_tree(f)?;
				f.write_str(" ")?;
				child.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Signal(signal) => write!(f, "(signal {signal:?})"),
			Node::Sample { source, structure } => {
				f.write_str("(sample ")?;
				source.node.write_tree(f)?;
				f.write_str(" ")?;
				structure.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Segment { source, count, .. } => {
				write!(f, "(segment {count} ")?;
				source.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Map { child, f: map } => {
				write!(f, "(map {map:?} ")?;
				child.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Arith { left, op, right } => {
				write!(f, "({} ", op.name())?;
				left.node.write_tree(f)?;
				f.write_str(" ")?;
				right.node.write_tree(f)?;
				f.write_str(")")
			}
			Node::Degrees(child) => {
				f.write_str("(degrees ")?;
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
	use alloc::string::ToString;

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
