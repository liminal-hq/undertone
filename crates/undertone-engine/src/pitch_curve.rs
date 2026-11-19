// A voice's frequency automation (slide, pitch envelope, or steps) as ratios of its base pitch
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The pitch curve of a voice (`src/pitchCurve.ts`).
//!
//! The curve is a list of [`CurveEvent`]s relative to the base pitch, so the same curve drives the carrier
//! and anything that tracks it (an FM modulator at a multiple of the pitch) by scaling the ratios.
//! Priority when several are set: stepped `pitchSteps`, then the `pitchEnvAmount` envelope, then `slideTime`.
//! Combining them is unsupported and gives a warning once.

use crate::graph::{Graph, ParamId};
use crate::math::js_pow;
use crate::params::VoiceParams;
use crate::warn::Warnings;

/// Whether a curve event jumps to its ratio or ramps exponentially to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurveKind {
	/// `setValueAtTime`.
	Set,
	/// `exponentialRampToValueAtTime`.
	Ramp,
}

/// One automation step: jump to (`Set`) or exponentially ramp to (`Ramp`) `ratio` times the base pitch at `time`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurveEvent {
	/// Jump or ramp.
	pub kind: CurveKind,
	/// Multiplier on the base frequency; 1 is the note itself, 2 an octave above.
	pub ratio: f64,
	/// Absolute time on the graph's clock, in seconds.
	pub time: f64,
}

const SLIDE_START_RATIO: f64 = 2.0; // an octave above the target: a percussive downward "thunk"
const DEFAULT_PITCH_DECAY_SECONDS: f64 = 0.1;
const DEFAULT_PITCH_STEP_RATE_HZ: f64 = 140.0; // the frame rate of classic AdLib sound effects

fn semitones_to_ratio(semitones: f64) -> f64 {
	js_pow(2.0, semitones / 12.0)
}

/// The frequency automation for one voice, relative to its base pitch (`buildPitchCurve`).
pub fn build_pitch_curve(
	params: &VoiceParams,
	voice_start: f64,
	warnings: &mut Warnings,
) -> Vec<CurveEvent> {
	let steps = params.pitch_steps.as_deref().filter(|s| !s.is_empty());
	let has_envelope = params.pitch_env_amount.is_some_and(|amount| amount != 0.0);
	let has_slide = params.slide_time > 0.0;

	if u8::from(steps.is_some()) + u8::from(has_envelope) + u8::from(has_slide) > 1 {
		warnings.once(
			"pitch-curve-combined",
			"undertone: pitchsteps(), penv() and slide() overlap \u{2014} only one applies (steps, then penv, then slide).",
		);
	}

	if let Some(steps) = steps {
		let rate = params.pitch_step_rate.unwrap_or(DEFAULT_PITCH_STEP_RATE_HZ);
		return steps
			.iter()
			.enumerate()
			.map(|(frame, semitones)| CurveEvent {
				kind: CurveKind::Set,
				ratio: semitones_to_ratio(*semitones),
				time: voice_start + frame as f64 / rate,
			})
			.collect();
	}

	if has_envelope {
		let peak = semitones_to_ratio(params.pitch_env_amount.unwrap_or(0.0));
		let attack = params.pitch_attack.unwrap_or(0.0);
		let decay = params.pitch_decay.unwrap_or(DEFAULT_PITCH_DECAY_SECONDS);
		let mut events = Vec::new();
		if attack > 0.0 {
			events.push(CurveEvent {
				kind: CurveKind::Set,
				ratio: 1.0,
				time: voice_start,
			});
			events.push(CurveEvent {
				kind: CurveKind::Ramp,
				ratio: peak,
				time: voice_start + attack,
			});
		} else {
			events.push(CurveEvent {
				kind: CurveKind::Set,
				ratio: peak,
				time: voice_start,
			});
		}
		events.push(if decay > 0.0 {
			CurveEvent {
				kind: CurveKind::Ramp,
				ratio: 1.0,
				time: voice_start + attack + decay,
			}
		} else {
			CurveEvent {
				kind: CurveKind::Set,
				ratio: 1.0,
				time: voice_start + attack,
			}
		});
		return events;
	}

	if has_slide {
		return vec![
			CurveEvent {
				kind: CurveKind::Set,
				ratio: SLIDE_START_RATIO,
				time: voice_start,
			},
			CurveEvent {
				kind: CurveKind::Ramp,
				ratio: 1.0,
				time: voice_start + params.slide_time,
			},
		];
	}

	vec![CurveEvent {
		kind: CurveKind::Set,
		ratio: 1.0,
		time: voice_start,
	}]
}

/// Writes `events` onto `param`, with every ratio multiplied by `base` (the pitch, or a multiple of it).
pub fn apply_pitch_curve<G: Graph>(
	graph: &mut G,
	param: ParamId,
	base: f64,
	events: &[CurveEvent],
) {
	for event in events {
		match event.kind {
			CurveKind::Set => graph.set_value_at_time(param, base * event.ratio, event.time),
			CurveKind::Ramp => {
				graph.exponential_ramp_to_value_at_time(param, base * event.ratio, event.time);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn no_controls_is_a_single_set_at_the_note() {
		let curve = build_pitch_curve(&VoiceParams::empty(), 1.5, &mut Warnings::default());
		assert_eq!(
			curve,
			[CurveEvent {
				kind: CurveKind::Set,
				ratio: 1.0,
				time: 1.5
			}]
		);
	}

	#[test]
	fn a_slide_starts_an_octave_up() {
		let params = VoiceParams {
			slide_time: 0.2,
			..VoiceParams::empty()
		};
		let curve = build_pitch_curve(&params, 0.0, &mut Warnings::default());
		assert_eq!(
			(curve[0].ratio, curve[1].kind, curve[1].time),
			(2.0, CurveKind::Ramp, 0.2)
		);
	}

	#[test]
	fn overlapping_controls_warn_once_and_steps_win() {
		let params = VoiceParams {
			slide_time: 0.2,
			pitch_steps: Some(vec![0.0, 12.0]),
			..VoiceParams::empty()
		};
		let mut warnings = Warnings::default();
		let curve = build_pitch_curve(&params, 0.0, &mut warnings);
		build_pitch_curve(&params, 0.0, &mut warnings);
		assert_eq!(curve.len(), 2);
		assert_eq!(curve[1].ratio, 2.0);
		assert_eq!(warnings.all().len(), 1);
	}
}
