// The sample registry as exports: one registry per instance, filled with PCM the host decoded
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The reference's sample registry (`src/samples.ts`) is one per process, shared by every context; the bridge keeps
//! one per WebAssembly instance, here, and every engine books from it ([`with_registry`]). Decoding is the host's
//! (D-30): the wrapper fetches and decodes with the caller's `AudioContext` and hands over the PCM.
//!
//! - `registerSample(name, { sampleRate, channels, baseNote })`: decoded PCM, one `Float32Array` per channel (the
//!   wrapper reads an `AudioBuffer`'s `getChannelData` for a `buffer` source).
//! - `registerPendingSample(name, baseNote)`: a `url` or `data` source not decoded yet; it counts as registered and
//!   its voices are skipped silently until `loadSample(name, pcm)` hands the PCM over (the wrapper's `loadSamples`).
//! - `registerSamples(names, sources)`, `getSampleBaseNote`, `isSampleRegistered`, `resolveRegisteredKey`,
//!   `clearSamples`: the reference's, with its messages.

use std::cell::RefCell;

use js_sys::{Array, Float32Array, Reflect};
use undertone::engine::params::Pitch;
use undertone::engine::samples::{SampleData, Samples};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::convert::{error, rust_error, string_of};

thread_local! {
	static REGISTRY: RefCell<Samples> = RefCell::new(Samples::new());
}

/// Runs `run` with the instance's registry. The registry is moved out for the call (so a booking that queries a
/// pattern whose JavaScript leaf registers a sample cannot meet a borrowed registry) and put back after it.
pub fn with_registry<R>(run: impl FnOnce(&mut Samples) -> R) -> R {
	let mut samples = REGISTRY.with(|registry| registry.take());
	let out = run(&mut samples);
	REGISTRY.with(|registry| *registry.borrow_mut() = samples);
	out
}

fn field(value: &JsValue, key: &str) -> JsValue {
	if value.is_object() {
		Reflect::get(value, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
	} else {
		JsValue::UNDEFINED
	}
}

/// A base note: a name, a frequency, or none.
fn base_note(value: &JsValue) -> Option<Pitch> {
	if value.is_undefined() || value.is_null() {
		None
	} else if let Some(hz) = value.as_f64() {
		Some(Pitch::Hz(hz))
	} else {
		Some(Pitch::Name(string_of(value)))
	}
}

/// `{ sampleRate, channels: Float32Array[] }` as PCM.
fn pcm(name: &str, value: &JsValue) -> Result<SampleData, JsValue> {
	let channels = field(value, "channels");
	if !Array::is_array(&channels) {
		return Err(error(&format!(
			"Sample \"{name}\" needs {{ sampleRate, channels }} with one Float32Array per channel"
		)));
	}
	let channels = channels
		.unchecked_ref::<Array>()
		.iter()
		.map(|channel| match channel.dyn_ref::<Float32Array>() {
			Some(samples) => Ok(samples.to_vec()),
			None => Err(error(&format!(
				"Sample \"{name}\" has a channel that is not a Float32Array"
			))),
		})
		.collect::<Result<Vec<_>, _>>()?;
	Ok(SampleData::new(
		crate::convert::to_number(&field(value, "sampleRate")),
		channels,
	))
}

fn register(samples: &mut Samples, name: String, source: &JsValue) -> Result<(), JsValue> {
	let data = pcm(&name, source)?;
	samples
		.register_sample(name, data, base_note(&field(source, "baseNote")))
		.map_err(rust_error)
}

/// `registerSample(name, { sampleRate, channels, baseNote })`: registers decoded PCM, replacing any earlier registration.
#[wasm_bindgen(js_name = registerSample)]
pub fn register_sample(name: String, source: JsValue) -> Result<(), JsValue> {
	with_registry(|samples| register(samples, name, &source))
}

/// `registerSamples(names, sources)`: registers each in order; the first that fails stops, the ones before it stay.
#[wasm_bindgen(js_name = registerSamples)]
pub fn register_samples(names: Vec<String>, sources: Array) -> Result<(), JsValue> {
	with_registry(|samples| {
		for (name, source) in names.into_iter().zip(sources.iter()) {
			register(samples, name, &source)?;
		}
		Ok(())
	})
}

/// `registerPendingSample(name, baseNote)`: a source the host has not decoded yet (a `url` or encoded `data`).
#[wasm_bindgen(js_name = registerPendingSample)]
pub fn register_pending_sample(name: String, base: JsValue) -> Result<(), JsValue> {
	with_registry(|samples| {
		samples
			.register_pending_sample(name, base_note(&base))
			.map_err(rust_error)
	})
}

/// `loadSample(name, { sampleRate, channels })`: the decoded PCM of a registered sample (the wrapper's `loadSamples` after decoding).
#[wasm_bindgen(js_name = loadSample)]
pub fn load_sample(name: String, decoded: JsValue) -> Result<(), JsValue> {
	let data = pcm(&name, &decoded)?;
	with_registry(|samples| samples.load_samples([(name, data)]).map_err(rust_error))
}

/// `getSampleBaseNote(name, bank?)`: the base note a sample was registered with, a name or a frequency.
#[wasm_bindgen(js_name = getSampleBaseNote)]
pub fn get_sample_base_note(name: &str, bank: Option<String>) -> JsValue {
	with_registry(
		|samples| match samples.get_sample_base_note(name, bank.as_deref()) {
			Some(Pitch::Name(note)) => JsValue::from_str(note),
			Some(Pitch::Hz(hz)) => JsValue::from_f64(*hz),
			None => JsValue::UNDEFINED,
		},
	)
}

/// `isSampleRegistered(name, bank?)`.
#[wasm_bindgen(js_name = isSampleRegistered)]
pub fn is_sample_registered(name: &str, bank: Option<String>) -> bool {
	with_registry(|samples| samples.is_sample_registered(name, bank.as_deref()))
}

/// `resolveRegisteredKey(name, bank?)`: the key a lookup finds, or `undefined`.
#[wasm_bindgen(js_name = resolveRegisteredKey)]
pub fn resolve_registered_key(name: &str, bank: Option<String>) -> Option<String> {
	with_registry(|samples| samples.resolve_registered_key(name, bank.as_deref()))
}

/// `clearSamples()`: empties the registry and forgets which names were warned about.
#[wasm_bindgen(js_name = clearSamples)]
pub fn clear_samples() {
	with_registry(Samples::clear_samples);
}
