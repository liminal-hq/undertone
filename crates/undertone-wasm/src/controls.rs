// The controls table as plain data for the bridge, which generates its control methods from it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`control_table`]: `undertone_pattern::CONTROLS` as an array of plain [`ControlRow`] objects (section 6 of
//! `docs/rust-migration/results/M6-BOUNDARY.md`). The bridge reads it once at load and installs one method per row,
//! each calling one of the dispatchers below by the row's `arg`:
//!
//! - every row but `panslide`, `pitchsteps`, `channels`, and `panpath`: [`WasmPattern::control`] with a number, a
//!   string, or any other value (read as `String(value)`), or [`WasmPattern::control_pattern`] with a pattern handle;
//!   a scalar-only control given a pattern fails with the reference's "takes a plain value" message;
//! - `panslide` (`patternableWithTime`): [`WasmPattern::panslide`] or [`WasmPattern::panslide_pattern`];
//! - `pitchsteps` and `channels` (`numberList`), `panpath` (`path`): their own methods, which take the array.
//!
//! The checks, the clamping, and the messages are the pattern crate's (`Pattern::control` and the hand-written
//! methods), word for word.
//!
//! [`ControlRow`] is the first type whose TypeScript declaration comes from `ts-rs` (D-11): the test
//! `the_typescript_declarations_are_current` renders it and compares it with `crates/undertone-wasm/bindings/`.

use js_sys::{Array, Reflect};
use serde::Serialize;
use undertone::pattern::controls::ArgKind;
use undertone::pattern::{CONTROLS, Control, ControlInput, Value};
use wasm_bindgen::prelude::*;

use crate::convert::{array_items, error, from_js, string_of};
use crate::notes::parsed;
use crate::pattern::{WasmPattern, wrap};

/// What argument a control takes, as the bridge reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ControlArg {
	/// A number, a mini-notation string of numbers, or a pattern.
	Patternable,
	/// As `patternable`, plus a plain number of seconds (`panslide`).
	PatternableWithTime,
	/// A plain non-negative integer (`orbit`, `cut`).
	Integer,
	/// A plain number (`panlaw`, `surround`).
	Number,
	/// One of the row's `choices` (`fmenv`, `fmwave`, `autopanshape`).
	Choice,
	/// A name, not checked (`sound`, `s`, `bank`).
	Text,
	/// A list of numbers, with an optional frame rate (`pitchsteps`) or without (`channels`).
	NumberList,
	/// A list of pans or of `{ time, pan }` points, with an optional frame rate (`panpath`).
	Path,
}

impl From<ArgKind> for ControlArg {
	fn from(kind: ArgKind) -> ControlArg {
		match kind {
			ArgKind::Patternable => ControlArg::Patternable,
			ArgKind::PatternableWithTime => ControlArg::PatternableWithTime,
			ArgKind::Integer => ControlArg::Integer,
			ArgKind::Number => ControlArg::Number,
			ArgKind::Choice => ControlArg::Choice,
			ArgKind::Text => ControlArg::Text,
			ArgKind::NumberList => ControlArg::NumberList,
			ArgKind::Path => ControlArg::Path,
		}
	}
}

/// One control as plain data: what the bridge needs to install its method.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ControlRow {
	/// The method's name in JavaScript (`delayfeedback`).
	pub js_name: &'static str,
	/// The method's name in Rust (`delay_feedback`).
	pub rust_name: &'static str,
	/// The `VoiceParams` fields (JSON names) the control writes; the first is the one a pattern sets.
	pub fields: &'static [&'static str],
	/// What argument it takes.
	pub arg: ControlArg,
	/// Whether a pattern is refused with the reference's "takes a plain value" message.
	pub scalar_only: bool,
	/// The name the reference's messages use (`fmi` says `fm`).
	pub message_name: &'static str,
	/// For a `choice`, the words allowed.
	pub choices: &'static [&'static str],
	/// The range in words, for documentation.
	pub range: &'static str,
	/// A sentence on what the control does.
	pub summary: &'static str,
}

/// The rows of the controls table, in the table's order.
pub fn rows() -> Vec<ControlRow> {
	CONTROLS
		.iter()
		.map(|spec| ControlRow {
			js_name: spec.js_name,
			rust_name: spec.rust_name,
			fields: spec.fields,
			arg: spec.arg.into(),
			scalar_only: spec.is_scalar_only(),
			message_name: spec.message_name,
			choices: spec.choices,
			range: spec.range,
			summary: spec.summary,
		})
		.collect()
}

