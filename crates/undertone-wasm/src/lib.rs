// The WebAssembly build of Undertone's Rust API: wasm-bindgen exports that the npm package's bridge wraps
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `undertone-wasm`: the Rust API of [`undertone`] exported to JavaScript through `wasm-bindgen`, built into the
//! `.wasm` module of the npm package `@liminal-hq/undertone` (RF-24; the TypeScript bridge over it is RF-25).
//!
//! It is `publish = false`: it ships inside the npm package, never on crates.io. Users of the JavaScript API never see
//! these exports directly; the bridge (`packages/undertone`) wraps them under the 0.4.0 names. The rules every export
//! follows (handles, JavaScript functions, the hap encoding, values, errors, panics, naming, typings) are in
//! `docs/rust-migration/results/M6-BOUNDARY.md`.
//!
//! # Building
//!
//! `scripts/build-wasm.sh` builds the module with the `wasm` profile (`opt-level = "z"`, fat LTO, one codegen unit,
//! `panic = "abort"`), runs `wasm-bindgen --target web --weak-refs` into `packages/undertone/wasm/`, and runs
//! `wasm-opt -Oz -all`. On the host the crate builds too (`cargo check -p undertone-wasm`), so its pure-Rust parts are
//! unit-tested with the rest of the workspace; anything that calls JavaScript runs only in a JavaScript runtime
//! (`crates/undertone-wasm/tests/js/`).
//!
//! # Modules
//!
//! - [`pattern`]: the handle ([`WasmPattern`]), its queries, and the list builder ([`PatternList`]).
//! - [`build`]: the constructors and transforms (groups 3 to 6, and the numeric methods of group 18).
//! - [`notes`]: `note`, `sound`, `s`, `n`, `chord`, and the methods `.scale`, `.voicing`, `.sound`, `.s`, `.bank` (groups 7 and 8).
//! - [`helpers`]: signals, seeded random numbers, pitch helpers, and the exact fraction helpers (groups 18, 16, 9, 1).
//! - [`controls`]: the controls table as plain data, and its TypeScript declaration from `ts-rs`.
//! - [`foreign`]: the JavaScript functions behind foreign leaves (`new Pattern(query)`, `fmap(fn)`, `signal(fn)`).
//! - [`convert`]: values and errors across the boundary.
//! - [`encode`]: the flat hap encoding and the checked fraction conversions (plain Rust).
//! - [`warnings`]: the once-only warnings, printed with `console.warn`, and `resetWarnings`.

pub mod build;
pub mod controls;
pub mod convert;
pub mod encode;
pub mod foreign;
pub mod helpers;
pub mod notes;
pub mod pattern;
pub mod warnings;

pub use pattern::{PatternList, WasmPattern};

use wasm_bindgen::prelude::*;

/// The version of this build of Undertone (the workspace version), for the bridge to report.
#[wasm_bindgen(js_name = undertoneVersion)]
pub fn undertone_version() -> String {
	env!("CARGO_PKG_VERSION").into()
}
