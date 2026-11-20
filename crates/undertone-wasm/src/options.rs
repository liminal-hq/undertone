// Option objects read from JavaScript: numbers, flags, seeds, the master bus, and a render's options
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! How the bridge reads the reference's option bags. A field that is missing (`undefined`) takes the Rust default; a
//! number field holding something else is read as `Number(value)`, so the reference's own check fails with its
//! message. The render module includes this file too (`#[path]`), so both modules read options alike.

use js_sys::Reflect;
use undertone::engine::graph::NodeId;
use undertone::engine::master::{Limiter, LimiterOptions, MasterBusOptions};
use undertone::engine::render::{MasterSetting, RenderOptions};
use undertone::pattern::random::Seed;
use wasm_bindgen::prelude::*;

use crate::convert::{string_of, to_number};

/// `value[key]`, `undefined` when `value` is not an object.
pub fn field(value: &JsValue, key: &str) -> JsValue {
	if value.is_object() {
		Reflect::get(value, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
	} else {
		JsValue::UNDEFINED
	}
}

/// A number option: `undefined` (or `null`) is `None`, anything else `Number(value)`.
pub fn number(value: &JsValue) -> Option<f64> {
	(!value.is_undefined() && !value.is_null()).then(|| to_number(value))
}

/// A boolean option: `undefined` is `None`, anything else its truthiness.
pub fn flag(value: &JsValue) -> Option<bool> {
	(!value.is_undefined()).then(|| value.is_truthy())
}

/// A seed: a number or a string.
pub fn seed(value: &JsValue) -> Seed {
	match value.as_f64() {
		Some(number) => Seed::Num(number),
		None => Seed::Str(string_of(value)),
	}
}

/// The master bus options of `createMasterBus(ctx, options)` (the wrapper passes `output` as a node number).
pub fn master_options(value: &JsValue) -> MasterBusOptions {
	let limiter = field(value, "limiter");
	let limiter = if limiter.is_undefined() || limiter.as_bool() == Some(true) {
		Limiter::Default
	} else if limiter.as_bool() == Some(false) {
		Limiter::Off
	} else {
		Limiter::Tuned(LimiterOptions {
			threshold: number(&field(&limiter, "threshold")),
			knee: number(&field(&limiter, "knee")),
			ratio: number(&field(&limiter, "ratio")),
			attack: number(&field(&limiter, "attack")),
			release: number(&field(&limiter, "release")),
			compensate: flag(&field(&limiter, "compensate")),
		})
	};
	MasterBusOptions {
		output: number(&field(value, "output")).map(|node| NodeId::new(node as u32)),
		gain: number(&field(value, "gain")),
		limiter,
		ceiling: number(&field(value, "ceiling")),
	}
}

/// The render options of `renderToBuffer` and `.render()` read from a plain object (`context` is the wrapper's; the
/// wrapper passes its `setcpm()` tempo as `defaultCpm`).
pub fn render_options(value: &JsValue) -> RenderOptions {
	let seed_value = field(value, "seed");
	let master = field(value, "master");
	RenderOptions {
		cycles: number(&field(value, "cycles")),
		seconds: number(&field(value, "seconds")),
		bpm: number(&field(value, "bpm")),
		cps: number(&field(value, "cps")),
		sample_rate: number(&field(value, "sampleRate")),
		channels: number(&field(value, "channels")),
		tail: number(&field(value, "tail")),
		wrap: flag(&field(value, "wrap")),
		seed: (!seed_value.is_undefined()).then(|| seed(&seed_value)),
		gated: flag(&field(value, "gated")),
		master: if master.is_undefined() {
			None
		} else if let Some(on) = master.as_bool() {
			Some(if on {
				MasterSetting::On
			} else {
				MasterSetting::Off
			})
		} else {
			Some(MasterSetting::Tuned(master_options(&master)))
		},
		booking_window: number(&field(value, "bookingWindow")),
		default_cpm: number(&field(value, "defaultCpm")),
	}
}
