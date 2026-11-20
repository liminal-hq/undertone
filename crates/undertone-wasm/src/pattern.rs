// The pattern handle: WasmPattern over Pattern<Value>, its queries in the flat encoding, and the list builder
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`WasmPattern`], the handle JavaScript holds for a `Pattern<Value>`, and [`PatternList`], the borrowing builder
//! of the list constructors (sections 1 and 3 of `docs/rust-migration/results/M6-BOUNDARY.md`).
//!
//! Every method borrows its receiver and returns a new handle. [`WasmPattern::query`] returns the flat hap encoding
//! of [`crate::encode`]; a query runs inside [`guarded`], so an exception a JavaScript leaf throws during it is the
//! query's own exception.

use std::sync::atomic::{AtomicU32, Ordering};

use js_sys::{Array, Float64Array, Function};
use undertone::pattern::{Fraction, Hap, Pattern, Span, Value};
use wasm_bindgen::prelude::*;

use crate::convert::{error, list_to_js, rust_error, to_js};
use crate::encode::{self, fraction_from_parts, fraction_from_text};
use crate::foreign::{Entry, guarded, leaf};

static LIVE: AtomicU32 = AtomicU32::new(0);

/// A pattern handle: `Pattern<Value>` behind a pointer JavaScript holds. Freed by the garbage collector (`--weak-refs`) or at once by `free()`.
#[wasm_bindgen]
pub struct WasmPattern(Pattern<Value>);

impl WasmPattern {
	/// Wraps a pattern in a new handle.
	pub fn new(pattern: Pattern<Value>) -> WasmPattern {
		LIVE.fetch_add(1, Ordering::Relaxed);
		WasmPattern(pattern)
	}

	/// The pattern this handle holds.
	pub fn pattern(&self) -> &Pattern<Value> {
		&self.0
	}
}

impl Drop for WasmPattern {
	fn drop(&mut self) {
		LIVE.fetch_sub(1, Ordering::Relaxed);
	}
}

/// A result of the pattern crate as a handle or a JavaScript `Error`.
pub fn wrap(result: undertone::pattern::Result<Pattern<Value>>) -> Result<WasmPattern, JsValue> {
	result.map(WasmPattern::new).map_err(rust_error)
}

fn time(numerator: f64, denominator: f64) -> Result<Fraction, JsValue> {
	fraction_from_parts(numerator, denominator).map_err(|message| error(&message))
}

fn time_text(text: &str) -> Result<Fraction, JsValue> {
	fraction_from_text(text).map_err(|message| error(&message))
}

/// Haps as `[times, values, big]`: a `Float64Array` of [`encode::STRIDE`] numbers per hap, the values by index, and the texts of big fractions (`undefined` when there are none).
fn encoded(haps: &[Hap<Value>]) -> Array {
	let flat = encode::encode(haps);
	let times = Float64Array::from(flat.times.as_slice());
	let values = list_to_js(&flat.values);
	let big: JsValue = if flat.big.is_empty() {
		JsValue::UNDEFINED
	} else {
		flat.big
			.iter()
			.map(|text| JsValue::from_str(text))
			.collect::<Array>()
			.into()
	};
	Array::of3(&times, &values, &big)
}

#[wasm_bindgen]
impl WasmPattern {
	/// The haps overlapping `[begin, end)`, each time two safe integers: `[times, values, big]` (see [`crate::encode`]). A JavaScript leaf's exception during the query is thrown as it was.
	pub fn query(
		&self,
		begin_n: f64,
		begin_d: f64,
		end_n: f64,
		end_d: f64,
	) -> Result<Array, JsValue> {
		self.query_span(Span::new(time(begin_n, begin_d)?, time(end_n, end_d)?))
	}

	/// [`WasmPattern::query`] with the times as text (`"1/3"`, `"4"`), for fractions beyond the safe range.
	#[wasm_bindgen(js_name = queryRatio)]
	pub fn query_ratio(&self, begin: &str, end: &str) -> Result<Array, JsValue> {
		self.query_span(Span::new(time_text(begin)?, time_text(end)?))
	}

	fn query_span(&self, span: Span) -> Result<Array, JsValue> {
		let haps = guarded(|| self.0.try_query(span))?.map_err(rust_error)?;
		Ok(encoded(&haps))
	}

	/// The value at the instant `n/d`, or `undefined` in a rest (the reference's `sampleAt`).
	#[wasm_bindgen(js_name = sampleAt)]
	pub fn sample_at(&self, n: f64, d: f64) -> Result<JsValue, JsValue> {
		self.sample_fraction(time(n, d)?)
	}

