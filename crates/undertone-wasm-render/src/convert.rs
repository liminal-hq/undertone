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
