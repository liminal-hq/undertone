// The Query trait and the host registry behind the Custom and Foreign escape hatches
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The two escape hatches of the node tree: [`Query`] and [`ForeignHost`].
//!
//! Almost every pattern is data (a tree of nodes). Two things cannot be, because only the caller has the behaviour, and each has one place in the tree:
//!
//! - [`Node::Custom`](crate::Node::Custom) holds a [`Query`], an object **in Rust** that answers a span with haps: a hand-written pattern, or the closure of [`Pattern::fmap_with`](crate::Pattern::fmap_with) and [`Pattern::from_fn`](crate::Pattern::from_fn). Its description prints a number that is unique to the process, so a tree holding one is not the same tree from run to run.
//! - [`Node::Foreign`](crate::Node::Foreign) holds a [`ForeignId`] and a [`ForeignHost`]: a query that lives **outside Rust**, such as a JavaScript function behind the bridge. The tree stores only the id (that is what prints and hashes) and a handle to the host that can resolve it.
//!
//! # The host registry
//!
//! The pattern crate keeps no global state and no lock, so it works on `no_std` targets: the host owns the table that turns a [`ForeignId`] into a callback, and implements [`ForeignHost`] over it however it likes (a `Vec` behind its own cell on a single-threaded WebAssembly host, a `Mutex` elsewhere). A host that does not need anything special can use `ForeignTable`, a ready-made registry built on `std`'s `Mutex` (with the `std` feature).
//!
//! The call goes both ways in the bridge (RF-25): JavaScript registers a function and receives an id, builds the leaf with [`Pattern::foreign`](crate::Pattern::foreign), and from then on a query calls the host's `query` import with the id and the span. A callback must not call back into a query of the same pattern while the host holds a lock; `ForeignTable` drops its lock before it calls the callback, so a callback may query other patterns.

use crate::fraction::Fraction;
use crate::hap::{Hap, Span};
#[cfg(feature = "std")]
use alloc::sync::Arc;
use alloc::vec::Vec;

/// Something that answers a span of cycle time with the haps that overlap it: the behaviour behind [`Node::Custom`](crate::Node::Custom) and behind each registered foreign callback.
///
/// A query must be a pure function of the span (the same span gives the same haps), because the scheduler and the worklet may ask in any order and more than once. It appends to `out` rather than returning a vector, so a query allocates nothing of its own.
///
/// ```
/// use std::sync::Arc;
/// use undertone_pattern::{Fraction, Hap, Pattern, Query, Span};
///
/// /// One hap per cycle holding the cycle number.
/// struct CycleNumber;
/// impl Query<f64> for CycleNumber {
///     fn query(&self, span: Span, out: &mut Vec<Hap<f64>>) {
///         let mut cycle = span.begin.floor();
///         while Fraction::from_int(cycle) < span.end {
///             let whole = Span::new(Fraction::from_int(cycle), Fraction::from_int(cycle + 1));
///             if let Some(part) = whole.intersect(&span) {
///                 out.push(Hap { whole: Some(whole), part, value: cycle as f64 });
///             }
///             cycle += 1;
///         }
///     }
/// }
///
/// let p = Pattern::custom(Arc::new(CycleNumber));
/// let haps = p.query(Span::new(Fraction::from_int(2), Fraction::from_int(4)));
/// let values: Vec<f64> = haps.iter().map(|h| h.value).collect();
/// assert_eq!(values, [2.0, 3.0]);
/// ```
pub trait Query<T>: Send + Sync {
	/// Appends the haps overlapping `span` to `out`.
	fn query(&self, span: Span, out: &mut Vec<Hap<T>>);

	/// The value at the instant `t`, used when [`Query::has_sampler`] is true (a continuous pattern that a control reads at a point).
	fn sample(&self, _t: Fraction) -> Option<T> {
		None
	}

	/// Whether the pattern is continuous and can be read at a point with [`Query::sample`].
	fn has_sampler(&self) -> bool {
		false
	}
}

/// The handle of a callback registered with a [`ForeignHost`]: the number a tree prints and hashes in place of behaviour it cannot inspect.
///
/// ```
/// use undertone_pattern::ForeignId;
/// assert_eq!(format!("{:?}", ForeignId(7)), "ForeignId(7)");
/// ```
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct ForeignId(pub u32);