	/// [`WasmPattern::sample_at`] with the instant as text.
	#[wasm_bindgen(js_name = sampleAtRatio)]
	pub fn sample_at_ratio(&self, t: &str) -> Result<JsValue, JsValue> {
		self.sample_fraction(time_text(t)?)
	}

	fn sample_fraction(&self, t: Fraction) -> Result<JsValue, JsValue> {
		let value = guarded(|| self.0.sample_at(t))?;
		Ok(value.as_ref().map_or(JsValue::UNDEFINED, to_js))
	}

	/// Whether the pattern has a point sampler (it is continuous, a signal, or built over one): the wrapper's `.sample` is defined exactly then.
	#[wasm_bindgen(js_name = hasSampler)]
	pub fn has_sampler(&self) -> bool {
		self.0.has_sampler()
	}

	/// A second handle to the same tree, for a transform's thunk to hand back (section 2 of the boundary document): Rust takes the clone, so the caller's handle stays usable.
	#[allow(clippy::should_implement_trait)]
	pub fn clone(&self) -> WasmPattern {
		WasmPattern::new(self.0.clone())
	}

	/// The tree as an s-expression, for diagnostics (`(fast 2 (pure 1))`).
	pub fn describe(&self) -> String {
		self.0.describe()
	}
}

/// `new Pattern(query, sampler?)` with JavaScript functions: a foreign leaf. `query(beginN, beginD, endN, endD)` returns `[Float64Array, values, big?]` in the flat encoding; `sample(n, d)` returns the value at an instant or `undefined`. A time beyond the safe range reaches either as `NaN` and its text.
#[wasm_bindgen(js_name = fromQuery)]
pub fn from_query(query: Function, sample: Option<Function>) -> Result<WasmPattern, JsValue> {
	leaf(Entry::Query { query, sample }).map(WasmPattern::new)
}

/// Handles alive now (made minus dropped): a diagnostic for the bridge's handle tests, not public API.
#[wasm_bindgen(js_name = liveHandles)]
pub fn live_handles() -> u32 {
	LIVE.load(Ordering::Relaxed)
}

/// JavaScript functions held by foreign leaves now: a diagnostic, not public API.
#[wasm_bindgen(js_name = liveForeignFunctions)]
pub fn live_foreign_functions() -> u32 {
	crate::foreign::live_entries() as u32
}

/// The linear memory's size in bytes (it only grows): a diagnostic, not public API.
#[wasm_bindgen(js_name = memoryBytes)]
pub fn memory_bytes() -> f64 {
	#[cfg(target_arch = "wasm32")]
	{
		(core::arch::wasm32::memory_size(0) * 65_536) as f64
	}
	#[cfg(not(target_arch = "wasm32"))]
	{
		0.0
	}
}

/// The borrowing builder of a list of patterns for `seq`, `cat`, `stack`, `timecat`, and `arrange`: a handle given in a JavaScript array would be moved out and its JavaScript object nulled (R5), so each item is pushed and borrowed instead.
#[wasm_bindgen]
#[derive(Default)]
pub struct PatternList(Vec<(f64, Pattern<Value>)>);

#[wasm_bindgen]
impl PatternList {
	/// An empty list.
	#[wasm_bindgen(constructor)]
	pub fn new() -> PatternList {
		PatternList(Vec::new())
	}

	/// Adds a pattern with weight 1 (borrowed: the handle stays usable).
	pub fn push(&mut self, pattern: &WasmPattern) {
		self.0.push((1.0, pattern.0.clone()));
	}

	/// Adds a pattern with a weight: `timecat`'s weight, or `arrange`'s cycle count.
	#[wasm_bindgen(js_name = pushWeighted)]
	pub fn push_weighted(&mut self, weight: f64, pattern: &WasmPattern) {
		self.0.push((weight, pattern.0.clone()));
	}

	/// How many patterns the list holds.
	#[wasm_bindgen(getter)]
	pub fn length(&self) -> u32 {
		self.0.len() as u32
	}
}

impl PatternList {
	/// The patterns, without their weights.
	pub fn patterns(&self) -> Vec<Pattern<Value>> {
		self.0.iter().map(|(_, pattern)| pattern.clone()).collect()
	}

	/// The patterns with their weights.
	pub fn weighted(&self) -> Vec<(f64, Pattern<Value>)> {
		self.0.clone()
	}
}