/// The controls table: an array of plain `ControlRow` objects, one per control (53), in the table's order.
#[wasm_bindgen(js_name = controlTable)]
pub fn control_table() -> Result<JsValue, JsValue> {
	serde_wasm_bindgen::to_value(&rows()).map_err(JsValue::from)
}

fn control_named(name: &str) -> Result<Control, JsValue> {
	Control::from_name(name).ok_or_else(|| error(&format!("unknown control \"{name}\"")))
}

/// An optional plain number of seconds or a rate: `undefined` is `None`; anything else that is not a number fails with `message` and `String(value)`.
fn optional_number(value: &JsValue, message: &str) -> Result<Option<f64>, JsValue> {
	if value.is_undefined() {
		return Ok(None);
	}
	value
		.as_f64()
		.map(Some)
		.ok_or_else(|| error(&format!("{message}, got {}", string_of(value))))
}

/// The items of an array, or `None` when `value` is not one.
fn items(value: &JsValue, what: &str) -> Result<Option<Vec<JsValue>>, JsValue> {
	if Array::is_array(value) {
		array_items(value.unchecked_ref(), what).map(Some)
	} else {
		Ok(None)
	}
}

/// A number of an array or object, `NaN` when it is not a number (every check the reference makes then fails).
fn number_or_nan(value: &JsValue) -> f64 {
	value.as_f64().unwrap_or(f64::NAN)
}

#[wasm_bindgen]
impl WasmPattern {
	/// A control by its JavaScript name with a plain value: a number, a mini-notation string (read per event, each literal checked now), or any other value, read as `String(value)` (a plain-value control then reports it as the reference does). `undefined` and `null` are refused for a patternable control.
	pub fn control(&self, name: &str, input: JsValue) -> Result<WasmPattern, JsValue> {
		let control = control_named(name)?;
		if let Some(number) = input.as_f64() {
			return wrap(self.pattern().control(control, number));
		}
		if control.spec().is_patternable() && (input.is_undefined() || input.is_null()) {
			return Err(error(&format!(
				"{}() needs a number, a mini-notation string, or a pattern, got {}",
				control.spec().message_name,
				string_of(&input)
			)));
		}
		parsed(&input, |text| self.pattern().control(control, text))
	}

	/// A control by its JavaScript name with a pattern, read at each event's onset and made safe (a value it has to deal with prints the reference's warning once). A plain-value control refuses it.
	#[wasm_bindgen(js_name = controlPattern)]
	pub fn control_pattern(&self, name: &str, input: &WasmPattern) -> Result<WasmPattern, JsValue> {
		let control = control_named(name)?;
		wrap(
			self.pattern()
				.control(control, ControlInput::Pattern(input.pattern().clone())),
		)
	}

	/// `panslide(from, seconds?)` with a plain `from` (a number or a mini-notation string). `seconds` is `undefined` or a number.
	pub fn panslide(&self, from: JsValue, seconds: JsValue) -> Result<WasmPattern, JsValue> {
		let seconds = optional_number(&seconds, "panslide() time must be zero or more seconds")?;
		match from.as_f64() {
			Some(number) => wrap(self.pattern().pan_slide(number, seconds)),
			None => parsed(&from, |text| self.pattern().pan_slide(text, seconds)),
		}
	}

	/// `panslide(from, seconds?)` with a pattern for `from`.
	#[wasm_bindgen(js_name = panslidePattern)]
	pub fn panslide_pattern(
		&self,
		from: &WasmPattern,
		seconds: JsValue,
	) -> Result<WasmPattern, JsValue> {
		let seconds = optional_number(&seconds, "panslide() time must be zero or more seconds")?;
		wrap(self.pattern().pan_slide(from.pattern().clone(), seconds))
	}

	/// `pitchsteps(semitones, rateHz?)`: an array of semitone offsets (an item that is not a number fails the finite check) and an optional rate.
	pub fn pitchsteps(&self, semitones: JsValue, rate: JsValue) -> Result<WasmPattern, JsValue> {
		let steps: Vec<f64> = items(&semitones, "pitchsteps() semitones")?
			.unwrap_or_default()
			.iter()
			.map(number_or_nan)
			.collect();
		let rate = optional_number(&rate, "pitchsteps() rate must be positive");
		if steps.is_empty() || !steps.iter().all(|v| v.is_finite()) {
			return wrap(self.pattern().pitch_steps(&[], None));
		}
		wrap(self.pattern().pitch_steps(&steps, rate?))
	}

