// Values, errors, and JavaScript strings across the boundary: JsValue to Value by hand, Value to JsValue by serde
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! How a hap's [`Value`] and an error cross (section 3 and 4 of `docs/rust-migration/results/M6-BOUNDARY.md`).
//!
//! - **Out** (Rust to JavaScript): [`to_js`] serialises a value with `serde-wasm-bindgen`, maps as plain objects and
//!   [`Value::Undefined`] as `undefined`.
//! - **In** (JavaScript to Rust): [`from_js`] reads a value by hand. `serde-wasm-bindgen`'s deserialiser reads every
//!   safe integer as an `i64`, which turns `-0` into `0`; this keeps every number's bits.
//! - **Errors:** [`error`] makes a JavaScript `Error` with a message word for word; [`message_of`] reads one back the way
//!   the reference's `error instanceof Error ? error.message : String(error)` does.

use std::collections::BTreeMap;

use js_sys::{Array, Object, Reflect};
use serde::Serialize;
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use undertone::pattern::Value;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

/// How deep a value JavaScript gives may nest before it is refused (a cycle would otherwise recurse for ever).
pub const MAX_VALUE_DEPTH: usize = 64;

/// How many items a JavaScript array given to the module may hold (4,194,304). A sparse array's `length` is set by a
/// number alone (`new Array(0xffffffff)` costs nothing in JavaScript), so a length is checked before anything is reserved or
/// read; a wider array is an ordinary `Error`, not an allocation failure that stops the instance.
pub const MAX_ARRAY_LEN: u32 = 1 << 22;

/// The most a vector reserves for an array before its items are read (it grows from there as they come).
const FIRST_RESERVE: usize = 1024;

/// The length of `array`, or an `Error` when it is over [`MAX_ARRAY_LEN`]; `what` names the array in the message.
pub fn checked_length(array: &Array, what: &str) -> Result<usize, JsValue> {
	let length = array.length();
	if length > MAX_ARRAY_LEN {
		return Err(error(&format!(
			"{what} may be at most {MAX_ARRAY_LEN} items wide, got {length}"
		)));
	}
	Ok(length as usize)
}

/// The items of `array` (a hole reads as `undefined`), after its length is checked.
pub fn array_items(array: &Array, what: &str) -> Result<Vec<JsValue>, JsValue> {
	let length = checked_length(array, what)?;
	let mut items = Vec::with_capacity(length.min(FIRST_RESERVE));
	items.extend(array.iter());
	Ok(items)
}

