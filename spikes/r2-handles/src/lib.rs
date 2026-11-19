// Throwaway wasm-bindgen binding of the R1 pattern crate for spike R2 (handles and closures)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The binding is a handle (`Handle`) around `Pattern<Value>`. Closures given to `every` and `jux` run in
//! TypeScript at construction; only the resulting patterns cross. The two escape hatches (`foreign_map`
//! and `custom`) hold a JavaScript function and call it during a query.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use js_sys::{Array, Float64Array, Function};
use undertone_pattern::control::note;
use undertone_pattern::{CustomQuery, ForeignFn, Fraction, Hap, Pattern, Span, Value, pure, seq};
use wasm_bindgen::prelude::*;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static CREATED: AtomicUsize = AtomicUsize::new(0);

/// A JavaScript function the tree may call; wasm is single-threaded, so the `Send + Sync` claim is safe.
struct HostFn(Function, u64);
unsafe impl Send for HostFn {}
unsafe impl Sync for HostFn {}

impl ForeignFn<Value> for HostFn {
	fn call(&self, value: &Value) -> Value {
		let arg = JsValue::from_f64(value.as_number().unwrap_or(f64::NAN));
		let out = self
			.0
			.call1(&JsValue::NULL, &arg)
			.unwrap_or(JsValue::from_f64(f64::NAN));
		Value::Num(out.as_f64().unwrap_or(f64::NAN))
	}
	fn id(&self) -> u64 {
		self.1
	}
}

impl CustomQuery<Value> for HostFn {
	fn query(&self, span: Span) -> Vec<Hap<Value>> {
		let b = JsValue::from_f64(span.begin.to_f64());
		let e = JsValue::from_f64(span.end.to_f64());
		let out = self
			.0
			.call2(&JsValue::NULL, &b, &e)
			.unwrap_or(JsValue::NULL);
		let rows = Array::from(&out);
		rows.iter()
			.map(|row| {
				let row = Float64Array::new(&row).to_vec();
				Hap {
					whole: None,
					part: Span::new(
						Fraction::from_f64(row[0]).unwrap_or(Fraction::from_int(0)),
						Fraction::from_f64(row[1]).unwrap_or(Fraction::from_int(0)),
					),
					value: Value::Num(row[2]),
				}
			})
			.collect()
	}
	fn id(&self) -> u64 {
		self.1
	}
}

/// A pattern handle. wasm-bindgen frees it from its finalizer when `--weak-refs` is on.
#[wasm_bindgen]
pub struct Handle(Pattern<Value>);

impl Drop for Handle {
	fn drop(&mut self) {
		LIVE.fetch_sub(1, Ordering::Relaxed);
	}
}

fn wrap(p: Pattern<Value>) -> Handle {
	LIVE.fetch_add(1, Ordering::Relaxed);
	CREATED.fetch_add(1, Ordering::Relaxed);
	Handle(p)
}

fn err(e: undertone_pattern::Error) -> JsError {
	JsError::new(e.message())
}

/// Handles alive now (created minus dropped).
#[wasm_bindgen]
pub fn live_handles() -> usize {
	LIVE.load(Ordering::Relaxed)
}

/// Handles created since the module started.
#[wasm_bindgen]
pub fn created_handles() -> usize {
	CREATED.load(Ordering::Relaxed)
}

/// The linear memory's current size in bytes.
#[wasm_bindgen]
pub fn memory_bytes() -> usize {
	core::arch::wasm32::memory_size(0) * 65536
}

/// `note("...")`.
#[wasm_bindgen]
pub fn note_handle(text: &str) -> Result<Handle, JsError> {
	note(text).map(wrap).map_err(err)
}

/// `seq` of `n` numbers 0..n (a 32-step pattern for the foreign-leaf timing).
#[wasm_bindgen]
pub fn counting_handle(n: u32) -> Handle {
	wrap(seq((0..n).map(|i| pure(Value::Num(i as f64))).collect()))
}

/// `new Pattern(query)`: a pattern defined by a JavaScript query function.
#[wasm_bindgen]
pub fn custom_handle(query: Function, id: u32) -> Handle {
	wrap(Pattern::custom(Arc::new(HostFn(query, id as u64))))
}

#[wasm_bindgen]
impl Handle {
	/// `rev()`.
	pub fn rev(&self) -> Handle {
		wrap(self.0.rev())
	}

	/// `fast(factor)`.
	pub fn fast(&self, factor: f64) -> Result<Handle, JsError> {
		self.0.fast(factor).map(wrap).map_err(err)
	}

	/// `every(n, fn)` after the wrapper ran `fn`: `transformed` is the pattern it returned.
	pub fn every_with(&self, n: f64, transformed: &Handle) -> Result<Handle, JsError> {
		self.0
			.every(n, |_| transformed.0.clone())
			.map(wrap)
			.map_err(err)
	}

	/// `jux(fn)` after the wrapper ran `fn`.
	pub fn jux_with(&self, transformed: &Handle) -> Result<Handle, JsError> {
		self.0.jux(&transformed.0).map(wrap).map_err(err)
	}

	/// `fmap(fn)` as a foreign leaf: `f` is called once per hap during every query.
	pub fn fmap_foreign(&self, f: Function, id: u32) -> Handle {
		wrap(self.0.foreign_map(Arc::new(HostFn(f, id as u64))))
	}

	/// The haps of cycles `from..to`, flat: part begin, part end, whole begin, whole end (NaN when none),
	/// and the numeric value (NaN when the value is not a number) for each.
	pub fn query(&self, from: f64, to: f64) -> Vec<f64> {
		let span = Span::new(
			Fraction::from_int(from as i128),
			Fraction::from_int(to as i128),
		);
		let haps = self.0.query(span);
		let mut flat = Vec::with_capacity(haps.len() * 5);
		for hap in &haps {
			flat.push(hap.part.begin.to_f64());
			flat.push(hap.part.end.to_f64());
			flat.push(hap.whole.map_or(f64::NAN, |w| w.begin.to_f64()));
			flat.push(hap.whole.map_or(f64::NAN, |w| w.end.to_f64()));
			flat.push(hap.value.as_number().unwrap_or(f64::NAN));
		}
		flat
	}

	/// The number of haps over cycles `from..to`, without copying them out (isolates the boundary cost).
	pub fn count(&self, from: f64, to: f64) -> usize {
		let span = Span::new(
			Fraction::from_int(from as i128),
			Fraction::from_int(to as i128),
		);
		self.0.query(span).len()
	}

	/// The tree as an s-expression.
	pub fn describe(&self) -> String {
		self.0.to_string()
	}
}
