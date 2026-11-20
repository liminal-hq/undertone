// Instruments, the pure channel helpers, and resolveParams as exports: plain data in and out
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! API-MAPPING groups 12 (the pure channel helpers: `surroundGains`, `foldToStereo`, `CHANNEL_ORDER`,
//! `MAX_CHANNELS`), 13 (instruments: `fmVoice`, `fmPresets`, `layer`, `SHAPED_WAVE_TYPES`, `isShapedWave`), and 14
//! (resolution: `resolveParams`).
//!
//! A patch crosses as a plain object both ways ([`from_js`] in, [`to_js`] out), as a hap's value does.
//! `enableMultichannel` and `createMonoFold` need an `AudioContext` and belong to the Web Audio backend (RF-26).
//!
//! **`resolveParams(patch)`** is the reference's `{ ...DEFAULT_PARAMS, ...patch }` plus the sample rule, done on the
//! value itself, so a key the patch carries that is not a `VoiceParams` field (`degree`, `chord`) or a value of an
//! unexpected kind is kept, exactly as the spread keeps it, and the optional defaults are present with the value
//! `undefined`, as in `DEFAULT_PARAMS`. The numbers are read from the engine's [`VoiceParams::empty`], so they cannot
//! drift from what the engine books. No `serde` derive of `VoiceParams` enters the module (see section 7 of
//! `docs/rust-migration/results/M6-BOUNDARY.md`).

use std::collections::BTreeMap;

use js_sys::{Array, Reflect};
use undertone::engine::params::VoiceParams;
use undertone::engine::surround::{CHANNEL_ORDER, MAX_CHANNELS, fold_to_stereo, surround_gains};
use undertone::engine::waves::{SHAPED_WAVE_TYPES, is_shaped_wave};
use undertone::pattern::instruments::{
	EnvelopeDefinition, FM_PRESET_NAMES, FmVoiceDefinition, fm_presets, fm_voice,
};
use undertone::pattern::{LayerMap, MapFn, Value, js, stack};
use wasm_bindgen::prelude::*;

use crate::convert::{error, from_js, rust_error, string_of, to_js, to_number};
use crate::pattern::WasmPattern;

/// A list of strings as a JavaScript array.
fn words(list: &[&str]) -> Array {
	list.iter().map(|word| JsValue::from_str(word)).collect()
}

/// A list of numbers as a JavaScript array.
fn numbers(list: &[f64]) -> Array {
	list.iter().map(|n| JsValue::from_f64(*n)).collect()
}

/// `value[key]`, `undefined` when `value` is not an object.
fn field(value: &JsValue, key: &str) -> JsValue {
	if value.is_object() {
		Reflect::get(value, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
	} else {
		JsValue::UNDEFINED
	}
}


/// `surroundGains(angle)`: the eight 7.1 gains that place a sound at an angle on the speaker ring.
#[wasm_bindgen(js_name = surroundGains)]
pub fn surround_gains_js(angle: JsValue) -> Result<Array, JsValue> {
	let Some(degrees) = angle.as_f64() else {
		return Err(error(&format!(
			"surround() angle must be a finite number, got {}",
			string_of(&angle)
		)));
	};
	surround_gains(degrees)
		.map(|gains| numbers(&gains))
		.map_err(rust_error)
}

/// `foldToStereo(gains)`: a channel-gain array folded to `[left, right]` (a missing or non-number gain counts as 0, as `?? 0` does for a missing one).
#[wasm_bindgen(js_name = foldToStereo)]
pub fn fold_to_stereo_js(gains: &Array) -> Array {
	let gains: Vec<f64> = gains
		.iter()
		.map(|gain| {
			if gain.is_undefined() || gain.is_null() {
				0.0
			} else {
				to_number(&gain)
			}
		})
		.collect();
	numbers(&fold_to_stereo(&gains))
}

/// `CHANNEL_ORDER`: `["FL", "FR", "C", "LFE", "SL", "SR", "RL", "RR"]`. The wrapper freezes it once at load.
#[wasm_bindgen(js_name = channelOrder)]
pub fn channel_order() -> Array {
	words(&CHANNEL_ORDER)
}

/// `MAX_CHANNELS`: 8.
#[wasm_bindgen(js_name = maxChannels)]
pub fn max_channels() -> u32 {
	MAX_CHANNELS as u32
}

/// `SHAPED_WAVE_TYPES`: `["halfsine", "abssine", "pulsesine"]`. The wrapper freezes it once at load.
#[wasm_bindgen(js_name = shapedWaveTypes)]
pub fn shaped_wave_types() -> Array {
	words(&SHAPED_WAVE_TYPES)
}

/// `isShapedWave(word)`: whether a value is one of the shaped wave names (a value that is not a string never is).
#[wasm_bindgen(js_name = isShapedWave)]
pub fn is_shaped_wave_js(word: JsValue) -> bool {
	word.as_string().is_some_and(|word| is_shaped_wave(&word))
}

/// An optional number of a definition: `undefined` is `None`; a value that is not a number fails, because a patch field the module holds is a number (the reference would copy it as it is).
fn optional(value: &JsValue, name: &str) -> Result<Option<f64>, JsValue> {
	if value.is_undefined() {
		return Ok(None);
	}
	value.as_f64().map(Some).ok_or_else(|| {
		error(&format!(
			"fmVoice() {name} must be a number, got {}",
			string_of(value)
		))
	})
}

/// The `harmonicity` or `modulationIndex` of a definition: a value that is not a number fails the reference's own check, with its message.
fn checked(value: &JsValue, message: &str) -> Result<Option<f64>, JsValue> {
	if value.is_undefined() {
		return Ok(None);
	}
	value
		.as_f64()
		.map(Some)
		.ok_or_else(|| error(&format!("{message}, got {}", string_of(value))))
}

fn envelope(value: &JsValue, prefix: &str) -> Result<EnvelopeDefinition, JsValue> {
	let part = |key: &str| optional(&field(value, key), &format!("{prefix}.{key}"));
	Ok(EnvelopeDefinition {
		attack: part("attack")?,
		decay: part("decay")?,
		sustain: part("sustain")?,
		release: part("release")?,
	})
}

fn wave(value: &JsValue) -> Option<String> {
	let wave = field(value, "type");
	(!wave.is_undefined()).then(|| string_of(&wave))
}

/// `fmVoice(definition)`: a Tone.js-shaped FM definition as a plain patch.
#[wasm_bindgen(js_name = fmVoice)]
pub fn fm_voice_js(definition: JsValue) -> Result<JsValue, JsValue> {
	let get = |key: &str| field(&definition, key);
	let definition = FmVoiceDefinition {
		harmonicity: checked(
			&get("harmonicity"),
			"fmVoice() harmonicity must be positive",
		)?,
		modulation_index: checked(
			&get("modulationIndex"),
			"fmVoice() modulationIndex must not be negative",
		)?,
		oscillator: wave(&get("oscillator")),
		modulation: wave(&get("modulation")),
		envelope: envelope(&get("envelope"), "envelope")?,
		modulation_envelope: envelope(&get("modulationEnvelope"), "modulationEnvelope")?,
		level: optional(&get("level"), "level")?,
		pan: optional(&get("pan"), "pan")?,
	};
	fm_voice(&definition)
		.map(|patch| to_js(&patch))
		.map_err(rust_error)
}

/// `fmPresets`: the five presets as one plain object (`glassBell`, `roundBass`, `softPad`, `pluck`, `lead`). The wrapper freezes it, and each preset, once at load.
#[wasm_bindgen(js_name = fmPresets)]
pub fn fm_presets_js() -> JsValue {
	let presets = fm_presets();
	let all: BTreeMap<String, Value> = FM_PRESET_NAMES
		.iter()
		.filter_map(|name| {
			presets
				.get(name)
				.map(|patch| ((*name).into(), patch.clone()))
		})
		.collect();
	to_js(&Value::Map(all))
}

/// A patch's fields for a merge: `undefined` sets a field to `undefined`, as a spread does; `null` or `undefined` for the whole patch is an empty one.
fn fields_of(patch: &JsValue) -> Result<Vec<(String, Option<Value>)>, JsValue> {
	if patch.is_undefined() || patch.is_null() {
		return Ok(Vec::new());
	}
	Ok(match from_js(patch)? {
		Value::Map(map) => map
			.into_iter()
			.map(|(key, value)| match value {
				Value::Undefined => (key, None),
				other => (key, Some(other)),
			})
			.collect(),
		_ => Vec::new(),
	})
}

/// An entry of `levels` or `pans`: `undefined` (or a missing entry) is `None`, anything else `Number(value)`.
fn entry(list: &JsValue, index: u32) -> Option<f64> {
	if !Array::is_array(list) {
		return None;
	}
	let value = list.unchecked_ref::<Array>().get(index);
	(!value.is_undefined()).then(|| to_number(&value))
}

/// `layer(notes, voices, options?)`: the notes on several voices at once, stacked. `voices` is an array of patches; `options` is `{ stagger?, levels?, pans? }` or `undefined`.
///
/// Built from the pattern crate's own layer map (`MapFn::Layer`), with the reference's checks and messages, so a
/// missing entry of `levels` or `pans` (a hole, or `undefined`) leaves that layer's velocity or pan as it is, as in
/// the reference.
#[wasm_bindgen(js_name = layer)]
pub fn layer_js(
	notes: &WasmPattern,
	voices: &Array,
	options: JsValue,
) -> Result<WasmPattern, JsValue> {
	if voices.length() == 0 {
		return Err(error("layer() needs at least one voice"));
	}
	let stagger = field(&options, "stagger");
	let stagger_value = if stagger.is_undefined() || stagger.is_null() {
		0.0
	} else {
		to_number(&stagger)
	};
	if stagger_value.is_nan() || stagger_value < 0.0 {
		return Err(error(&format!(
			"layer() stagger must not be negative, got {}",
			if stagger.as_f64().is_some() {
				js::number_to_string(stagger_value)
			} else {
				string_of(&stagger)
			}
		)));
	}
	let levels = field(&options, "levels");
	let pans = field(&options, "pans");
	let mut layers = Vec::with_capacity(voices.length() as usize);
	for (index, voice) in voices.iter().enumerate() {
		let at = index as u32;
		layers.push(notes.pattern().fmap(MapFn::Layer(LayerMap {
			fields: fields_of(&voice)?,
			nudge_offset: index as f64 * stagger_value,
			level: entry(&levels, at),
			pan: entry(&pans, at),
		})));
	}
	Ok(WasmPattern::new(stack(layers)))
}

/// The reference's `DEFAULT_PARAMS`, with the numbers read from [`VoiceParams::empty`]: the required fields, and the optional ones it lists as `undefined`.
pub fn default_params() -> BTreeMap<String, Value> {
	let p = VoiceParams::empty();
	let mut map = BTreeMap::new();
	let mut num = |key: &str, value: f64| {
		map.insert(key.to_owned(), Value::Num(value));
	};
	num("gainLevel", p.gain_level);
	num("attack", p.attack);
	num("decay", p.decay);
	num("sustain", p.sustain);
	num("release", p.release);
	num("filterEnvAmount", p.filter_env_amount);
	num("filterAttack", p.filter_attack);
	num("filterDecay", p.filter_decay);
	num("filterSustain", p.filter_sustain);
	num("filterRelease", p.filter_release);
	num("roomSize", p.room_size);
	num("delayTime", p.delay_time);
	num("delayFeedback", p.delay_feedback);
	num("slideTime", p.slide_time);
	num("nudgeTime", p.nudge_time);
	// The engine's default sound type is the sine (a unit test checks it).
	map.insert("soundType".into(), Value::Str("sine".into()));
	for key in [
		"pitch",
		"sampleName",
		"sampleBank",
		"filterCutoff",
		"hpfCutoff",
		"phaserRate",
		"roomLevel",
		"delayLevel",
		"orbit",
	] {
		map.insert(key.into(), Value::Undefined);
	}
	map
}

/// The sustain a sample voice gets when its patch sets none (the reference's `SAMPLE_DEFAULT_SUSTAIN`).
const SAMPLE_DEFAULT_SUSTAIN: f64 = 1.0;

/// `{ ...DEFAULT_PARAMS, ...patch }` plus the sample rule, on values.
pub fn resolve(patch: &Value) -> Value {
	let mut resolved = default_params();
	if let Value::Map(fields) = patch {
		for (key, value) in fields {
			resolved.insert(key.clone(), value.clone());
		}
	}
	if patch.get("sampleName").is_some() && patch.get("sustain").is_none() {
		resolved.insert("sustain".into(), Value::Num(SAMPLE_DEFAULT_SUSTAIN));
	}
	Value::Map(resolved)
}

/// `resolveParams(patch)`: a pattern event's patch filled out to a complete set of voice parameters, as a plain object.
#[wasm_bindgen(js_name = resolveParams)]
pub fn resolve_params_js(patch: JsValue) -> Result<JsValue, JsValue> {
	let patch = if patch.is_undefined() || patch.is_null() {
		Value::Map(BTreeMap::new())
	} else {
		from_js(&patch)?
	};
	Ok(to_js(&resolve(&patch)))
}

#[cfg(test)]
mod tests {
	use super::*;
	use undertone::engine::params::{SoundType, resolve_params};

	#[test]
	fn the_defaults_are_the_engines() {
		let empty = VoiceParams::empty();
		assert_eq!(empty.sound_type, Some(SoundType::Sine));
		let defaults = Value::Map(default_params());
		// Every number the engine resolves from an empty patch is the default here.
		assert_eq!(resolve_params(&defaults), empty);
		let fields: Vec<&str> = include_str!("../../../conformance/api/voice-params.json")
			.split("\"name\": \"")
			.skip(1)
			.map(|rest| rest.split('"').next().unwrap())
			.collect();
		for key in default_params().keys() {
			assert!(
				fields.contains(&key.as_str()),
				"{key} is not a VoiceParams field"
			);
		}
	}

	#[test]
	fn a_sample_voice_holds_unless_it_sets_a_sustain() {
		let sample = Value::field("sampleName", Value::Str("bd".into()));
		assert_eq!(resolve(&sample).get("sustain"), Some(&Value::Num(1.0)));
		assert_eq!(
			resolve_params(&sample).sustain,
			resolve(&sample)
				.get("sustain")
				.and_then(Value::as_number)
				.unwrap()
		);
		let degree = Value::field("degree", Value::Num(2.0));
		assert_eq!(resolve(&degree).get("degree"), Some(&Value::Num(2.0)));
		assert_eq!(resolve(&degree).get_raw("pitch"), Some(&Value::Undefined));
	}
}
