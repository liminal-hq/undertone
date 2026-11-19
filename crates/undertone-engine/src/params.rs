// The complete set of parameters one synth voice is played with, mirroring the TypeScript `VoiceParams`
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`VoiceParams`]: everything a voice needs, as the TypeScript `VoiceParams` of 0.4.0 has it.
//!
//! The Rust fields are snake_case. With the `serde` feature on, the JSON form uses the TypeScript's
//! camelCase field names exactly (`#[serde(rename_all = "camelCase")]`), and an optional field that is
//! unset is left out, the way an `undefined` property is left out of a JavaScript object. Saved settings
//! hold these names, so they are frozen: `tests/voice_params_names.rs` checks them against
//! `conformance/api/voice-params.json`, the field list read from `src/types.ts`.
//!
//! Every number is an `f64`, as in JavaScript. Fields marked "required" in the TypeScript type are plain
//! values here; the optional ones are [`Option`]s. The one exception is `soundType`, which a sample voice
//! leaves out (see [`VoiceParams::sound_type`]).
//!
//! ```
//! use undertone_engine::params::{SoundType, VoiceParams};
//!
//! let params = VoiceParams::empty();
//! assert_eq!(params.sound_type, Some(SoundType::Sine));
//! assert_eq!(params.gain_level, 0.8);
//! assert_eq!(params.pan, None);
//! ```

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};
use undertone_pattern::{ControlMap, Value};

/// A waveform or noise colour a voice can be synthesised from: the TypeScript `SoundType`.
///
/// The JSON form is the lower-case word (`"sine"`, `"halfsine"`, `"white"`, and so on).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum SoundType {
	/// A sine wave (`OscType`).
	Sine,
	/// A triangle wave (`OscType`).
	Triangle,
	/// A square wave (`OscType`).
	Square,
	/// A sawtooth wave (`OscType`).
	Sawtooth,
	/// A half-wave rectified sine (`ShapedWaveType`).
	Halfsine,
	/// A full-wave rectified (absolute) sine (`ShapedWaveType`).
	Abssine,
	/// A pulsed sine (`ShapedWaveType`).
	Pulsesine,
	/// White noise (`NoiseType`).
	White,
	/// Pink noise (`NoiseType`).
	Pink,
	/// Brown noise (`NoiseType`).
	Brown,
}

/// The modulator waveform of an FM voice: the TypeScript `OscType | ShapedWaveType`, so any oscillator
/// or shaped waveform but no noise.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum FmWave {
	/// A sine wave.
	Sine,
	/// A triangle wave.
	Triangle,
	/// A square wave.
	Square,
	/// A sawtooth wave.
	Sawtooth,
	/// A half-wave rectified sine.
	Halfsine,
	/// A full-wave rectified (absolute) sine.
	Abssine,
	/// A pulsed sine.
	Pulsesine,
}

/// The ramp shape of the FM modulator-depth envelope: the TypeScript `'lin' | 'exp'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum FmEnvCurve {
	/// A straight-line ramp.
	Lin,
	/// An exponential ramp (the default).
	Exp,
}

/// The wave of the autopan oscillator: the TypeScript `'sine' | 'triangle' | 'square'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum AutopanShape {
	/// A sine wave (the default).
	Sine,
	/// A triangle wave.
	Triangle,
	/// A square wave.
	Square,
}

/// A pitch: a note name or a frequency, the TypeScript `string | number`.
///
/// In JSON it is a bare string (`"c3"`) or a bare number (`440`).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(untagged))]
pub enum Pitch {
	/// A note name such as `"c2"`, `"a4"`, or `"f#3"`.
	Name(String),
	/// A raw frequency in Hz.
	Hz(f64),
}

/// One point of a voice's [`pan_path`](VoiceParams::pan_path): a stereo position at a time inside the
/// note. The TypeScript `PanPoint`.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PanPoint {
	/// Seconds from the voice's start (after any nudge). JavaScript name `time`.
	pub time: f64,
	/// Stereo position from -1 (hard left) to 1 (hard right); clamped. JavaScript name `pan`.
	pub pan: f64,
}

