// A half-open span of cycle time and the event (hap) a query returns
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Spans of cycle time and the haps (events) a query returns.

use crate::fraction::Fraction;

/// A half-open span of cycle time, `[begin, end)`.
///
/// ```
/// use undertone_pattern::{Fraction, Span};
/// let span = Span::new(Fraction::from_int(0), Fraction::new(1, 2));
/// assert_eq!(span.end, Fraction::new(1, 2));
/// ```
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Span {
	/// The first instant of the span.
	pub begin: Fraction,
	/// The instant the span ends at, which it does not contain.
	pub end: Fraction,
}

impl Span {
	/// The span from `begin` up to (not including) `end`.
	pub fn new(begin: Fraction, end: Fraction) -> Span {
		Span { begin, end }
	}

	/// The span in which both spans overlap, or `None` when the overlap is empty.
	pub fn intersect(&self, other: &Span) -> Option<Span> {
		let begin = self.begin.max(other.begin);
		let end = self.end.min(other.end);
		(begin < end).then_some(Span { begin, end })
	}

	/// Splits the span at cycle boundaries, so per-cycle constructs can reason one cycle at a time.
	///
	/// ```
	/// use undertone_pattern::{Fraction, Span};
	/// let span = Span::new(Fraction::new(1, 2), Fraction::new(5, 2));
	/// let cycles = span.split_into_cycles();
	/// assert_eq!(cycles.len(), 3);
	/// assert_eq!(cycles[1], Span::new(Fraction::from_int(1), Fraction::from_int(2)));
	/// ```
	pub fn split_into_cycles(&self) -> alloc::vec::Vec<Span> {
		let mut spans = alloc::vec::Vec::new();
		let mut begin = self.begin;
		while begin < self.end {
			let end = begin.next_sam().min(self.end);
			spans.push(Span { begin, end });
			begin = end;
		}
		spans
	}

	/// Applies `f` to both ends.
	pub fn map(&self, f: impl Fn(Fraction) -> Fraction) -> Span {
		Span {
			begin: f(self.begin),
			end: f(self.end),
		}
	}
}

/// One event returned by querying a pattern.
///
/// `part` is the fragment of the event inside the queried span. `whole` is the event's full extent, which may reach outside the query, and is `None` for a signal (a continuous value with no structure). A hap is an onset, and triggers a voice, only when `part` starts exactly where `whole` does.
#[derive(Clone, PartialEq, Debug)]
pub struct Hap<T> {
	/// The event's full extent, or `None` for a continuous value.
	pub whole: Option<Span>,
	/// The fragment of the event inside the query.
	pub part: Span,
	/// The event's value.
	pub value: T,
}

impl<T> Hap<T> {
	/// Whether the hap's part contains the event's onset.
	///
	/// ```
	/// use undertone_pattern::{Fraction, Hap, Span};
	/// let whole = Span::new(Fraction::from_int(0), Fraction::from_int(1));
	/// let late = Span::new(Fraction::new(1, 2), Fraction::from_int(1));
	/// assert!(Hap { whole: Some(whole), part: whole, value: () }.has_onset());
	/// assert!(!Hap { whole: Some(whole), part: late, value: () }.has_onset());
	/// assert!(!Hap { whole: None, part: whole, value: () }.has_onset());
	/// ```
	pub fn has_onset(&self) -> bool {
		self.whole.is_some_and(|w| w.begin == self.part.begin)
	}

	/// Where an event reads a signal: its onset (the whole's begin), or the part's begin when it has no whole.
	pub fn onset(&self) -> Fraction {
		self.whole.map_or(self.part.begin, |w| w.begin)
	}

	/// The same hap with its value replaced.
	pub fn with_value<U>(&self, value: U) -> Hap<U> {
		Hap {
			whole: self.whole,
			part: self.part,
			value,
		}
	}

	/// The same hap with both spans mapped through `f`.
	pub fn map_time(&self, f: impl Fn(Fraction) -> Fraction) -> Hap<T>
	where
		T: Clone,
	{
		Hap {
			whole: self.whole.map(|w| w.map(&f)),
			part: self.part.map(&f),
			value: self.value.clone(),
		}
	}
}
