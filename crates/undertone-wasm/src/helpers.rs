// Signals, seeded random numbers, pitch helpers, and the exact fraction helpers, as exports
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! API-MAPPING groups 18 (signals), 16 (randomness), 9 (pitch helpers), and 1 (time: the exact arithmetic the
//! bridge's JavaScript `Fraction` needs beyond 2^53, B3).
//!
//! The named signals are one export, [`signal_named`], over the pattern crate's `signal::by_name`; the bridge makes its
//! constants (`sine`, `saw2`, `rand`, ...) from it once at load. `signal(fn)` is a foreign leaf (see
//! [`crate::foreign`]).

use js_sys::{Array, Function, JsString};
use undertone::pattern::Value;
use undertone::pattern::pitch::{midi_to_frequency, note_to_frequency, note_to_midi};
use undertone::pattern::random::SeededRandom;
use undertone::pattern::signal::{brand_by, by_name, choose, irand};
use wasm_bindgen::prelude::*;

use crate::convert::{array_items, error, from_js, rust_error, string_of};
use crate::encode::{fraction_from_number, fraction_op};
use crate::foreign::{Entry, leaf};
use crate::pattern::{WasmPattern, wrap};

/// A signal by the name the reference exports it under: `sine`, `cosine`, `saw`, `isaw`, `tri`, `square` and their `2` forms, `rand`, `rand2`, `perlin`, and `brand`.
#[wasm_bindgen(js_name = signalNamed)]
pub fn signal_named(name: &str) -> Result<WasmPattern, JsValue> {
	by_name::<Value>(name)
		.map(WasmPattern::new)
		.ok_or_else(|| error(&format!("unknown signal \"{name}\"")))
}

/// `signal(fn)`: a continuous pattern from a JavaScript function of the cycle time (a foreign leaf).
#[wasm_bindgen(js_name = signal)]
pub fn signal_js(signal: Function) -> Result<WasmPattern, JsValue> {
	leaf(Entry::Signal { signal }).map(WasmPattern::new)
}

/// `irand(n)`: a random whole number from 0 to `n - 1`.
#[wasm_bindgen(js_name = irand)]
pub fn irand_js(n: f64) -> Result<WasmPattern, JsValue> {
	wrap(irand::<Value>(n))
}

/// `brandBy(p)`: 1 with probability `p`, otherwise 0.
#[wasm_bindgen(js_name = brandBy)]
pub fn brand_by_js(p: f64) -> Result<WasmPattern, JsValue> {
	wrap(brand_by::<Value>(p))
}

/// `choose(...values)`: one of the values at random. The values are plain values (an array is fine here: no handle is inside it).
#[wasm_bindgen(js_name = choose)]
pub fn choose_js(values: &Array) -> Result<WasmPattern, JsValue> {
	let values = array_items(values, "choose() values")?
		.iter()
		.map(from_js)
		.collect::<Result<Vec<_>, _>>()?;
	wrap(choose(values))
}

/// `noteToMidi(name)`: a note name as a MIDI note number (C4 = 60). A value that is not a string is read as `String(value)`.
#[wasm_bindgen(js_name = noteToMidi)]
pub fn note_to_midi_js(name: JsValue) -> Result<f64, JsValue> {
	note_to_midi(&string_of(&name)).map_err(rust_error)
}

/// `midiToFrequency(midi)`: Hz (A4 = MIDI 69 = 440 Hz).
#[wasm_bindgen(js_name = midiToFrequency)]
pub fn midi_to_frequency_js(midi: f64) -> f64 {
	midi_to_frequency(midi)
}

/// `noteToFrequency(pitch)`: a note name as Hz; a number passes through as Hz when it is finite and above zero.
#[wasm_bindgen(js_name = noteToFrequency)]
pub fn note_to_frequency_js(pitch: JsValue) -> Result<f64, JsValue> {
	match pitch.as_f64() {
		Some(hz) => note_to_frequency(hz),
		None => note_to_frequency(string_of(&pitch).as_str()),
	}
	.map_err(rust_error)
}

/// The generator `seededRandom(seed)` returns: the bridge wraps [`WasmRandom::next_value`] (`next` in JavaScript) in a function.
#[wasm_bindgen]
pub struct WasmRandom(SeededRandom);

#[wasm_bindgen]
impl WasmRandom {
	/// The next number, uniform in `[0, 1)` (`next` in JavaScript).
	#[wasm_bindgen(js_name = next)]
	pub fn next_value(&mut self) -> f64 {
		self.0.next_value()
	}
}

/// `seededRandom(seed)`: mulberry32, a number seed through `seed >>> 0`, a string hashed with FNV-1a over its UTF-16 code units (a lone surrogate included, as in JavaScript).
#[wasm_bindgen(js_name = seededRandom)]
pub fn seeded_random_js(seed: JsValue) -> Result<WasmRandom, JsValue> {
	if let Some(number) = seed.as_f64() {
		return Ok(WasmRandom(SeededRandom::from_number(number)));
	}
	if seed.is_string() {
		let units: Vec<u16> = seed.unchecked_ref::<JsString>().iter().collect();
		return Ok(WasmRandom(SeededRandom::from_utf16(&units)));
	}
	Err(error(&format!(
		"seededRandom() needs a number or a string, got {}",
		string_of(&seed)
	)))
}

/// `Fraction.from(value)` as exact text (`"3/4"`), by the pattern crate's rule (the reference's continued fraction).
#[wasm_bindgen(js_name = fractionFromNumber)]
pub fn fraction_from_number_js(value: f64) -> Result<String, JsValue> {
	fraction_from_number(value).map_err(|message| error(&message))
}

/// Exact arithmetic on two fraction texts with the pattern crate's `i128` fractions (B3): `add`, `sub`, `mul`, `div` give the result's text, `cmp` gives `-1`, `0`, or `1`.
#[wasm_bindgen(js_name = fractionOp)]
pub fn fraction_op_js(op: &str, a: &str, b: &str) -> Result<String, JsValue> {
	fraction_op(op, a, b).map_err(|message| error(&message))
}
