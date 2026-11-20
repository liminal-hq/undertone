// Notes, sounds, scales, and chords as exports: note, sound, s, n, chord, and .scale, .voicing, .sound, .s, .bank
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! API-MAPPING groups 7 (notes and sounds) and 8 (harmony).
//!
//! The constructors that read mini-notation (`note`, `sound`, `s`, `n`, `chord`) take the source as a JavaScript value
//! and report a parse error with the source's own UTF-16 code units, as `mini` does (section 4 of
//! `docs/rust-migration/results/M6-BOUNDARY.md`). A number goes to the number form where the reference has one
//! (`note(440)`, `n(3)`); anything else is read as `String(value)`.

use js_sys::{JsString, Reflect};
use undertone::pattern::chord::{Anchor, VoicingOptions, chord};
use undertone::pattern::control::{n, n_degree, n_pattern, note, note_hz, s, sound};
use undertone::pattern::{Pattern, Result as PatternResult, Value};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::build::mini_message;
use crate::convert::string_of;
use crate::pattern::{WasmPattern, wrap};

/// Builds a pattern from mini-notation text with `build`; a parse error keeps the source's own code units.
pub(crate) fn parsed(
	source: &JsValue,
	build: impl FnOnce(&str) -> PatternResult<Pattern<Value>>,
) -> Result<WasmPattern, JsValue> {
	let js: JsString = match source.dyn_ref::<JsString>() {
		Some(text) => text.clone(),
		None => JsString::from(string_of(source).as_str()),
	};
	let text = String::from(&js);
	match build(&text) {
		Ok(pattern) => Ok(WasmPattern::new(pattern)),
		Err(err) => {
			let error = js_sys::Error::new("");
			Reflect::set(
				&error,
				&JsValue::from_str("message"),
				&mini_message(err.message(), &text, &js),
			)?;
			Err(error.into())
		}
	}
}

/// `note(input)`: a pitched pattern from a frequency in Hz (a number) or a mini-notation string of note names and Hz.
#[wasm_bindgen(js_name = note)]
pub fn note_js(input: JsValue) -> Result<WasmPattern, JsValue> {
	match input.as_f64() {
		Some(hz) => wrap(note_hz(hz)),
		None => parsed(&input, note),
	}
}

/// `sound(input)`: an unpitched pattern from a mini-notation string of sound types.
#[wasm_bindgen(js_name = sound)]
pub fn sound_js(input: JsValue) -> Result<WasmPattern, JsValue> {
	parsed(&input, sound)
}

/// `s(input)`: synth sound types or sample names from mini-notation.
#[wasm_bindgen(js_name = s)]
pub fn s_js(input: JsValue) -> Result<WasmPattern, JsValue> {
	parsed(&input, s)
}

/// `n(input)` with a whole number or a mini-notation string of degrees; a pattern of numbers goes to [`n_pattern_js`].
#[wasm_bindgen(js_name = n)]
pub fn n_js(input: JsValue) -> Result<WasmPattern, JsValue> {
	match input.as_f64() {
		Some(degree) => wrap(n_degree(degree)),
		None => parsed(&input, n),
	}
}

/// `n(pattern)`: scale degrees from a pattern of numbers that has events, each floored; a signal is refused.
#[wasm_bindgen(js_name = nPattern)]
pub fn n_pattern_js(input: &WasmPattern) -> Result<WasmPattern, JsValue> {
	wrap(n_pattern(input.pattern()))
}

/// `chord(input)`: chord symbols from mini-notation, each checked here.
#[wasm_bindgen(js_name = chord)]
pub fn chord_js(input: JsValue) -> Result<WasmPattern, JsValue> {
	parsed(&input, chord)
}

#[wasm_bindgen]
impl WasmPattern {
	/// `scale(spec)`: resolves degrees into pitches (`"D5:minor"`).
	pub fn scale(&self, spec: JsValue) -> Result<WasmPattern, JsValue> {
		wrap(self.pattern().scale(&string_of(&spec)))
	}

	/// `voicing({ anchor })`: the wrapper passes the `anchor` (a MIDI number, a note name, or `undefined` for middle C).
	pub fn voicing(&self, anchor: JsValue) -> WasmPattern {
		let anchor = if anchor.is_undefined() || anchor.is_null() {
			None
		} else {
			Some(match anchor.as_f64() {
				Some(midi) => Anchor::Midi(midi),
				None => Anchor::Name(string_of(&anchor)),
			})
		};
		WasmPattern::new(self.pattern().voicing(VoicingOptions { anchor }))
	}

	/// `.sound(type)`: sets the sound type and clears any sample name (unchecked, as in the reference).
	#[wasm_bindgen(js_name = sound)]
	pub fn set_sound(&self, sound_type: JsValue) -> WasmPattern {
		WasmPattern::new(self.pattern().sound(&string_of(&sound_type)))
	}

	/// `.s(name)`: a synth sound type or a sample name, clearing the other.
	#[wasm_bindgen(js_name = s)]
	pub fn set_s(&self, name: JsValue) -> WasmPattern {
		WasmPattern::new(self.pattern().s(&string_of(&name)))
	}

	/// `.bank(name)`: the bank prefix for sample lookup.
	pub fn bank(&self, name: JsValue) -> WasmPattern {
		WasmPattern::new(self.pattern().bank(&string_of(&name)))
	}
}