/// The registry side of [`Node::Foreign`](crate::Node::Foreign): turns a [`ForeignId`] into a call on the host's callback.
///
/// An id that the host no longer knows (the callback was freed) is silence and has no sampler: the methods return nothing rather than panic, because a query may run on an audio thread.
///
/// ```
/// use std::sync::Arc;
/// use undertone_pattern::{ForeignHost, ForeignId, Fraction, Hap, Pattern, Span};
///
/// /// A host with one callback, numbered 1: a hap per cycle holding 42.
/// struct OneCallback;
/// impl ForeignHost<f64> for OneCallback {
///     fn query(&self, id: ForeignId, span: Span, out: &mut Vec<Hap<f64>>) {
///         if id == ForeignId(1) {
///             let whole = Span::new(span.begin.sam(), span.begin.sam() + Fraction::from_int(1));
///             out.push(Hap { whole: Some(whole), part: span, value: 42.0 });
///         }
///     }
/// }
///
/// let p = Pattern::foreign(Arc::new(OneCallback), ForeignId(1));
/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::new(1, 2)));
/// assert_eq!(haps[0].value, 42.0);
/// assert_eq!(p.to_string(), "(foreign #1)");
/// ```
pub trait ForeignHost<T>: Send + Sync {
	/// Appends the haps of callback `id` that overlap `span` to `out`.
	fn query(&self, id: ForeignId, span: Span, out: &mut Vec<Hap<T>>);

	/// The value of callback `id` at the instant `t`, when it has a sampler.
	fn sample(&self, _id: ForeignId, _t: Fraction) -> Option<T> {
		None
	}

	/// Whether callback `id` is continuous and can be read at a point. It is asked once, when the pattern is built.
	fn has_sampler(&self, _id: ForeignId) -> bool {
		false
	}
}

/// A ready-made [`ForeignHost`] on `std`'s `Mutex`: register a [`Query`], get a [`ForeignId`], build a [`Pattern`](crate::Pattern) from it.
///
/// ```
/// use std::sync::Arc;
/// use undertone_pattern::{Fraction, ForeignTable, Hap, Query, Span};
///
/// struct Constant(f64);
/// impl Query<f64> for Constant {
///     fn query(&self, span: Span, out: &mut Vec<Hap<f64>>) {
///         out.push(Hap { whole: None, part: span, value: self.0 });
///     }
/// }
///
/// let table = Arc::new(ForeignTable::<f64>::new());
/// let id = table.register(Arc::new(Constant(3.0)));
/// let p = table.pattern(id);
/// assert_eq!(p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)))[0].value, 3.0);
/// // After the host frees the callback, the pattern is silence.
/// assert!(table.unregister(id));
/// assert!(p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1))).is_empty());
/// ```
#[cfg(feature = "std")]
pub struct ForeignTable<T> {
	entries: std::sync::Mutex<ForeignEntries<T>>,
}

#[cfg(feature = "std")]
struct ForeignEntries<T> {
	next: u32,
	live: alloc::collections::BTreeMap<u32, Arc<dyn Query<T>>>,
}

#[cfg(feature = "std")]
impl<T> Default for ForeignTable<T> {
	fn default() -> Self {
		ForeignTable {
			entries: std::sync::Mutex::new(ForeignEntries {
				next: 0,
				live: alloc::collections::BTreeMap::new(),
			}),
		}
	}
}

#[cfg(feature = "std")]
impl<T> ForeignTable<T> {
	/// An empty table.
	pub fn new() -> ForeignTable<T> {
		ForeignTable::default()
	}

	/// Registers a callback and returns its id. Ids are never reused, so a freed id cannot name a different callback later.
	pub fn register(&self, query: Arc<dyn Query<T>>) -> ForeignId {
		let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
		let id = entries.next;
		entries.next = id.checked_add(1).expect("ForeignId overflow");
		entries.live.insert(id, query);
		ForeignId(id)
	}

	/// Frees a callback. Returns whether the id was registered.
	pub fn unregister(&self, id: ForeignId) -> bool {
		let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
		entries.live.remove(&id.0).is_some()
	}

	/// The number of callbacks currently registered.
	pub fn len(&self) -> usize {
		self.entries
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.live
			.len()
	}

	/// Whether no callback is registered.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	fn get(&self, id: ForeignId) -> Option<Arc<dyn Query<T>>> {
		let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
		entries.live.get(&id.0).cloned()
	}
}

#[cfg(feature = "std")]
impl<T: crate::value::Datum> ForeignTable<T> {
	/// A pattern that calls the callback `id` of this table (an `Arc` of the table is the host).
	pub fn pattern(self: &Arc<Self>, id: ForeignId) -> crate::Pattern<T> {
		crate::Pattern::foreign(Arc::clone(self) as Arc<dyn ForeignHost<T>>, id)
	}
}

#[cfg(feature = "std")]
impl<T: Send + Sync> ForeignHost<T> for ForeignTable<T> {
	fn query(&self, id: ForeignId, span: Span, out: &mut Vec<Hap<T>>) {
		// The lock is released before the callback runs, so a callback may query other patterns.
		if let Some(query) = self.get(id) {
			query.query(span, out);
		}
	}

	fn sample(&self, id: ForeignId, t: Fraction) -> Option<T> {
		self.get(id)?.sample(t)
	}

	fn has_sampler(&self, id: ForeignId) -> bool {
		self.get(id).is_some_and(|q| q.has_sampler())
	}
}