/// The complete parameters of one voice, after the controls of a pattern event have been merged over the
/// engine's defaults: the TypeScript `VoiceParams` of 0.4.0, 52 fields.
///
/// Build the all-defaults value with [`VoiceParams::empty`] (or [`Default`]) and set fields on it. Each
/// field's documentation gives its JavaScript name, which is also its JSON key.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VoiceParams {
	/// The waveform or noise colour, JavaScript name `soundType`. Default `sine`.
	///
	/// Required in the TypeScript type, but `.s(name)` for a sample sets it to `undefined`, and the
	/// recorded objects then have no `soundType` key; so it is an [`Option`] here, [`None`] meaning a
	/// sample voice.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub sound_type: Option<SoundType>,
	/// A note name (`"c2"`, `"a4"`, `"f#3"`) or a raw frequency in Hz, JavaScript name `pitch`.
	/// Ignored for noise sound types.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pitch: Option<Pitch>,
	/// A name registered as a sample, JavaScript name `sampleName`. Takes precedence over
	/// [`sound_type`](Self::sound_type) when set; `s()` and `.s()` set it for any word that is not a
	/// synth sound type.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub sample_name: Option<String>,
	/// The sample bank, JavaScript name `sampleBank` (`.bank(name)`). Tried as
	/// `{sampleBank}_{sampleName}` before falling back to `sampleName` alone.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub sample_bank: Option<String>,
	/// The peak level, JavaScript name `gainLevel` (required; the `gain` control). Default 0.8.
	pub gain_level: f64,
	/// Seconds the amplitude takes to rise to its peak, JavaScript name `attack` (required). Default 0.01.
	pub attack: f64,
	/// Seconds the amplitude takes to fall to the sustain level, JavaScript name `decay` (required).
	/// Default 0.1.
	pub decay: f64,
	/// Fraction (0 to 1) of [`gain_level`](Self::gain_level) the decay settles to before release,
	/// JavaScript name `sustain` (required). Default 0; a voice with a sample name defaults to 1.
	pub sustain: f64,
	/// Seconds the amplitude takes to fall to silence after the gate closes, JavaScript name `release`
	/// (required). Default 0.05.
	pub release: f64,
	/// Base lowpass cutoff in Hz, JavaScript name `filterCutoff` (the `lpf` control). No filter is
	/// created at all when unset.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub filter_cutoff: Option<f64>,
	/// Hz the filter envelope adds on top of [`filter_cutoff`](Self::filter_cutoff) at its peak,
	/// JavaScript name `filterEnvAmount` (the `lpenv` control; required). Default 0.
	pub filter_env_amount: f64,
	/// Seconds the filter envelope takes to reach its peak, JavaScript name `filterAttack` (`lpa`;
	/// required). Default 0.
	pub filter_attack: f64,
	/// Seconds the filter envelope takes to fall to its sustain, JavaScript name `filterDecay` (`lpd`;
	/// required). Default 0.
	pub filter_decay: f64,
	/// Fraction (0 to 1) between the cutoff and its peak the filter decay settles to, JavaScript name
	/// `filterSustain` (`lps`; required). Default 1.
	pub filter_sustain: f64,
	/// Seconds the filter envelope takes to return after the gate closes, JavaScript name
	/// `filterRelease` (`lpr`; required). Default 0.
	pub filter_release: f64,
	/// Static highpass cutoff in Hz, in series after the lowpass, JavaScript name `hpfCutoff` (the `hpf`
	/// control). No filter is created when unset.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub hpf_cutoff: Option<f64>,
	/// LFO rate in Hz driving a four-stage allpass phaser, JavaScript name `phaserRate`. No phaser is
	/// created when unset.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub phaser_rate: Option<f64>,
	/// Reverb send level (0 to 1) to this voice's orbit bus, JavaScript name `roomLevel` (the `room`
	/// control). No send at all when unset or 0.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub room_level: Option<f64>,
	/// Reverb decay character for the orbit's shared bus, roughly 1 (short) to 10 (long), JavaScript name
	/// `roomSize` (the `roomsize` control; required). Default 3.
	pub room_size: f64,
	/// Delay send level (0 to 1) to this voice's orbit bus, JavaScript name `delayLevel` (the `delay`
	/// control). No send at all when unset or 0.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub delay_level: Option<f64>,
	/// Delay time in seconds for the orbit's shared delay bus, JavaScript name `delayTime` (the
	/// `delaytime` control; required). Default 0.3.
	pub delay_time: f64,
	/// Feedback (0 to 1) for the orbit's shared delay bus, JavaScript name `delayFeedback` (the
	/// `delayfeedback` control; required). Default 0.35.
	pub delay_feedback: f64,
	/// Which shared effects bus this voice's room and delay sends target, JavaScript name `orbit`. Default 0.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub orbit: Option<f64>,
	/// Pitch glide (portamento) time in seconds, JavaScript name `slideTime` (the `slide` control;
	/// required). The pitch starts an octave above the target and slides down. Default 0.
	pub slide_time: f64,
	/// Pitch envelope depth in semitones (negative for a falling start), JavaScript name
	/// `pitchEnvAmount`: the pitch moves from the note to this offset over
	/// [`pitch_attack`](Self::pitch_attack), then returns to the note over
	/// [`pitch_decay`](Self::pitch_decay). Synth voices only. Unset or 0 means none.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pitch_env_amount: Option<f64>,
	/// Seconds the pitch envelope takes to reach its offset (0 starts there), JavaScript name
	/// `pitchAttack`. Default 0.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pitch_attack: Option<f64>,
	/// Seconds the pitch envelope takes to return to the note, JavaScript name `pitchDecay`. Default 0.1.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pitch_decay: Option<f64>,
	/// A stepped pitch curve as semitone offsets from the note, one per frame, JavaScript name
	/// `pitchSteps`: the pitch jumps to each offset in turn and holds the last. Takes priority over the
	/// envelope and the slide.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pitch_steps: Option<Vec<f64>>,
	/// Frames per second for [`pitch_steps`](Self::pitch_steps), JavaScript name `pitchStepRate`.
	/// Default 140 (the frame rate of classic AdLib effects).
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pitch_step_rate: Option<f64>,
	/// FM modulation index, JavaScript name `fmIndex`: the modulator swings the carrier's frequency by
	/// index times the modulator frequency, so the sound stays equally bright as the pitch changes.
	/// 0 or unset adds no FM nodes. Synth voices only.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub fm_index: Option<f64>,
	/// FM harmonicity, modulator frequency divided by carrier frequency, JavaScript name
	/// `fmHarmonicity`. Non-integers give bell and metallic tones. Default 1.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub fm_harmonicity: Option<f64>,
	/// Seconds for the modulator depth to reach the full index, JavaScript name `fmAttack`. Without any
	/// of the four envelope fields the index is constant. Default 0.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub fm_attack: Option<f64>,
	/// Seconds for the modulator depth to fall to `fmSustain` times the index, JavaScript name
	/// `fmDecay`. Default 0.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub fm_decay: Option<f64>,
	/// Fraction (0 to 1) of the index the modulator depth settles to, JavaScript name `fmSustain`.
	/// Default 1, or 0 when only `fmDecay` is set.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub fm_sustain: Option<f64>,
	/// Seconds for the modulator depth to fall to 0 after the gate closes, JavaScript name `fmRelease`.
	/// Default 0.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub fm_release: Option<f64>,
	/// Ramp shape of the modulator-depth envelope, JavaScript name `fmEnvCurve`: `exp` (the default) or
	/// `lin`.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub fm_env_curve: Option<FmEnvCurve>,
	/// Modulator waveform, JavaScript name `fmWave`: any oscillator or shaped waveform. Default `sine`.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub fm_wave: Option<FmWave>,
	/// Start-time offset in seconds, relative to the pattern's shared start time, JavaScript name
	/// `nudgeTime` (the `nudge` control; required). Default 0.
	pub nudge_time: f64,
	/// Stereo position from -1 (hard left) to 1 (hard right), JavaScript name `pan`. No panner node is
	/// created when unset.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pan: Option<f64>,
	/// Pan automation inside the note, JavaScript name `panPath` (new in 0.4.0): points in time order, in
	/// seconds from the voice's start. The first point is the pan at the onset (replacing
	/// [`pan`](Self::pan)); the pan moves linearly from each point to the next, jumps when two points
	/// share a time, and holds the last value through the release. Pans are clamped to -1..1. Creates the
	/// panner even without `pan`; an empty path is no path. Ignored when
	/// [`channel_gains`](Self::channel_gains) is set.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pan_path: Option<Vec<PanPoint>>,
	/// Autopan rate in Hz, JavaScript name `autopan` (new in 0.4.0): a low-frequency oscillator that
	/// swings the pan either side of the voice's pan (or of its path or slide), from the onset through the
	/// release. Creates the panner even without `pan`. No LFO when unset or not positive. Ignored when
	/// `channel_gains` is set.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub autopan: Option<f64>,
	/// How far the autopan swings either side of the voice's pan, 0 to 1 (clamped), JavaScript name
	/// `autopanDepth` (new in 0.4.0). Default 1. The panner clamps the sum to -1..1.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub autopan_depth: Option<f64>,
	/// The autopan oscillator's wave, JavaScript name `autopanShape` (new in 0.4.0): `sine` (the
	/// default), `triangle`, or `square`.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub autopan_shape: Option<AutopanShape>,
	/// Where in its cycle the autopan starts, as a fraction of a cycle (wrapped into 0..1), JavaScript
	/// name `autopanPhase` (new in 0.4.0). Default 0: a sine or triangle starts at the centre moving
	/// right, a square on the right.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub autopan_phase: Option<f64>,
	/// Pan slide start, -1 to 1, JavaScript name `panSlideFrom` (new in 0.4.0): the voice starts at this
	/// pan and moves linearly to its own pan (the centre without one) over
	/// [`pan_slide_time`](Self::pan_slide_time). A `pan_path` takes precedence over it.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pan_slide_from: Option<f64>,
	/// Seconds the pan slide takes, JavaScript name `panSlideTime` (new in 0.4.0). Default: the voice's
	/// attack.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pan_slide_time: Option<f64>,
	/// Pan law: each side's level at the centre in dB, -6 to 0 (clamped), JavaScript name `panLaw` (new
	/// in 0.4.0). Unset or -3 keeps the stereo panner's equal-power law. Any other value places a panned
	/// voice with one gain per side, `min(1, sqrt(2) * 10^(law/20) * cos or sin of (pan + 1) * pi/4)`.
	/// Applies only to a voice with `pan` or `pan_path`; ignored, like them, when `channel_gains` is set.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub pan_law: Option<f64>,
	/// Per-speaker output gains for multichannel (up to 7.1) playback, JavaScript name `channelGains`, in
	/// the order FL, FR, C, LFE, SL, SR, RL, RR (1 to 8 entries). Takes precedence over `pan` when set.
	/// Voices are folded down to stereo when the destination has fewer channels.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub channel_gains: Option<Vec<f64>>,
	/// Gate length in seconds, JavaScript name `duration`: the envelopes hold at their sustain level until
	/// this long after the voice starts, then release. Percussive (no hold) when unset. The scheduler
	/// sets this from each event's pattern duration.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub duration: Option<f64>,
	/// Gate length as a fraction of the event's own length in the pattern, JavaScript name `legato` (1 is
	/// the whole event, 0.5 half of it). Applied by the scheduler, and forces a gate even in an ungated
	/// play. Ignored when an explicit `duration` is set.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub legato: Option<f64>,
	/// Strength of this note, JavaScript name `velocity`, multiplying the peak amplitude only. Default 1.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub velocity: Option<f64>,
	/// Cut group, JavaScript name `cutGroup` (the `cut` control): a new voice in the same group stops
	/// the previous one with a very short fade, like a hi-hat choke.
	#[cfg_attr(
		feature = "serde",
		serde(default, skip_serializing_if = "Option::is_none")
	)]
	pub cut_group: Option<f64>,
}

