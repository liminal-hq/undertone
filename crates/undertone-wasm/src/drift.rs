// drift(pattern, options) as an export, with the options coerced as the reference's JavaScript reads them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! API-MAPPING group 17: `drift(pattern, options)`.
//!
//! The reference takes any JavaScript value for an option (`results/M3-NOTES.md`, "For the bridge"), so the options are
//! read here as `drift.ts` reads them, in its order, before a typed [`DriftOptions`] is built:
//!
//! - **`seed`:** a number is a number seed; anything else is the text `${seed}` makes of it (`undefined` when it is
//!   missing), with its own UTF-16 code units, so a lone surrogate half keys the stream as it does in JavaScript.
//! - **`cyclesPerPass`:** `?? 1`, then it must be a number that is a positive integer, or the reference's message
//!   with `String(value)` (`got 2` for the string `'2'`).
//! - **`timing`, `level`, `cents`, `pan`:** a missing one is 0, and `!(value >= 0)` fails with `String(value)`; `null`
//!   compares as 0 and passes, and a numeric string passes and is used as its number, as JavaScript's arithmetic does.
//! - **`push`:** `Number(value)` (a missing one is 0, `null` is 0). The reference adds a string `push` to the nudge as
//!   text, which a voice parameter cannot hold; that one case differs.

use js_sys::{JsString, Reflect};
use undertone::pattern::drift::{DriftOptions, cycles_per_pass_error, drift, negative_range_error};
use undertone::pattern::random::Seed;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::convert::{error, rust_error, string_of, to_number};
use crate::pattern::{WasmPattern, wrap};

/// The options as [`DriftOptions`], or the reference's error.
pub fn drift_options(options: &JsValue) -> Result<DriftOptions, JsValue> {
	if options.is_undefined() || options.is_null() {
		return Err(error(&format!(
			"drift() needs an options object with a seed, got {}",
			string_of(options)
		)));
	}
	let get =
		|key: &str| Reflect::get(options, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED);
	let seed_value = get("seed");
	let mut drift_options = match seed_value.as_f64() {
		Some(number) => DriftOptions::new(Seed::Num(number)),
		None => {
			let text: JsString = match seed_value.dyn_ref::<JsString>() {
				Some(text) => text.clone(),
				None => JsString::from(string_of(&seed_value).as_str()),
			};
			let rust = String::from(&text);
			let units: Vec<u16> = text.iter().collect();
			let mut built = DriftOptions::new(Seed::Str(rust.clone()));
			if !rust.encode_utf16().eq(units.iter().copied()) {
				built.seed_utf16 = Some(units);
			}
			built
		}
	};
	let cycles = get("cyclesPerPass");
	if !(cycles.is_undefined() || cycles.is_null()) {
		match cycles.as_f64() {
			Some(number) => drift_options.cycles_per_pass = number,
			None => return Err(rust_error(cycles_per_pass_error(&string_of(&cycles)))),
		}
	}
	drift_options.validate().map_err(rust_error)?;
	for name in ["timing", "level", "cents", "pan"] {
		let value = get(name);
		if value.is_undefined() {
			continue;
		}
		let number = to_number(&value);
		if number.is_nan() || number < 0.0 {
			return Err(rust_error(negative_range_error(name, &string_of(&value))));
		}
		match name {
			"timing" => drift_options.timing = number,
			"level" => drift_options.level = number,
			"cents" => drift_options.cents = number,
			_ => drift_options.pan = number,
		}
	}
	let push = get("push");
	if !push.is_undefined() {
		drift_options.push = to_number(&push);
	}
	Ok(drift_options)
}

/// `drift(pattern, options)`: seeded per-note humanisation of timing, level, pitch, and pan.
#[wasm_bindgen(js_name = drift)]
pub fn drift_js(pattern: &WasmPattern, options: JsValue) -> Result<WasmPattern, JsValue> {
	wrap(drift(pattern.pattern(), drift_options(&options)?))
}
