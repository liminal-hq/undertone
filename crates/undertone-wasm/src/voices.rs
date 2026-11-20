// The render options, read from JavaScript, and the voices a render plays, collected in the main module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `renderToBuffer(pattern, options)` starts in the main module (section 13 of `docs/rust-migration/results/M6-BOUNDARY.md`):
//! [`collect_voices`] checks the options with the reference's messages in its order ([`RenderPlan::new`], then the
//! master bus's options), queries the pattern, and returns a [`WasmVoices`]: the voices as plain data. The wrapper hands
//! [`WasmVoices::encoded`] (one `Float64Array` and the strings it indexes, [`crate::flat`]) and [`WasmVoices::options`] to
//! the lazily loaded render module (`undertone-wasm-render`), which plans the render again from the same options, books
//! the voices, and either renders them itself (D-14, the default) or records the booking for the wrapper to replay on
//! the caller's offline context (`renderToBuffer(pattern, { context })`).
//!
//! The pattern is never sent anywhere: a foreign (JavaScript) leaf is queried here, on the main thread, as the
//! reference queries it.

use js_sys::{Array, Float64Array, Object, Reflect};
use undertone::engine::engine::Engine;
use undertone::engine::render::RenderPlan;
use undertone::pattern::Value;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::convert::rust_error;
use crate::foreign::guarded;
use crate::options::render_options;
use crate::pattern::WasmPattern;
use crate::record::RecordGraph;
use crate::score::WasmScore;
use crate::warnings::queried;

/// The voices of a render and its plan. See the [module documentation](self).
#[wasm_bindgen]
pub struct WasmVoices {
	/// The options the render module is to plan with (a score's carry its tempo).
	options: JsValue,
	values: Vec<(f64, Value)>,
}

/// Checks the plan's master bus options (`createMasterBus`'s messages) before anything is queried, as a render that
/// makes its engine first fails on them first.
fn check_master(plan: &RenderPlan) -> Result<(), JsValue> {
	let graph = RecordGraph::new(plan.sample_rate, plan.channels, plan.channels);
	Engine::new(graph, plan.output_setup())
		.map(|_| ())
		.map_err(rust_error)
}

fn collect(
	pattern: &undertone::pattern::Pattern<Value>,
	plan: RenderPlan,
	options: JsValue,
) -> Result<WasmVoices, JsValue> {
	check_master(&plan)?;
	let values = guarded(|| queried(|| plan.collect_values(pattern)))?.map_err(rust_error)?;
	Ok(WasmVoices { options, values })
}

/// `renderToBuffer(pattern, options)`, its first half: the options checked and the pattern's voices collected.
#[wasm_bindgen(js_name = collectVoices)]
pub fn collect_voices(pattern: &WasmPattern, options: JsValue) -> Result<WasmVoices, JsValue> {
	let plan = RenderPlan::new(&render_options(&options)).map_err(rust_error)?;
	collect(pattern.pattern(), plan, options)
}

#[wasm_bindgen]
impl WasmScore {
	/// `score.render(options)`, its first half: one pass at the score's own tempo (`bpm`, `cps`, and `seconds` should
	/// be left out; `bpm` fails with the reference's message).
	#[wasm_bindgen(js_name = collectVoices)]
	pub fn collect_voices(&self, options: JsValue) -> Result<WasmVoices, JsValue> {
		let plan = self
			.score()
			.render_plan(&render_options(&options))
			.map_err(rust_error)?;
		let copy = Object::assign(&Object::new(), options.unchecked_ref::<Object>());
		let _ = Reflect::set(
			&copy,
			&JsValue::from_str("cps"),
			&JsValue::from_f64(self.cps()),
		);
		collect(self.score().pattern(), plan, copy.into())
	}
}

#[wasm_bindgen]
impl WasmVoices {
	/// How many voices the render books.
	#[wasm_bindgen(getter)]
	pub fn length(&self) -> usize {
		self.values.len()
	}

	/// The options to hand the render module with the voices (a score's carry its `cps`).
	#[wasm_bindgen(getter)]
	pub fn options(&self) -> JsValue {
		self.options.clone()
	}

	/// The voices as flat data for the render module: `[Float64Array, string[]]` ([`crate::flat`]).
	pub fn encoded(&self) -> Array {
		let flat = crate::flat::encode(&self.values);
		let strings: Array = flat.strings.iter().map(|s| JsValue::from_str(s)).collect();
		Array::of2(&Float64Array::from(flat.numbers.as_slice()), &strings)
	}
}