impl VoiceParams {
	/// The parameters the engine gives a voice that has no controls: what the TypeScript's
	/// `resolveParams({})` returns (its `DEFAULT_PARAMS`).
	///
	/// Required fields take their defaults (`soundType` `sine`, `gainLevel` 0.8, `attack` 0.01,
	/// `decay` 0.1, `sustain` 0, `release` 0.05, `filterEnvAmount` 0, `filterAttack` 0, `filterDecay` 0,
	/// `filterSustain` 1, `filterRelease` 0, `roomSize` 3, `delayTime` 0.3, `delayFeedback` 0.35,
	/// `slideTime` 0, `nudgeTime` 0) and every optional field is unset. The sample rule (a voice with a
	/// `sampleName` and no `sustain` gets a `sustain` of 1) belongs to resolution, not to this value.
	///
	/// ```
	/// use undertone_engine::params::VoiceParams;
	///
	/// assert_eq!(VoiceParams::empty(), VoiceParams::default());
	/// ```
	pub fn empty() -> Self {
		Self {
			sound_type: Some(SoundType::Sine),
			pitch: None,
			sample_name: None,
			sample_bank: None,
			gain_level: 0.8,
			attack: 0.01,
			decay: 0.1,
			sustain: 0.0,
			release: 0.05,
			filter_cutoff: None,
			filter_env_amount: 0.0,
			filter_attack: 0.0,
			filter_decay: 0.0,
			filter_sustain: 1.0,
			filter_release: 0.0,
			hpf_cutoff: None,
			phaser_rate: None,
			room_level: None,
			room_size: 3.0,
			delay_level: None,
			delay_time: 0.3,
			delay_feedback: 0.35,
			orbit: None,
			slide_time: 0.0,
			pitch_env_amount: None,
			pitch_attack: None,
			pitch_decay: None,
			pitch_steps: None,
			pitch_step_rate: None,
			fm_index: None,
			fm_harmonicity: None,
			fm_attack: None,
			fm_decay: None,
			fm_sustain: None,
			fm_release: None,
			fm_env_curve: None,
			fm_wave: None,
			nudge_time: 0.0,
			pan: None,
			pan_path: None,
			autopan: None,
			autopan_depth: None,
			autopan_shape: None,
			autopan_phase: None,
			pan_slide_from: None,
			pan_slide_time: None,
			pan_law: None,
			channel_gains: None,
			duration: None,
			legato: None,
			velocity: None,
			cut_group: None,
		}
	}
}

