// Reusable instruments as plain voice data: Tone-shaped FM voice definitions, presets, and layering
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Instruments as data: [`fm_voice`], [`fm_presets`], [`Pattern::voice`], and [`layer`] (`src/instruments.ts`
//! and `pattern.voice` in the reference).
//!
//! An instrument is a plain patch, a [`Value::Map`] of voice-parameter fields (the reference's `ControlPatch`),
//! so it can be saved, loaded, and applied to any pattern of notes with [`Pattern::voice`]. [`fm_voice`] takes a
//! definition shaped like Tone.js's `FMSynth` and returns the patch. Because Tone's `modulationIndex` is relative
//! to the carrier and Undertone's `.fm()` is relative to the modulator, [`fm_voice`] divides it by the
//! harmonicity for you. [`layer`] stacks voices on one pattern, with a small start stagger, a level balance, and
//! opposite pans.
//!
//! The pattern side lives in this crate because it is pure data and the engine depends on this crate, never the
//! other way round; `undertone_engine::instruments` re-exports it.
//!
//! ```
//! use undertone_pattern::control::note;
//! use undertone_pattern::instruments::{fm_presets, fm_voice, FmVoiceDefinition, EnvelopeDefinition};
//! use undertone_pattern::{Fraction, Span, Value};
//!
//! let bell = fm_voice(&FmVoiceDefinition {
//!     harmonicity: Some(3.5),
//!     modulation_index: Some(5.0),
//!     envelope: EnvelopeDefinition { attack: Some(0.002), decay: Some(0.7), sustain: Some(0.0), release: Some(0.9) },
//!     level: Some(0.3),
//!     ..FmVoiceDefinition::default()
//! })?;
//! let notes = note("e5 g5")?.voice(&bell);
//! let haps = notes.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
//! assert_eq!(haps[0].value.get("fmHarmonicity"), Some(&Value::Num(3.5)));
//!
//! // Or start from a preset.
//! let pad = note("c3")?.voice(&fm_presets().soft_pad);
//! # let _ = pad;
//! # Ok::<(), undertone_pattern::Error>(())
//! ```

use crate::controls::ControlMap;
use crate::error::{Error, Result};
use crate::js;
use crate::pattern::{Pattern, stack};
use crate::value::{LayerMap, MapFn, Value};
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

/// ADSR times in seconds, with sustain as a 0 to 1 level: the shape Tone.js uses for its envelopes. Every field is optional.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EnvelopeDefinition {
	/// Attack time in seconds.
	pub attack: Option<f64>,
	/// Decay time in seconds.
	pub decay: Option<f64>,
	/// Sustain level, 0 to 1.
	pub sustain: Option<f64>,
	/// Release time in seconds.
	pub release: Option<f64>,
}

/// A Tone.js `FMSynth`-shaped definition of an FM instrument. Every field is optional, and a field left out stays unset in the patch and takes Undertone's usual default, not Tone's.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FmVoiceDefinition {
	/// Modulator frequency divided by carrier frequency (Tone's `harmonicity`). Must be positive.
	pub harmonicity: Option<f64>,
	/// Tone's `modulationIndex`: peak deviation as a multiple of the carrier frequency. Leave it out (or 0) for no FM. Must not be negative.
	pub modulation_index: Option<f64>,
	/// The carrier's waveform name (Tone's `oscillator.type`), such as `"triangle"` or `"halfsine"`. Not checked here, as in the reference.
	pub oscillator: Option<String>,
	/// The modulator's waveform name (Tone's `modulation.type`). Used only when there is FM.
	pub modulation: Option<String>,
	/// The amplitude envelope.
	pub envelope: EnvelopeDefinition,
	/// The modulator-depth envelope (Tone's `modulationEnvelope`). Used only when there is FM.
	pub modulation_envelope: EnvelopeDefinition,
	/// Peak amplitude, 0 to 1, as `.gain()`.
	pub level: Option<f64>,
	/// Stereo position, -1 to 1.
	pub pan: Option<f64>,
}