	/// `channels(gains)`: one to eight gains; an item that is not a number is reported with `String(item)`.
	pub fn channels(&self, gains: JsValue) -> Result<WasmPattern, JsValue> {
		let list = items(&gains, "channels() gains")?.unwrap_or_default();
		if (1..=8).contains(&list.len())
			&& let Some(bad) = list.iter().find(|item| {
				!item
					.as_f64()
					.is_some_and(|level| level.is_finite() && level >= 0.0)
			}) && bad.as_f64().is_none()
		{
			return Err(error(&format!(
				"channels() gains must be finite and >= 0, got {}",
				string_of(bad)
			)));
		}
		let levels: Vec<f64> = list.iter().map(number_or_nan).collect();
		wrap(self.pattern().channels(&levels))
	}

	/// `panpath(path, rateHz?)`: an array of pans (with an optional rate) or of `{ time, pan }` points (without one).
	pub fn panpath(&self, path: JsValue, rate: JsValue) -> Result<WasmPattern, JsValue> {
		let list = items(&path, "panpath() path")?.unwrap_or_default();
		if list.iter().all(|item| item.as_f64().is_some()) {
			let pans: Vec<f64> = list.iter().map(number_or_nan).collect();
			if pans.is_empty() {
				return wrap(self.pattern().pan_path(&pans, None));
			}
			let rate = optional_number(&rate, "panpath() rate must be positive");
			if !pans.iter().all(|pan| (-1.0..=1.0).contains(pan)) {
				return wrap(self.pattern().pan_path(&pans, None));
			}
			return wrap(self.pattern().pan_path(&pans, rate?));
		}
		if !rate.is_undefined() {
			return Err(error(
				"panpath() takes a rate only with an array of pans, not with { time, pan } points",
			));
		}
		let field = |item: &JsValue, key: &str| {
			if item.is_object() {
				Reflect::get(item, &JsValue::from_str(key))
					.map(|value| number_or_nan(&value))
					.unwrap_or(f64::NAN)
			} else {
				f64::NAN
			}
		};
		let points: Vec<(f64, f64)> = list
			.iter()
			.map(|item| (field(item, "time"), field(item, "pan")))
			.collect();
		wrap(self.pattern().pan_path_points(&points))
	}

	/// `voice(patch)`: merges a plain patch into every event (`undefined` or `null` changes nothing, as a spread of them does).
	pub fn voice(&self, patch: JsValue) -> Result<WasmPattern, JsValue> {
		if patch.is_undefined() || patch.is_null() {
			return Ok(WasmPattern::new(self.pattern().clone()));
		}
		let patch: Value = from_js(&patch)?;
		Ok(WasmPattern::new(self.pattern().voice(&patch)))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::path::PathBuf;
	use ts_rs::{Config, TS};

	#[test]
	fn the_table_has_every_control_once() {
		let rows = rows();
		assert_eq!(rows.len(), 53);
		let gain = rows.iter().find(|row| row.js_name == "gain").unwrap();
		assert_eq!(gain.fields, ["gainLevel"]);
		assert_eq!(gain.arg, ControlArg::Patternable);
		assert!(!gain.scalar_only);
		let fmi = rows.iter().find(|row| row.js_name == "fmi").unwrap();
		assert_eq!(fmi.message_name, "fm");
		let cut = rows.iter().find(|row| row.js_name == "cut").unwrap();
		assert!(cut.scalar_only);
		let sound = rows.iter().find(|row| row.js_name == "sound").unwrap();
		assert_eq!(sound.arg, ControlArg::Text);
		assert!(!sound.scalar_only);
	}

	/// Renders each declaration and compares it with the committed file; `UNDERTONE_UPDATE_BINDINGS=1` rewrites them.
	#[test]
	fn the_typescript_declarations_are_current() {
		let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bindings");
		let config = Config::new();
		let update = std::env::var_os("UNDERTONE_UPDATE_BINDINGS").is_some();
		for (name, text) in [
			(
				"ControlRow.ts",
				ControlRow::export_to_string(&config).unwrap(),
			),
			(
				"ControlArg.ts",
				ControlArg::export_to_string(&config).unwrap(),
			),
		] {
			let path = dir.join(name);
			if update {
				std::fs::write(&path, &text).unwrap();
			}
			let committed = std::fs::read_to_string(&path).unwrap_or_default();
			assert_eq!(
				committed, text,
				"{name} is out of date: run UNDERTONE_UPDATE_BINDINGS=1 cargo test -p undertone-wasm"
			);
		}
	}
}
