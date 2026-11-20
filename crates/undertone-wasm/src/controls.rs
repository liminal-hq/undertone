// The controls table as plain data for the bridge, which generates its control methods from it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`control_table`]: `undertone_pattern::CONTROLS` as an array of plain [`ControlRow`] objects (section 6 of
//! `docs/rust-migration/results/M6-BOUNDARY.md`). The bridge reads it once at load and installs one method per row;
//! the dispatcher those methods call is part 2 of RF-24.
//!
//! [`ControlRow`] is the first type whose TypeScript declaration comes from `ts-rs` (D-11): the test
//! `the_typescript_declarations_are_current` renders it and compares it with `crates/undertone-wasm/bindings/`.

use serde::Serialize;
use undertone::pattern::CONTROLS;
use undertone::pattern::controls::ArgKind;
use wasm_bindgen::prelude::*;

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