/// The items of a list the caller gave, as a plain value: a parameter typed `Vec<String>` or `Vec<JsValue>` is read by the
/// generated glue, which gives `length * 4` bytes and walks every item before Rust runs, so a sparse array with a huge
/// length would stop the instance before [`MAX_ARRAY_LEN`] could be checked. An export takes a `JsValue` and reads it here.
pub fn list_items(value: &JsValue, what: &str) -> Result<Vec<JsValue>, JsValue> {
	if !Array::is_array(value) {
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

#[wasm_bindgen]
extern "C" {
	/// The global `String(value)`, which can throw (a `toString` that throws, or a symbol in some places).
	#[wasm_bindgen(catch, js_name = String)]
	fn js_string(value: &JsValue) -> Result<String, JsValue>;

	/// The global `Number(value)`, which can throw (a `valueOf` that throws, a symbol, a `BigInt` does not).
	#[wasm_bindgen(catch, js_name = Number)]
	fn js_number(value: &JsValue) -> Result<f64, JsValue>;
}

/// `Number(value)`, what JavaScript's comparisons and arithmetic make of a value (`null` is 0, `'2'` is 2); `NaN` when it throws.
pub fn to_number(value: &JsValue) -> f64 {
	value
		.as_f64()
		.unwrap_or_else(|| js_number(value).unwrap_or(f64::NAN))
}

/// `String(x)` for a number, by JavaScript itself: the formatter the pattern crate prints numbers with in the
/// WebAssembly build (`host-number-format`).
pub fn number_text(x: f64) -> String {
	js_string(&JsValue::from_f64(x)).unwrap_or_default()
}

/// `Number(text)` for a string, by JavaScript itself: the reader the pattern crate parses numbers with in the
/// WebAssembly build (`host-number-format`).
pub fn text_number(text: &str) -> f64 {
	js_number(&JsValue::from_str(text)).unwrap_or(f64::NAN)
}

/// `String(value)`, as a template string or the reference's messages print a value; `"(unprintable)"` when that throws.
pub fn string_of(value: &JsValue) -> String {
	if let Some(text) = value.as_string() {
		return text;
	}
	js_string(value).unwrap_or_else(|_| "(unprintable)".into())
}

/// A JavaScript `Error` with `message`, word for word.
pub fn error(message: &str) -> JsValue {
	js_sys::Error::new(message).into()
}

/// A pattern crate error as a JavaScript `Error` with the same message.
pub fn rust_error(err: undertone::pattern::Error) -> JsValue {
	error(err.message())
}

/// The message of a thrown value, as the reference reads one: an `Error`'s `message`, otherwise `String(value)`.
pub fn message_of(thrown: &JsValue) -> String {
	match thrown.dyn_ref::<js_sys::Error>() {
		Some(err) => String::from(err.message()),
		None => string_of(thrown),
	}
}

/// The message of a value a pattern cannot hold.
fn unholdable(value: &JsValue) -> JsValue {
	error(&format!(
		"a pattern value must be a number, a string, a boolean, undefined, an array, or a plain object, got {}",
		string_of(value)
	))
}

/// Whether `value` is a plain object: its prototype is `Object.prototype` or `null` (an object literal, `Object.create(null)`, or a parsed JSON object), not a class instance.
fn is_plain_object(value: &JsValue) -> bool {
	if !value.is_object() || value.is_function() {
		return false;
	}
	let proto = JsValue::from(Object::get_prototype_of(value));
	proto.is_null() || OBJECT_PROTOTYPE.with(|object| proto == *object)
}

thread_local! {
	/// `Object.prototype`, read once.
	static OBJECT_PROTOTYPE: JsValue = Object::get_prototype_of(&Object::new()).into();
}

/// A JavaScript value as a [`Value`]: a number (bit for bit, `-0` and `NaN` included), a string, a boolean, `undefined`, an array of values, or a plain object of values. Anything else (`null`, a class instance, a function, a symbol, a `BigInt`) is an error.
pub fn from_js(value: &JsValue) -> Result<Value, JsValue> {
	from_js_at(value, 0)
}

fn from_js_at(value: &JsValue, depth: usize) -> Result<Value, JsValue> {
	if let Some(number) = value.as_f64() {
		return Ok(Value::Num(number));
	}
	if let Some(text) = value.as_string() {
		return Ok(Value::Str(text));
	}
	if let Some(flag) = value.as_bool() {
		return Ok(Value::Bool(flag));
	}
	if value.is_undefined() {
		return Ok(Value::Undefined);
	}
	if depth >= MAX_VALUE_DEPTH {
		return Err(error(&format!(
			"a pattern value may nest at most {MAX_VALUE_DEPTH} levels deep"
		)));
	}
	if Array::is_array(value) {
		let array: &Array = value.unchecked_ref();
		let length = checked_length(array, "a pattern value's array")?;
		let mut items = Vec::with_capacity(length.min(FIRST_RESERVE));
		for item in array.iter() {
			items.push(from_js_at(&item, depth + 1)?);
		}
		return Ok(Value::List(items));
	}
	if is_plain_object(value) {
		let object: &Object = value.unchecked_ref();
		let mut fields = BTreeMap::new();
		for key in Object::keys(object).iter() {
			let field = Reflect::get(value, &key)?;
			fields.insert(string_of(&key), from_js_at(&field, depth + 1)?);
		}
		return Ok(Value::Map(fields));
	}
	Err(unholdable(value))
}

/// The serialiser every value leaves through: plain objects for maps, `undefined` for [`Value::Undefined`] (not `null`, which `Serializer::json_compatible` would give).
fn serializer() -> serde_wasm_bindgen::Serializer {
	serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true)
}

/// A [`Value`] as JavaScript.
pub fn to_js(value: &Value) -> JsValue {
	Out(value)
		.serialize(&serializer())
		.unwrap_or(JsValue::UNDEFINED)
}

/// A list of values as one JavaScript array, in one serialisation.
pub fn list_to_js(values: &[&Value]) -> JsValue {
	OutList(values)
		.serialize(&serializer())
		.unwrap_or_else(|_| Array::new().into())
}

/// A borrowed [`Value`] that serde can write: the pattern crate has no `serde` (by design), so the bridge says how.
pub struct Out<'a>(pub &'a Value);

impl Serialize for Out<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		match self.0 {
			Value::Num(number) => serializer.serialize_f64(*number),
			Value::Str(text) => serializer.serialize_str(text),
			Value::Bool(flag) => serializer.serialize_bool(*flag),
			Value::Undefined => serializer.serialize_unit(),
			Value::List(items) => {
				let mut seq = serializer.serialize_seq(Some(items.len()))?;
				for item in items {
					seq.serialize_element(&Out(item))?;
				}
				seq.end()
			}
			Value::Map(fields) => {
				let mut map = serializer.serialize_map(Some(fields.len()))?;
				for (key, field) in fields {
					map.serialize_entry(key, &Out(field))?;
				}
				map.end()
			}
		}
	}
}

/// A list of borrowed values that serde writes as one array.
pub struct OutList<'a>(pub &'a [&'a Value]);

impl Serialize for OutList<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
		for value in self.0 {
			seq.serialize_element(&Out(value))?;
		}
		seq.end()
	}
}