fn number(value: f64) -> Value {
	Value::Num(value)
}

/// Turns a Tone.js-shaped FM definition into a plain patch: JSON-safe data you can apply with [`Pattern::voice`], save, and reload.
///
/// Tone's `modulationIndex` is relative to the carrier frequency while Undertone's `.fm()` is relative to the modulator (Strudel's convention), so the index is divided by the harmonicity on the way through. Fields you leave out stay unset and take Undertone's usual defaults, not Tone's. Without a modulation index above 0 there is no FM: the harmonicity, the modulator's waveform, and the modulator's envelope are left out.
///
/// # Errors
///
/// The harmonicity must be positive and the modulation index must not be negative, with the reference's messages (`fmVoice() harmonicity must be positive, got 0`).
///
/// ```
/// use undertone_pattern::instruments::{fm_voice, FmVoiceDefinition};
/// use undertone_pattern::Value;
/// let patch = fm_voice(&FmVoiceDefinition {
///     harmonicity: Some(2.0),
///     modulation_index: Some(7.0),
///     ..FmVoiceDefinition::default()
/// })?;
/// // Tone's index is relative to the carrier, so 7 / harmonicity 2.
/// assert_eq!(patch.get("fmIndex"), Some(&Value::Num(3.5)));
/// assert!(fm_voice(&FmVoiceDefinition { harmonicity: Some(0.0), ..FmVoiceDefinition::default() }).is_err());
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
pub fn fm_voice(definition: &FmVoiceDefinition) -> Result<Value> {
	let FmVoiceDefinition {
		harmonicity,
		modulation_index,
		..
	} = definition;
	if let Some(harmonicity) = harmonicity
		&& (harmonicity.is_nan() || *harmonicity <= 0.0)
	{
		return Err(Error::new(alloc::format!(
			"fmVoice() harmonicity must be positive, got {}",
			js::number_to_string(*harmonicity)
		)));
	}
	if let Some(index) = modulation_index
		&& (index.is_nan() || *index < 0.0)
	{
		return Err(Error::new(alloc::format!(
			"fmVoice() modulationIndex must not be negative, got {}",
			js::number_to_string(*index)
		)));
	}

	let mut patch = BTreeMap::new();
	let mut set = |key: &str, value: Value| {
		patch.insert(key.into(), value);
	};
	if let Some(wave) = &definition.oscillator {
		set("soundType", Value::Str(wave.clone()));
	}
	let envelope = &definition.envelope;
	for (key, field) in [
		("attack", envelope.attack),
		("decay", envelope.decay),
		("sustain", envelope.sustain),
		("release", envelope.release),
	] {
		if let Some(field) = field {
			set(key, number(field));
		}
	}
	if let Some(level) = definition.level {
		set("gainLevel", number(level));
	}
	if let Some(pan) = definition.pan {
		set("pan", number(pan));
	}

	if let Some(index) = modulation_index
		&& *index > 0.0
	{
		set("fmIndex", number(index / harmonicity.unwrap_or(1.0)));
		if let Some(harmonicity) = harmonicity {
			set("fmHarmonicity", number(*harmonicity));
		}
		if let Some(wave) = &definition.modulation {
			set("fmWave", Value::Str(wave.clone()));
		}
		let modulation = &definition.modulation_envelope;
		for (key, field) in [
			("fmAttack", modulation.attack),
			("fmDecay", modulation.decay),
			("fmSustain", modulation.sustain),
			("fmRelease", modulation.release),
		] {
			if let Some(field) = field {
				set(key, number(field));
			}
		}
	}
	Ok(Value::Map(patch))
}

