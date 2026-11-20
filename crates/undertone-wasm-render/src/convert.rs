// Errors and JavaScript's own number and string conversions, the few the render module needs
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The render module's share of the main module's `convert.rs`: a Rust error as a JavaScript `Error` with the same
//! message, and JavaScript's `String(value)` and `Number(value)`. No value conversion: voices arrive as numbers
//! (`crate::flat`).

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
	/// The global `String(value)`.
	#[wasm_bindgen(catch, js_name = String)]
	fn js_string(value: &JsValue) -> Result<String, JsValue>;

	/// The global `Number(value)`.
	#[wasm_bindgen(catch, js_name = Number)]
	fn js_number(value: &JsValue) -> Result<f64, JsValue>;
}

/// `Number(value)`; `NaN` when it throws.
pub fn to_number(value: &JsValue) -> f64 {
	value
		.as_f64()
		.unwrap_or_else(|| js_number(value).unwrap_or(f64::NAN))
}

/// `String(value)`; `"(unprintable)"` when that throws.
pub fn string_of(value: &JsValue) -> String {
	if let Some(text) = value.as_string() {
		return text;
	}
	js_string(value).unwrap_or_else(|_| "(unprintable)".into())
}

/// `String(x)` for a number, by JavaScript itself (the pattern crate's `host-number-format`).
pub fn number_text(x: f64) -> String {
	js_string(&JsValue::from_f64(x)).unwrap_or_default()
}

/// `Number(text)` for a string, by JavaScript itself (the pattern crate's `host-number-format`).
pub fn text_number(text: &str) -> f64 {
	js_number(&JsValue::from_str(text)).unwrap_or(f64::NAN)
}

/// A JavaScript `Error` with `message`, word for word.
pub fn error(message: &str) -> JsValue {
	js_sys::Error::new(message).into()
}

/// A Rust error as a JavaScript `Error` with the same message.
pub fn rust_error(err: impl core::fmt::Display) -> JsValue {
	error(&err.to_string())
}

/// How many items a JavaScript array given to the module may hold, as in the main module's `convert.rs` (a sparse array's
/// length is set by a number alone, so it is checked before anything is reserved or read).
pub const MAX_ARRAY_LEN: u32 = 1 << 22;

/// The most a vector reserves for an array before its items are read.
const FIRST_RESERVE: usize = 1024;

/// The items of `array` (a hole reads as `undefined`), or an `Error` when it is over [`MAX_ARRAY_LEN`]; `what` names it.
pub fn array_items(array: &js_sys::Array, what: &str) -> Result<Vec<JsValue>, JsValue> {
	let length = array.length();
	if length > MAX_ARRAY_LEN {
		return Err(error(&format!(
			"{what} may be at most {MAX_ARRAY_LEN} items wide, got {length}"
		)));
	}
	let mut items = Vec::with_capacity((length as usize).min(FIRST_RESERVE));
	items.extend(array.iter());
	Ok(items)
}

/// The items of a list the caller gave, as a plain value: a parameter typed `Vec<String>` or `Vec<Float32Array>` is read by the
/// generated glue, which gives `length * 4` bytes and walks every item before Rust runs, so a sparse array with a huge
/// length would stop the instance before [`MAX_ARRAY_LEN`] could be checked. An export takes a `JsValue` and reads it here.
pub fn list_items(value: &JsValue, what: &str) -> Result<Vec<JsValue>, JsValue> {
	if !js_sys::Array::is_array(value) {
		return Err(error(&format!("{what} must be an array")));
	}
	array_items(value.unchecked_ref(), what)
}

/// The strings of a list the caller gave (see [`list_items`]); an item that is not a string is an `Error`.
pub fn string_items(value: &JsValue, what: &str) -> Result<Vec<String>, JsValue> {
	list_items(value, what)?
		.iter()
		.map(|item| {
			item.as_string()
				.ok_or_else(|| error(&format!("{what} must be strings")))
		})
		.collect()
}

/// The channels of a list the caller gave (see [`list_items`]), each copied out of its `Float32Array`.
pub fn channel_items(value: &JsValue, what: &str) -> Result<Vec<Vec<f32>>, JsValue> {
	list_items(value, what)?
		.iter()
		.map(|item| match item.dyn_ref::<js_sys::Float32Array>() {
			Some(channel) => Ok(channel.to_vec()),
			None => Err(error(&format!("{what} must be Float32Arrays"))),
		})
		.collect()
}