/// The value of the sample rule: a voice with a sample name and no `sustain` holds (a sustain of 1)
/// instead of the synth's percussive 0.
const SAMPLE_DEFAULT_SUSTAIN: f64 = 1.0;

impl SoundType {
	/// The sound type a name spells (`"sine"`, `"white"`, and so on), or `None` for any other word.
	pub fn from_name(name: &str) -> Option<SoundType> {
		Some(match name {
			"sine" => SoundType::Sine,
			"triangle" => SoundType::Triangle,
			"square" => SoundType::Square,
			"sawtooth" => SoundType::Sawtooth,
			"halfsine" => SoundType::Halfsine,
			"abssine" => SoundType::Abssine,
			"pulsesine" => SoundType::Pulsesine,
			"white" => SoundType::White,
			"pink" => SoundType::Pink,
			"brown" => SoundType::Brown,
			_ => return None,
		})
	}
}

impl FmWave {
	fn from_name(name: &str) -> Option<FmWave> {
		Some(match name {
			"sine" => FmWave::Sine,
			"triangle" => FmWave::Triangle,
			"square" => FmWave::Square,
			"sawtooth" => FmWave::Sawtooth,
			"halfsine" => FmWave::Halfsine,
			"abssine" => FmWave::Abssine,
			"pulsesine" => FmWave::Pulsesine,
			_ => return None,
		})
	}
}

