// The foreign leaves: JavaScript queries, maps, and signals behind ForeignIds, held in a thread-local table
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `new Pattern(query, sampler?)`, `fmap(fn)`, and `signal(fn)` with JavaScript functions (section 2 of
//! `docs/rust-migration/results/M6-BOUNDARY.md`).
//!
//! Each becomes a [`Node::Foreign`](undertone::pattern::Node::Foreign) leaf whose host, [`JsLeaf`], holds nothing but
//! its id, so it is `Send + Sync` with no `unsafe`. The JavaScript functions live in this module's thread-local table,
//! keyed by the id: on the thread that made the leaf a query finds them, on any other thread the table is empty and
//! the leaf is silence. Dropping the last tree that holds a leaf drops its [`JsLeaf`], which removes the entry and so
//! releases the functions.
//!
//! The table is never borrowed while JavaScript runs (an entry is cloned out first), so a callback may build or
//! query other patterns. A callback that throws, or returns something the bridge cannot read, records the failure
//! with [`fail`] and answers nothing; [`guarded`] around the export turns the first recorded failure into the
//! export's error, unchanged.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::sync::Arc;

use js_sys::{Array, Float64Array, Function};
use undertone::pattern::{ForeignHost, ForeignId, Fraction, Hap, Pattern, Span, Value};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::convert::{error, from_js, list_to_js};
use crate::encode::{Part, callback_part, decode};

/// What one foreign leaf calls.
#[derive(Clone)]
pub enum Entry {
	/// `new Pattern(query, sampler?)`: `query(beginN, beginD, endN, endD)` returns `[Float64Array, values, big?]`; `sampler(n, d)` returns a value or `undefined`.
	Query {
		/// The query function.
		query: Function,
		/// The point sampler, when the pattern is continuous.
		sample: Option<Function>,
	},
	/// `fmap(fn)`: `map(values)` returns the array of mapped values, one call per query.
	Map {
		/// The pattern whose values are mapped.
		child: Pattern<Value>,
		/// The batched map: an array of values in, an array of values out.
		map: Function,
	},
	/// `signal(fn)`: `signal(t)` with the cycle time as a number.
	Signal {
		/// The function of time.
		signal: Function,
	},
}

struct Table {
	next: u32,
	live: BTreeMap<u32, Entry>,
}

thread_local! {
	static TABLE: RefCell<Table> = const { RefCell::new(Table { next: 0, live: BTreeMap::new() }) };
	static FAILURE: Cell<Option<JsValue>> = const { Cell::new(None) };
}

/// Records the first failure of a callback during the export that is running.
pub fn fail(thrown: JsValue) {
	FAILURE.with(|slot| {
		let first = slot.take().unwrap_or(thrown);
		slot.set(Some(first));
	});
}

/// Runs an export's body and turns the first callback failure recorded during it into its error. A failure recorded by an outer export (a callback that called this one) is kept for that export.
pub fn guarded<T>(run: impl FnOnce() -> T) -> Result<T, JsValue> {
	let outer = FAILURE.with(Cell::take);
	let out = run();
	match FAILURE.with(|slot| slot.replace(outer)) {
		Some(thrown) => Err(thrown),
		None => Ok(out),
	}
}

/// Registers `entry` and returns its leaf.
pub fn leaf(entry: Entry) -> Result<Pattern<Value>, JsValue> {
	let id = TABLE
		.with(|table| {
			let mut table = table.try_borrow_mut().ok()?;
			let id = table.next;
			table.next = id.checked_add(1)?;
			table.live.insert(id, entry);
			Some(id)
		})
		.ok_or_else(|| error("the bridge cannot register another JavaScript function"))?;
	Ok(Pattern::foreign(Arc::new(JsLeaf(id)), ForeignId(id)))
}

/// The number of foreign entries alive: a diagnostic for the tests.
pub fn live_entries() -> usize {
	TABLE.with(|table| table.try_borrow().map_or(0, |table| table.live.len()))
}

fn entry(id: u32) -> Option<Entry> {
	TABLE
		.try_with(|table| table.try_borrow().ok()?.live.get(&id).cloned())
		.ok()
		.flatten()
}

/// The host of one foreign leaf: its id, and nothing that is not `Send + Sync`.
pub struct JsLeaf(u32);

impl Drop for JsLeaf {
	fn drop(&mut self) {
		// The entry is dropped after the borrow ends: it may hold a child pattern whose own leaves borrow the table as they drop.
		let removed = TABLE
			.try_with(|table| table.try_borrow_mut().ok()?.live.remove(&self.0))
			.ok()
			.flatten();
		drop(removed);
	}
}

fn part_args(fraction: &Fraction, args: &Array) {
	match callback_part(fraction) {
		Part::Numbers(n, d) => {
			args.push(&JsValue::from_f64(n));
			args.push(&JsValue::from_f64(d));
		}
		Part::Text(text) => {
			args.push(&JsValue::from_f64(f64::NAN));
			args.push(&JsValue::from_str(&text));
		}
	}
}

/// Reads a host query's result, `[Float64Array, values, big?]`, into haps.
fn read_haps(result: &JsValue) -> Result<Vec<Hap<Value>>, JsValue> {
	let shape = || {
		error(
			"a JavaScript query must return [Float64Array, values] or [Float64Array, values, big]",
		)
	};
	if !Array::is_array(result) {
		return Err(shape());
	}
	let parts: &Array = result.unchecked_ref();
	let times = parts
		.get(0)
		.dyn_into::<Float64Array>()
		.map_err(|_| shape())?
		.to_vec();
	let values = parts.get(1);
	if !Array::is_array(&values) {
		return Err(shape());
	}
	let values = values
		.unchecked_ref::<Array>()
		.iter()
		.map(|value| from_js(&value))
		.collect::<Result<Vec<_>, _>>()?;
	let big = parts.get(2);
	let big = if big.is_undefined() {
		Vec::new()
	} else if Array::is_array(&big) {
		big.unchecked_ref::<Array>()
			.iter()
			.map(|text| text.as_string().ok_or_else(shape))
			.collect::<Result<Vec<_>, _>>()?
	} else {
		return Err(shape());
	};
	decode(&times, &values, &big).map_err(|message| error(&message))
}

/// Maps values through a batched map function: one call, an array in, an array of the same length out.
fn map_values(map: &Function, values: &[&Value]) -> Result<Vec<Value>, JsValue> {
	let out = map.call1(&JsValue::UNDEFINED, &list_to_js(values))?;
	if !Array::is_array(&out) {
		return Err(error("fmap()'s batched map must return an array"));
	}
	let out: &Array = out.unchecked_ref();
	if out.length() as usize != values.len() {
		return Err(error(
			"fmap()'s batched map must return one value per value",
		));
	}
	out.iter().map(|value| from_js(&value)).collect()
}

impl JsLeaf {
	fn query_entry(entry: Entry, span: Span, out: &mut Vec<Hap<Value>>) -> Result<(), JsValue> {
		match entry {
			Entry::Query { query, .. } => {
				let args = Array::new();
				part_args(&span.begin, &args);
				part_args(&span.end, &args);
				out.extend(read_haps(&query.apply(&JsValue::UNDEFINED, &args)?)?);
			}
			Entry::Map { child, map } => {
				let mut haps = Vec::new();
				child.query_into(span, &mut haps);
				if haps.is_empty() {
					return Ok(());
				}
				let values: Vec<&Value> = haps.iter().map(|hap| &hap.value).collect();
				let mapped = map_values(&map, &values)?;
				out.extend(haps.iter().zip(mapped).map(|(hap, value)| Hap {
					whole: hap.whole,
					part: hap.part,
					value,
				}));
			}
			Entry::Signal { signal } => {
				if span.begin < span.end {
					let value = signal
						.call1(&JsValue::UNDEFINED, &JsValue::from_f64(span.begin.to_f64()))?;
					out.push(Hap {
						whole: None,
						part: span,
						value: from_js(&value)?,
					});
				}
			}
		}
		Ok(())
	}

	fn sample_entry(entry: Entry, t: Fraction) -> Result<Option<Value>, JsValue> {
		match entry {
			Entry::Query { sample: None, .. } => Ok(None),
			Entry::Query {
				sample: Some(sample),
				..
			} => {
				let args = Array::new();
				part_args(&t, &args);
				let value = sample.apply(&JsValue::UNDEFINED, &args)?;
				if value.is_undefined() {
					Ok(None)
				} else {
					from_js(&value).map(Some)
				}
			}
			Entry::Map { child, map } => match child.sample_at(t) {
				None => Ok(None),
				Some(value) => Ok(map_values(&map, &[&value])?.pop()),
			},
			Entry::Signal { signal } => {
				let value = signal.call1(&JsValue::UNDEFINED, &JsValue::from_f64(t.to_f64()))?;
				from_js(&value).map(Some)
			}
		}
	}
}

impl ForeignHost<Value> for JsLeaf {
	fn query(&self, _id: ForeignId, span: Span, out: &mut Vec<Hap<Value>>) {
		if let Some(entry) = entry(self.0)
			&& let Err(thrown) = JsLeaf::query_entry(entry, span, out)
		{
			fail(thrown);
		}
	}

	fn sample(&self, _id: ForeignId, t: Fraction) -> Option<Value> {
		let entry = entry(self.0)?;
		JsLeaf::sample_entry(entry, t).unwrap_or_else(|thrown| {
			fail(thrown);
			None
		})
	}

	fn has_sampler(&self, _id: ForeignId) -> bool {
		match entry(self.0) {
			Some(Entry::Query { sample, .. }) => sample.is_some(),
			Some(Entry::Map { child, .. }) => child.has_sampler(),
			Some(Entry::Signal { .. }) => true,
			None => false,
		}
	}
}