/// The five FM presets: readable starting points to copy and bend, as much as presets. Each is a plain patch: `note("e5 g5")?.voice(&fm_presets().glass_bell)`. See [`fm_presets`].
#[derive(Clone, Debug, PartialEq)]
pub struct FmPresets {
	/// An inharmonic ratio with a quick-fading modulator: a bright strike that rings clean.
	pub glass_bell: Value,
	/// Matched ratio with a soft triangle modulator: round weight, little edge.
	pub round_bass: Value,
	/// A slow attack and a gently breathing modulator for sustained chords.
	pub soft_pad: Value,
	/// A short, bright-to-mellow pluck.
	pub pluck: Value,
	/// A sustained lead whose modulator settles to a steady, reedy edge.
	pub lead: Value,
}

/// The JavaScript names of the presets, in the order of [`FmPresets::get`]'s table: `glassBell`, `roundBass`, `softPad`, `pluck`, `lead`.
pub const FM_PRESET_NAMES: [&str; 5] = ["glassBell", "roundBass", "softPad", "pluck", "lead"];

impl FmPresets {
	/// The preset with a JavaScript name (`"glassBell"`, `"roundBass"`, `"softPad"`, `"pluck"`, `"lead"`), or `None` for any other.
	pub fn get(&self, name: &str) -> Option<&Value> {
		Some(match name {
			"glassBell" => &self.glass_bell,
			"roundBass" => &self.round_bass,
			"softPad" => &self.soft_pad,
			"pluck" => &self.pluck,
			"lead" => &self.lead,
			_ => return None,
		})
	}
}

fn envelope(attack: f64, decay: f64, sustain: Option<f64>, release: f64) -> EnvelopeDefinition {
	EnvelopeDefinition {
		attack: Some(attack),
		decay: Some(decay),
		sustain,
		release: Some(release),
	}
}

fn preset(definition: FmVoiceDefinition) -> Value {
	fm_voice(&definition).expect("a preset definition is valid")
}

/// A small set of readable FM instruments (`fmPresets`): `glassBell`, `roundBass`, `softPad`, `pluck`, and `lead`. Each is built from [`fm_voice`] with the reference's numbers, so each is plain data.
///
/// The presets are readable starting points more than finished instruments: change one thing and keep the rest, as in `{ ...fmPresets.roundBass, gainLevel: 0.6 }`.
///
/// ```
/// use undertone_pattern::instruments::fm_presets;
/// use undertone_pattern::Value;
/// let bell = fm_presets().glass_bell;
/// assert_eq!(bell.get("fmHarmonicity"), Some(&Value::Num(3.5)));
/// assert_eq!(bell.get("gainLevel"), Some(&Value::Num(0.3)));
/// ```
pub fn fm_presets() -> FmPresets {
	FmPresets {
		glass_bell: preset(FmVoiceDefinition {
			harmonicity: Some(3.5),
			modulation_index: Some(5.0),
			envelope: envelope(0.002, 0.7, Some(0.0), 0.9),
			modulation_envelope: envelope(0.0, 0.35, None, 0.2),
			level: Some(0.3),
			..FmVoiceDefinition::default()
		}),
		round_bass: preset(FmVoiceDefinition {
			harmonicity: Some(1.0),
			modulation_index: Some(3.5),
			modulation: Some("triangle".into()),
			envelope: envelope(0.005, 0.2, Some(0.6), 0.12),
			modulation_envelope: envelope(0.0, 0.18, Some(0.3), 0.1),
			level: Some(0.5),
			..FmVoiceDefinition::default()
		}),
		soft_pad: preset(FmVoiceDefinition {
			harmonicity: Some(2.0),
			modulation_index: Some(1.2),
			envelope: envelope(0.4, 0.3, Some(0.8), 0.9),
			modulation_envelope: envelope(0.5, 0.6, Some(0.5), 0.8),
			level: Some(0.22),
			..FmVoiceDefinition::default()
		}),
		pluck: preset(FmVoiceDefinition {
			harmonicity: Some(2.0),
			modulation_index: Some(6.0),
			envelope: envelope(0.003, 0.2, Some(0.25), 0.15),
			modulation_envelope: envelope(0.0, 0.12, Some(0.1), 0.1),
			level: Some(0.35),
			..FmVoiceDefinition::default()
		}),
		lead: preset(FmVoiceDefinition {
			harmonicity: Some(2.0),
			modulation_index: Some(3.4),
			envelope: envelope(0.008, 0.12, Some(0.52), 0.16),
			modulation_envelope: envelope(0.004, 0.16, Some(0.14), 0.1),
			level: Some(0.32),
			..FmVoiceDefinition::default()
		}),
	}
}

