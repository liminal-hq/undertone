// score(definition) as an export: the definition read from a plain object, and the Score handle's data
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! API-MAPPING group 15, the data half: `score(definition)` returns a [`WasmScore`] whose `pattern()`, `cps`, and
//! `seconds` are the reference's `Score` fields. Playing, looping, and rendering a score are part 2b (they need the
//! engine and the scheduler), and will be methods of the same handle.
//!
//! The definition is read from a plain object field by field. A number field that holds something else is read as
//! `Number(value)`, so the reference's check fails with its message (the reference prints the value as it was, so
//! `ticksPerSecond: 'x'` says `got NaN` here and `got x` there). `note` is a note name (a string) or a frequency (a
//! number); `seam` is `'cut'` when it is missing, and anything else rings on, as the reference's `seam === 'cut'`
//! test does; `voice` is a patch.

use js_sys::{Array, Reflect};
use undertone::engine::score::{
	Score, ScoreAutopan, ScoreDefinition, ScoreEvent, ScoreNote, ScorePanPoint, Seam,
};
use wasm_bindgen::prelude::*;

use crate::convert::{array_items, error, from_js, rust_error, string_of, to_number as number};
use crate::pattern::WasmPattern;

fn get(object: &JsValue, key: &str) -> JsValue {
	if object.is_object() {
		Reflect::get(object, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
	} else {
		JsValue::UNDEFINED
	}
}

fn optional(value: &JsValue) -> Option<f64> {
	(!value.is_undefined()).then(|| number(value))
}

fn list(value: &JsValue, what: &str) -> Result<Vec<JsValue>, JsValue> {
	if Array::is_array(value) {
		array_items(value.unchecked_ref(), what)
	} else {
		Ok(Vec::new())
	}
}

fn event(value: &JsValue) -> Result<ScoreEvent, JsValue> {
	let note = get(value, "note");
	let note = if note.is_undefined() {
		None
	} else {
		Some(match note.as_f64() {
			Some(hz) => ScoreNote::Hz(hz),
			None => ScoreNote::Name(string_of(&note)),
		})
	};
	let pan_path = get(value, "panPath");
	let pan_path = if pan_path.is_undefined() {
		None
	} else {
		Some(
			list(&pan_path, "a score event's panPath")?
				.iter()
				.map(|point| ScorePanPoint {
					tick: number(&get(point, "tick")),
					pan: number(&get(point, "pan")),
				})
				.collect(),
		)
	};
	let autopan = get(value, "autopan");
	let autopan = (!autopan.is_undefined()).then(|| {
		let shape = get(&autopan, "shape");
		ScoreAutopan {
			period_ticks: number(&get(&autopan, "periodTicks")),
			depth: number(&get(&autopan, "depth")),
			shape: (!shape.is_undefined()).then(|| string_of(&shape)),
			phase: optional(&get(&autopan, "phase")),
		}
	});
	let voice = get(value, "voice");
	Ok(ScoreEvent {
		tick: number(&get(value, "tick")),
		note,
		midi: optional(&get(value, "midi")),
		gate: optional(&get(value, "gate")),
		level: optional(&get(value, "level")),
		pan: optional(&get(value, "pan")),
		pan_path,
		autopan,
		voice: if voice.is_undefined() || voice.is_null() {
			None
		} else {
			Some(from_js(&voice)?)
		},
	})
}

/// A score definition read from a plain object.
pub fn definition(value: &JsValue) -> Result<ScoreDefinition, JsValue> {
	if !value.is_object() {
		return Err(error(&format!(
			"score() needs a definition object, got {}",
			string_of(value)
		)));
	}
	let seam = get(value, "seam");
	let events = list(&get(value, "events"), "a score definition's events")?
		.iter()
		.map(event)
		.collect::<Result<Vec<_>, _>>()?;
	Ok(ScoreDefinition {
		ticks_per_second: number(&get(value, "ticksPerSecond")),
		length_ticks: number(&get(value, "lengthTicks")),
		events,
		seam: if seam.is_undefined() || seam.is_null() {
			None
		} else if seam.as_string().as_deref() == Some("cut") {
			Some(Seam::Cut)
		} else {
			Some(Seam::Ring)
		},
		pan_law: optional(&get(value, "panLaw")),
	})
}

/// A score handle: the compiled score, its pattern, and its tempo. Part 2b adds `play`, `loop`, and `render`.
#[wasm_bindgen]
pub struct WasmScore(Score);

impl WasmScore {
	/// The score this handle holds.
	pub fn score(&self) -> &Score {
		&self.0
	}
}

#[wasm_bindgen]
impl WasmScore {
	/// The score as a looping pattern of voice parameters: one cycle is one pass of the cue.
	pub fn pattern(&self) -> WasmPattern {
		WasmPattern::new(self.0.pattern().clone())
	}

	/// Cycles per second: one cycle is `lengthTicks / ticksPerSecond` seconds.
	#[wasm_bindgen(getter)]
	pub fn cps(&self) -> f64 {
		self.0.cps()
	}

	/// The length of one pass in seconds.
	#[wasm_bindgen(getter)]
	pub fn seconds(&self) -> f64 {
		self.0.seconds()
	}
}

/// `score(definition)`: compiles a tick-timed score, with the reference's checks and messages.
#[wasm_bindgen(js_name = score)]
pub fn score_js(definition_value: JsValue) -> Result<WasmScore, JsValue> {
	let definition = definition(&definition_value)?;
	Score::new(&definition).map(WasmScore).map_err(rust_error)
}
