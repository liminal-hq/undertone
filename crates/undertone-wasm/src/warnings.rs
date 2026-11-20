// The bridge's once-only warnings: what the reference's warnOnce prints, printed once per key per instance
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The reference prints a warning once per key per process (`warnOnce` in `src/warn.ts`), and its tests clear the set
//! with `resetWarnings()`. The bridge keeps that set here, one per WebAssembly instance, and prints a new warning with
//! `console.warn(message)` itself, so the wrapper has nothing to forward (section 8 of
//! `docs/rust-migration/results/M6-BOUNDARY.md`).
//!
//! - **Controls:** every export that queries runs inside [`queried`], which collects the warnings the pattern crate
//!   raises (`undertone_pattern::controls::collect_warnings`) and prints the new ones when the query returns.
//! - **The engine** (part 2b) passes its `Warning`s to [`warn_once`] with their keys, so one set covers both, as one set
//!   covers the reference's controls and engine.
//! - **`resetWarnings()`** forgets every key (the wrapper's `./testing` entry calls it).
//!
//! `console.warn` is looked up when it is called, so a test's `vi.spyOn(console, 'warn')` sees every warning.

use std::cell::RefCell;
use std::collections::BTreeSet;

use undertone::pattern::controls::collect_warnings;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
	/// The global `console.warn`, called with one string.
	#[wasm_bindgen(js_namespace = console, js_name = warn)]
	fn console_warn(message: &str);
}

thread_local! {
	/// The keys warned about so far in this instance.
	static WARNED: RefCell<BTreeSet<String>> = const { RefCell::new(BTreeSet::new()) };
}

/// Prints `message` with `console.warn` the first time `key` is seen, as the reference's `warnOnce(key, message)`.
pub fn warn_once(key: &str, message: &str) {
	let new = WARNED.with(|warned| {
		warned
			.try_borrow_mut()
			.is_ok_and(|mut warned| warned.insert(key.to_owned()))
	});
	if new {
		print(message);
	}
}

/// Prints `message` with `console.warn`, whatever was printed before.
#[cfg(target_arch = "wasm32")]
pub fn print(message: &str) {
	console_warn(message);
}

/// Prints nothing off WebAssembly (the native unit tests).
#[cfg(not(target_arch = "wasm32"))]
pub fn print(_message: &str) {}

/// Runs a query (or anything that may query) and prints the control warnings it raised that are new to this instance.
pub fn queried<R>(run: impl FnOnce() -> R) -> R {
	let (out, warnings) = collect_warnings(run);
	for warning in warnings {
		warn_once(&warning.key, &warning.message);
	}
	out
}

/// Whether `key` has been warned about since the last [`reset_warnings`] (for the unit tests).
pub fn has_warned(key: &str) -> bool {
	WARNED.with(|warned| warned.borrow().contains(key))
}

/// `resetWarnings()`: forgets every warning given so far, so each prints again (test hygiene, the reference's `resetWarnings`).
#[wasm_bindgen(js_name = resetWarnings)]
pub fn reset_warnings() {
	WARNED.with(|warned| warned.borrow_mut().clear());
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_key_warns_once_until_reset() {
		reset_warnings();
		assert!(!has_warned("k"));
		warn_once("k", "first");
		assert!(has_warned("k"));
		reset_warnings();
		assert!(!has_warned("k"));
	}
}