/// A patch's fields as a merge: `Undefined` stays `None`, a field set to `undefined` on purpose. A patch that is not a map has no fields, as spreading it in JavaScript gives none.
fn fields_of(patch: &Value) -> Vec<(String, Option<Value>)> {
	match patch {
		Value::Map(map) => map
			.iter()
			.map(|(key, value)| {
				(
					key.clone(),
					match value {
						Value::Undefined => None,
						other => Some(other.clone()),
					},
				)
			})
			.collect(),
		_ => Vec::new(),
	}
}

impl Pattern<ControlMap> {
	/// Applies a whole instrument at once: merges a plain patch (such as one from [`fm_voice`] or [`fm_presets`], or loaded from saved data) into every event. Fields the patch sets overwrite the events', so call it before the per-note controls you want to win: `note("e5 g5")?.voice(&bell).gain(0.2)?`. A patch that is not a map changes nothing.
	///
	/// **JavaScript name:** `voice`.
	///
	/// ```
	/// use undertone_pattern::control::note;
	/// use undertone_pattern::instruments::fm_presets;
	/// use undertone_pattern::{Fraction, Span, Value};
	/// let p = note("e5")?.voice(&fm_presets().pluck).gain(0.9)?;
	/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	/// // The control chained after voice() wins.
	/// assert_eq!(haps[0].value.get("gainLevel"), Some(&Value::Num(0.9)));
	/// assert_eq!(haps[0].value.get("fmIndex"), Some(&Value::Num(3.0)));
	/// # Ok::<(), undertone_pattern::Error>(())
	/// ```
	pub fn voice(&self, patch: &Value) -> Pattern<ControlMap> {
		self.fmap(MapFn::Merge(fields_of(patch)))
	}
}

/// Options for [`layer`]. Entries of `levels` and `pans` are matched to the layers by position; a layer past the end of a list uses the default.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayerOptions {
	/// Seconds each successive layer starts after the previous one: layer `i` is nudged `i * stagger`. A couple of milliseconds reads as width and body, not an echo. Default 0 (`None`).
	pub stagger: Option<f64>,
	/// Per-layer strength, multiplying each note's own `velocity`, so a pluck can lead and a sustained partner fill in. Default 1 each.
	pub levels: Vec<f64>,
	/// Per-layer stereo position, -1 to 1, replacing any pan on the notes. A layer's own `pan` is used when this entry is missing.
	pub pans: Vec<f64>,
}