/// Fills a pattern event's control map out to a complete set of voice parameters: the TypeScript's
/// `resolveParams(patch)`, which is `{ ...DEFAULT_PARAMS, ...patch }` plus the sample rule.
///
/// - **Defaults:** the fields [`VoiceParams::empty`] lists. A control the map sets replaces its default.
/// - **`undefined`:** a field the map holds as [`Value::Undefined`] replaces its default with nothing.
///   That is how `.s("bd")` leaves `soundType` unset, and it makes [`VoiceParams::sound_type`] `None`.
/// - **The sample rule:** a voice with a `sampleName` and no `sustain` gets a `sustain` of 1.
/// - **Not parameters:** `degree` and `chord` (a pattern that reaches play time unresolved) and any other
///   key are ignored, as `VoiceParams` has no field for them.
///
/// The reference trusts the shape of what the controls wrote; so does this. A value of the wrong kind
/// (a string for `gainLevel`) cannot come from the control methods, and is read as unset. A word that is
/// not a sound type, which `sound()` and `s()` do not check, leaves `soundType` unset.
///
/// ```
/// use undertone_engine::params::{resolve_params, Pitch, SoundType};
/// use undertone_pattern::control::note;
/// use undertone_pattern::{Fraction, Span};
///
/// let pattern = note("c3 e3")?.gain(0.5)?.lpf(1200.0)?;
/// let haps = pattern.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
/// let params = resolve_params(&haps[0].value);
/// assert_eq!(params.pitch, Some(Pitch::Name("c3".into())));
/// assert_eq!(params.gain_level, 0.5);
/// assert_eq!(params.filter_cutoff, Some(1200.0));
/// assert_eq!(params.sound_type, Some(SoundType::Sine)); // a default
/// assert_eq!(params.attack, 0.01); // a default
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
pub fn resolve_params(patch: &ControlMap) -> VoiceParams {
	let mut params = VoiceParams::empty();
	let num = |key: &str| patch.get(key).and_then(Value::as_number);
	let text = |key: &str| match patch.get(key) {
		Some(Value::Str(s)) => Some(s.as_str()),
		_ => None,
	};
	let list = |key: &str| match patch.get(key) {
		Some(Value::List(items)) => Some(items),
		_ => None,
	};
	let numbers = |key: &str| {
		list(key).map(|items| {
			items
				.iter()
				.map(|v| v.as_number().unwrap_or(f64::NAN))
				.collect::<Vec<f64>>()
		})
	};

	// `soundType` is the one default that a patch can erase on purpose.
	params.sound_type = match patch.get_raw("soundType") {
		None => params.sound_type,
		Some(Value::Str(name)) => SoundType::from_name(name),
		Some(_) => None,
	};
	params.pitch = match patch.get("pitch") {
		Some(Value::Str(name)) => Some(Pitch::Name(name.clone())),
		Some(Value::Num(hz)) => Some(Pitch::Hz(*hz)),
		_ => None,
	};
	params.sample_name = text("sampleName").map(String::from);
	params.sample_bank = text("sampleBank").map(String::from);

	params.gain_level = num("gainLevel").unwrap_or(params.gain_level);
	params.attack = num("attack").unwrap_or(params.attack);
	params.decay = num("decay").unwrap_or(params.decay);
	params.sustain = num("sustain").unwrap_or(params.sustain);
	params.release = num("release").unwrap_or(params.release);
	params.filter_cutoff = num("filterCutoff");
	params.filter_env_amount = num("filterEnvAmount").unwrap_or(params.filter_env_amount);
	params.filter_attack = num("filterAttack").unwrap_or(params.filter_attack);
	params.filter_decay = num("filterDecay").unwrap_or(params.filter_decay);
	params.filter_sustain = num("filterSustain").unwrap_or(params.filter_sustain);
	params.filter_release = num("filterRelease").unwrap_or(params.filter_release);
	params.hpf_cutoff = num("hpfCutoff");
	params.phaser_rate = num("phaserRate");
	params.room_level = num("roomLevel");
	params.room_size = num("roomSize").unwrap_or(params.room_size);
	params.delay_level = num("delayLevel");
	params.delay_time = num("delayTime").unwrap_or(params.delay_time);
	params.delay_feedback = num("delayFeedback").unwrap_or(params.delay_feedback);
	params.orbit = num("orbit");
	params.slide_time = num("slideTime").unwrap_or(params.slide_time);
	params.pitch_env_amount = num("pitchEnvAmount");
	params.pitch_attack = num("pitchAttack");
	params.pitch_decay = num("pitchDecay");
	params.pitch_steps = numbers("pitchSteps");
	params.pitch_step_rate = num("pitchStepRate");
	params.fm_index = num("fmIndex");
	params.fm_harmonicity = num("fmHarmonicity");
	params.fm_attack = num("fmAttack");
	params.fm_decay = num("fmDecay");
	params.fm_sustain = num("fmSustain");
	params.fm_release = num("fmRelease");
	params.fm_env_curve = match text("fmEnvCurve") {
		Some("lin") => Some(FmEnvCurve::Lin),
		Some("exp") => Some(FmEnvCurve::Exp),
		_ => None,
	};
	params.fm_wave = text("fmWave").and_then(FmWave::from_name);
	params.nudge_time = num("nudgeTime").unwrap_or(params.nudge_time);
	params.pan = num("pan");
	params.pan_path = list("panPath").map(|points| {
		points
			.iter()
			.map(|point| PanPoint {
				time: point
					.get("time")
					.and_then(Value::as_number)
					.unwrap_or(f64::NAN),
				pan: point
					.get("pan")
					.and_then(Value::as_number)
					.unwrap_or(f64::NAN),
			})
			.collect()
	});
	params.autopan = num("autopan");
	params.autopan_depth = num("autopanDepth");
	params.autopan_shape = match text("autopanShape") {
		Some("sine") => Some(AutopanShape::Sine),
		Some("triangle") => Some(AutopanShape::Triangle),
		Some("square") => Some(AutopanShape::Square),
		_ => None,
	};
	params.autopan_phase = num("autopanPhase");
	params.pan_slide_from = num("panSlideFrom");
	params.pan_slide_time = num("panSlideTime");
	params.pan_law = num("panLaw");
	params.channel_gains = numbers("channelGains");
	params.duration = num("duration");
	params.legato = num("legato");
	params.velocity = num("velocity");
	params.cut_group = num("cutGroup");

	if params.sample_name.is_some() && patch.get("sustain").is_none() {
		params.sustain = SAMPLE_DEFAULT_SUSTAIN;
	}
	params
}

impl Default for VoiceParams {
	fn default() -> Self {
		Self::empty()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn empty_matches_the_reference_defaults() {
		let p = VoiceParams::empty();
		assert_eq!(p.sound_type, Some(SoundType::Sine));
		assert_eq!(
			(p.gain_level, p.attack, p.decay, p.sustain, p.release),
			(0.8, 0.01, 0.1, 0.0, 0.05)
		);
		assert_eq!(
			(p.room_size, p.delay_time, p.delay_feedback),
			(3.0, 0.3, 0.35)
		);
		assert_eq!(p.filter_sustain, 1.0);
		assert!(p.pitch.is_none() && p.pan.is_none() && p.pan_law.is_none());
	}
}
