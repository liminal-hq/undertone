// The lazily loaded WebAssembly render module: plain voices in, samples, WAV bytes, or a recorded booking out
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `undertone-wasm-render`: the second WebAssembly module of the npm package (`packages/undertone/wasm/render/`), loaded
//! with a dynamic `import()` the first time a render is asked for (`renderToBuffer`, `.render()`, `score.render`, all
//! already asynchronous in 0.4.0). The rules are section 13 of
//! `docs/rust-migration/results/M6-BOUNDARY.md`.
//!
//! It has **no pattern and no mini-notation**: the main module collects a render's voices (`collectVoices`) and hands
//! them over as plain numbers ([`flat`]), with the render options. So a pattern with JavaScript leaves renders (they
//! were queried on the main thread), and this module is the engine, the in-house renderer (`RenderGraph`), the WAV
//! encoder, and a sample registry only, with no JavaScript callback: the core of the AudioWorklet module of M7 (RF-29).
//!
//! - [`render::render_voices`] (`renderVoices`): the voices rendered offline (D-14), `{ sampleRate, channels }`.
//! - [`render::WasmContextRender`] (`ContextRender`): the same voices booked on a recorder instead, for the wrapper to
//!   replay on the caller's `OfflineAudioContext` (`renderToBuffer(pattern, { context })`), window by window.
//! - [`render::encode_wav`] (`encodeWav`): samples to WAV bytes. The package's own `encodeWav` is TypeScript (RF-25d, so it
//!   is synchronous in a browser before any render); this export is kept for the module's WAV corpus runner.
//! - The sample registry (`registerSample`, `registerPendingSample`, `loadSample`, `clearSamples`, ...), one per
//!   instance like the main module's: the wrapper registers each sample in both.
//!
//! The option readers, the voice encoding, the sample registry, the recorder, and the warnings are the main module's
//! own files (`#[path]`), so the two modules cannot read them differently.

pub mod convert;
#[path = "../../undertone-wasm/src/flat.rs"]
pub mod flat;
#[path = "../../undertone-wasm/src/options.rs"]
pub mod options;
#[path = "../../undertone-wasm/src/record.rs"]
pub mod record;
pub mod render;
#[path = "../../undertone-wasm/src/samples.rs"]
pub mod samples;
#[path = "../../undertone-wasm/src/warnings.rs"]
#[allow(dead_code)]
// `queried` and `has_warned` serve the main module; this one only prints the engine's warnings
pub mod warnings;

use wasm_bindgen::prelude::*;

/// Runs when the module is instantiated: numbers print through JavaScript's `String(x)` and read through its
/// `Number(text)` from here on, as in the main module.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(start)]
pub fn start() {
	undertone::pattern::js::set_number_formatter(convert::number_text);
	undertone::pattern::js::set_number_parser(convert::text_number);
}

/// The version of this build of Undertone, which the wrapper checks against the main module's.
#[wasm_bindgen(js_name = undertoneVersion)]
pub fn undertone_version() -> String {
	env!("CARGO_PKG_VERSION").into()
}