/// Plays one pattern of notes on several voices at once: the usual way to get a thicker sound from a small synth. Each entry of `voices` is a plain patch (an [`fm_voice`] result, a preset, or any map of fields); the layers are stacked, with an optional start stagger, level balance, and pans.
///
/// Stagger adds to any `nudge` already on the notes and levels multiply their `velocity`, so layering composes with [`drift`](crate::drift::drift) and with scored accents; a layer `pans` entry replaces the notes' pan. A layer voice also keeps any control the notes carry that its own patch does not set (a waveform or filter from the incoming pattern, say), so set those in the voice patch.
///
/// # Errors
///
/// `layer() needs at least one voice` for an empty list, and `layer() stagger must not be negative, got -1` for a stagger below 0 or not a number.
///
/// ```
/// use undertone_pattern::control::note;
/// use undertone_pattern::instruments::{layer, LayerOptions};
/// use undertone_pattern::{Fraction, Span, Value};
/// let square = Value::field("soundType", Value::Str("square".into()));
/// let layered = layer(
///     &note("a4")?,
///     &[square, Value::Map(Default::default())],
///     &LayerOptions { stagger: Some(0.002), levels: vec![1.0, 0.5], pans: vec![-0.4, 0.4] },
/// )?;
/// let haps = layered.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
/// assert_eq!(haps.len(), 2);
/// assert_eq!(haps[1].value.get("nudgeTime"), Some(&Value::Num(0.002)));
/// assert_eq!(haps[1].value.get("pan"), Some(&Value::Num(0.4)));
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
pub fn layer(
	notes: &Pattern<ControlMap>,
	voices: &[Value],
	options: &LayerOptions,
) -> Result<Pattern<ControlMap>> {
	if voices.is_empty() {
		return Err(Error::new("layer() needs at least one voice"));
	}
	let stagger = options.stagger.unwrap_or(0.0);
	if stagger.is_nan() || stagger < 0.0 {
		return Err(Error::new(alloc::format!(
			"layer() stagger must not be negative, got {}",
			js::number_to_string(stagger)
		)));
	}
	let layers = voices
		.iter()
		.enumerate()
		.map(|(index, voice)| {
			notes.fmap(MapFn::Layer(LayerMap {
				fields: fields_of(voice),
				nudge_offset: index as f64 * stagger,
				level: options.levels.get(index).copied(),
				pan: options.pans.get(index).copied(),
			}))
		})
		.collect();
	Ok(stack(layers))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::control::note;
	use crate::{Fraction, Span};

	fn first_cycle(p: &Pattern<ControlMap>) -> Vec<Value> {
		p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)))
			.into_iter()
			.map(|hap| hap.value)
			.collect()
	}

	#[test]
	fn converts_a_full_definition() {
		let patch = fm_voice(&FmVoiceDefinition {
			harmonicity: Some(2.0),
			modulation_index: Some(7.0),
			oscillator: Some("triangle".into()),
			modulation: Some("square".into()),
			envelope: EnvelopeDefinition {
				attack: Some(0.01),
				decay: Some(0.2),
				sustain: Some(0.5),
				release: Some(0.3),
			},
			modulation_envelope: EnvelopeDefinition {
				attack: Some(0.02),
				decay: Some(0.1),
				sustain: Some(0.25),
				release: Some(0.05),
			},
			level: Some(0.4),
			pan: Some(-0.3),
		})
		.unwrap();
		let Value::Map(map) = patch else { panic!() };
		let expect = [
			("soundType", Value::Str("triangle".into())),
			("attack", Value::Num(0.01)),
			("decay", Value::Num(0.2)),
			("sustain", Value::Num(0.5)),
			("release", Value::Num(0.3)),
			("gainLevel", Value::Num(0.4)),
			("pan", Value::Num(-0.3)),
			("fmIndex", Value::Num(3.5)),
			("fmHarmonicity", Value::Num(2.0)),
			("fmWave", Value::Str("square".into())),
			("fmAttack", Value::Num(0.02)),
			("fmDecay", Value::Num(0.1)),
			("fmSustain", Value::Num(0.25)),
			("fmRelease", Value::Num(0.05)),
		];
		assert_eq!(map.len(), expect.len());
		for (key, value) in expect {
			assert_eq!(map.get(key), Some(&value), "{key}");
		}
	}

	#[test]
	fn leaves_fm_out_without_an_index_and_unset_fields_unset() {
		let patch = fm_voice(&FmVoiceDefinition {
			harmonicity: Some(3.0),
			envelope: EnvelopeDefinition {
				attack: Some(0.1),
				..EnvelopeDefinition::default()
			},
			..FmVoiceDefinition::default()
		})
		.unwrap();
		assert_eq!(patch, Value::field("attack", Value::Num(0.1)));
		assert_eq!(
			fm_voice(&FmVoiceDefinition::default()).unwrap(),
			Value::Map(BTreeMap::new())
		);
	}

	#[test]
	fn rejects_bad_values_with_the_reference_messages() {
		let bad = |definition: FmVoiceDefinition| fm_voice(&definition).unwrap_err();
		assert_eq!(
			bad(FmVoiceDefinition {
				harmonicity: Some(0.0),
				..FmVoiceDefinition::default()
			})
			.message(),
			"fmVoice() harmonicity must be positive, got 0"
		);
		assert_eq!(
			bad(FmVoiceDefinition {
				harmonicity: Some(f64::NAN),
				..FmVoiceDefinition::default()
			})
			.message(),
			"fmVoice() harmonicity must be positive, got NaN"
		);
		assert_eq!(
			bad(FmVoiceDefinition {
				modulation_index: Some(-1.0),
				..FmVoiceDefinition::default()
			})
			.message(),
			"fmVoice() modulationIndex must not be negative, got -1"
		);
	}

	#[test]
	fn every_preset_sounds_as_fm_and_is_found_by_name() {
		let presets = fm_presets();
		for name in FM_PRESET_NAMES {
			let patch = presets.get(name).unwrap();
			assert!(patch.get("fmIndex").and_then(Value::as_number).unwrap() > 0.0);
		}
		assert!(presets.get("lute").is_none());
	}

	#[test]
	fn a_layer_adds_the_stagger_to_a_nudge_and_scales_the_velocity() {
		let notes = note("a4")
			.unwrap()
			.nudge(0.01)
			.unwrap()
			.velocity(0.5)
			.unwrap();
		let layered = layer(
			&notes,
			&[Value::Map(BTreeMap::new()), Value::Map(BTreeMap::new())],
			&LayerOptions {
				stagger: Some(0.002),
				levels: vec![1.0, 0.5],
				pans: Vec::new(),
			},
		)
		.unwrap();
		let values = first_cycle(&layered);
		assert_eq!(values[0].get("nudgeTime"), Some(&Value::Num(0.01)));
		assert_eq!(values[1].get("nudgeTime"), Some(&Value::Num(0.01 + 0.002)));
		assert_eq!(values[1].get("velocity"), Some(&Value::Num(0.25)));
		assert_eq!(values[1].get("pan"), None);
	}

	#[test]
	fn a_layer_voice_overrides_the_notes_but_inherits_what_it_does_not_set() {
		let notes = note("a4").unwrap().sound("sawtooth");
		let square = Value::field("soundType", Value::Str("square".into()));
		let layered = layer(
			&notes,
			&[square, Value::Map(BTreeMap::new())],
			&LayerOptions::default(),
		)
		.unwrap();
		let values = first_cycle(&layered);
		assert_eq!(
			values[0].get("soundType"),
			Some(&Value::Str("square".into()))
		);
		assert_eq!(
			values[1].get("soundType"),
			Some(&Value::Str("sawtooth".into()))
		);
	}

	#[test]
	fn layer_rejects_bad_input() {
		let notes = note("a4").unwrap();
		let none = layer(&notes, &[], &LayerOptions::default()).unwrap_err();
		assert_eq!(none.message(), "layer() needs at least one voice");
		let negative = layer(
			&notes,
			&[Value::Map(BTreeMap::new())],
			&LayerOptions {
				stagger: Some(-1.0),
				..LayerOptions::default()
			},
		)
		.unwrap_err();
		assert_eq!(
			negative.message(),
			"layer() stagger must not be negative, got -1"
		);
	}

	#[test]
	fn a_layered_pattern_crosses_threads_as_text() {
		let notes = note("a4 c5").unwrap();
		let layered = layer(
			&notes,
			&[Value::field("pan", Value::Num(0.7))],
			&LayerOptions {
				stagger: Some(0.001),
				levels: vec![0.5],
				pans: vec![-0.4],
			},
		)
		.unwrap();
		let text = layered.serialize().unwrap();
		let back = Pattern::<ControlMap>::deserialize(&text).unwrap();
		assert_eq!(first_cycle(&back), first_cycle(&layered));
		assert_eq!(back.serialize().unwrap(), text);
	}
}
