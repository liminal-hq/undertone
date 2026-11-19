// Pan-law, pan-path, and speaker-ring gains, with the maths as the reference computes it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The gain maths of placement: the pan law (`panLawGains`, `panLawPath`), the speaker ring
//! (`surroundGains`), and the pan-path events they work on, as `src/panPath.ts` and
//! `src/surround.ts` compute them, generic over the [`Maths`] back-end.

use super::{Maths, js_max, js_min};
use std::f64::consts::{PI, SQRT_2};
use std::fmt;

/// The widest pan step a ramp under a pan law is booked in.
const PAN_LAW_STEP: f64 = 1.0 / 32.0;

/// Whether a pan event jumps to its value or ramps linearly to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanEventKind {
	/// Jump to the value at the event's time.
	Set,
	/// Ramp linearly to the value, arriving at the event's time.
	Ramp,
}

/// One automation step on a panner's `pan` (or on a side's gain, once turned into one).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanEvent {
	/// Whether the step jumps or ramps.
	pub kind: PanEventKind,
	/// The stereo position (`-1..=1`), or a side's gain.
	pub value: f64,
	/// Absolute time on the context's clock, in seconds.
	pub time: f64,
}

/// A point of a pan path: a stereo position at a time offset from the voice's start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanPoint {
	/// Stereo position, `-1..=1` (clamped).
	pub pan: f64,
	/// Seconds after the voice's start.
	pub time: f64,
}

/// The left and right gains of a pan under a pan law.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanGains {
	/// The left side's gain.
	pub left: f64,
	/// The right side's gain.
	pub right: f64,
}

fn clamp_pan(pan: f64) -> f64 {
	js_max(-1.0, js_min(1.0, pan))
}

/// The pan automation for one voice (`buildPanPath`): the first point at the onset, each later
/// point a ramp, or a jump when it shares its time with the point before it.
pub fn build_pan_path(points: &[PanPoint], voice_start: f64) -> Vec<PanEvent> {
	let mut events = Vec::new();
	let mut previous = 0.0_f64;
	for (index, point) in points.iter().enumerate() {
		let offset = js_max(js_max(point.time, previous), 0.0);
		let value = clamp_pan(point.pan);
		if index == 0 {
			events.push(PanEvent {
				kind: PanEventKind::Set,
				value,
				time: voice_start,
			});
			if offset > 0.0 {
				events.push(PanEvent {
					kind: PanEventKind::Set,
					value,
					time: voice_start + offset,
				});
			}
		} else {
			let kind = if offset == previous {
				PanEventKind::Set
			} else {
				PanEventKind::Ramp
			};
			events.push(PanEvent {
				kind,
				value,
				time: voice_start + offset,
			});
		}
		previous = offset;
	}
	events
}

/// The scale `√2 · 10^(law/20)` that puts a pan law's centre at `law` dB (`scale` in the
/// reference's `panLawGains` and `scaleForPanLaw`).
pub fn pan_law_scale<M: Maths>(law: f64) -> f64 {
	SQRT_2 * M::pow(10.0, law / 20.0)
}

/// Each side's gain for a pan under a pan law of `law` dB (`panLawGains`): the equal-power gains
/// `cos` and `sin` of `(pan + 1) · π/4`, scaled by [`pan_law_scale`] and each capped at 1.
pub fn pan_law_gains<M: Maths>(pan: f64, law: f64) -> PanGains {
	let angle = ((clamp_pan(pan) + 1.0) * PI) / 4.0;
	let scale = pan_law_scale::<M>(law);
	PanGains {
		left: js_min(1.0, scale * M::cos(angle)),
		right: js_min(1.0, scale * M::sin(angle)),
	}
}

/// The pans where a law's side gains reach their cap of 1 (`panLawKnees`); empty for laws at or
/// below -3 dB.
fn pan_law_knees<M: Maths>(law: f64) -> Vec<f64> {
	let scale = pan_law_scale::<M>(law);
	if scale.is_nan() || scale <= 1.0 {
		return Vec::new();
	}
	let knee = (4.0 * M::acos(1.0 / scale)) / PI - 1.0;
	vec![knee, -knee]
}

/// A pan path's events as the two side gains of a pan law (`panLawPath`): a step stays a step, a
/// ramp is booked as linear ramps at most 1/32 of a pan apart, with a break where a side reaches
/// its cap. Returns the left and right events.
pub fn pan_law_path<M: Maths>(events: &[PanEvent], law: f64) -> (Vec<PanEvent>, Vec<PanEvent>) {
	let mut left = Vec::new();
	let mut right = Vec::new();
	let mut push = |kind: PanEventKind, pan: f64, time: f64| {
		let gains = pan_law_gains::<M>(pan, law);
		left.push(PanEvent {
			kind,
			value: gains.left,
			time,
		});
		right.push(PanEvent {
			kind,
			value: gains.right,
			time,
		});
	};
	let knees = pan_law_knees::<M>(law);
	for (index, event) in events.iter().enumerate() {
		let before = index.checked_sub(1).map(|i| events[i]);
		let Some(before) = before.filter(|_| event.kind == PanEventKind::Ramp) else {
			push(PanEventKind::Set, event.value, event.time);
			continue;
		};
		let from = before.value;
		let span = event.value - from;
		let steps = js_max(1.0, (span.abs() / PAN_LAW_STEP).ceil());
		// Fractions of the ramp to break at: even steps, and any knee strictly inside it.
		let mut breaks: Vec<f64> = (1..steps as usize)
			.map(|step| step as f64 / steps)
			.collect();
		for knee in &knees {
			let fraction = (knee - from) / span;
			if fraction > 0.0 && fraction < 1.0 && !breaks.contains(&fraction) {
				breaks.push(fraction);
			}
		}
		breaks.sort_by(f64::total_cmp);
		for fraction in breaks {
			push(
				PanEventKind::Ramp,
				from + span * fraction,
				before.time + (event.time - before.time) * fraction,
			);
		}
		push(PanEventKind::Ramp, event.value, event.time);
	}
	(left, right)
}

/// A surround angle that is not a finite number.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NotFinite(pub f64);

impl fmt::Display for NotFinite {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"surround() angle must be a finite number, got {}",
			self.0
		)
	}
}

impl std::error::Error for NotFinite {}

/// Ring speakers (the LFE excluded) as `(channel index, angle in degrees)`, sorted by angle.
const RING: [(usize, f64); 7] = [
	(6, -150.0),
	(4, -90.0),
	(0, -30.0),
	(2, 0.0),
	(1, 30.0),
	(5, 90.0),
	(7, 150.0),
];

/// The 7.1 channel gains (FL, FR, C, LFE, SL, SR, RL, RR) that place a sound at `angle_degrees` on
/// the speaker ring, equal-power between the two nearest speakers (`surroundGains`).
///
/// # Errors
///
/// Returns [`NotFinite`] when the angle is `NaN` or infinite.
pub fn surround_gains<M: Maths>(angle_degrees: f64) -> Result<[f64; 8], NotFinite> {
	if !angle_degrees.is_finite() {
		return Err(NotFinite(angle_degrees));
	}
	// JavaScript's `%` and Rust's `%` on f64 are both the truncated remainder.
	let angle = ((angle_degrees % 360.0) + 540.0) % 360.0 - 180.0;
	let mut gains = [0.0_f64; 8];

	let mut lower = RING[RING.len() - 1];
	let mut lower_angle = lower.1 - 360.0;
	for speaker in RING {
		if speaker.1 <= angle {
			lower = speaker;
			lower_angle = speaker.1;
		}
	}
	let mut upper = RING[0];
	let mut upper_angle = upper.1 + 360.0;
	for speaker in RING.iter().rev() {
		if speaker.1 >= angle {
			upper = *speaker;
			upper_angle = speaker.1;
		}
	}

	if lower.0 == upper.0 {
		gains[lower.0] = 1.0;
		return Ok(gains);
	}

	let t = (angle - lower_angle) / (upper_angle - lower_angle);
	gains[lower.0] = M::cos((t * PI) / 2.0);
	gains[upper.0] = M::sin((t * PI) / 2.0);
	Ok(gains)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::math::Native;

	fn nine(x: f64) -> f64 {
		format!("{x:.8e}").parse().unwrap()
	}

	#[test]
	fn the_centre_lands_on_the_law() {
		let gains = pan_law_gains::<Native>(0.0, -6.0);
		assert_eq!(nine(gains.left), 0.501187234);
		assert_eq!(nine(gains.right), 0.501187234);
	}

	#[test]
	fn a_hard_pan_at_zero_db_caps_at_one() {
		let gains = pan_law_gains::<Native>(1.0, 0.0);
		assert_eq!(gains.right, 1.0);
		assert_eq!(nine(gains.left), 8.65956056e-17);
	}

	#[test]
	fn pans_are_clamped() {
		assert_eq!(
			pan_law_gains::<Native>(5.0, -3.0),
			pan_law_gains::<Native>(1.0, -3.0)
		);
	}

	#[test]
	fn a_pan_path_ramp_becomes_even_steps_under_a_law() {
		let path = build_pan_path(
			&[
				PanPoint {
					pan: -1.0,
					time: 0.0,
				},
				PanPoint {
					pan: 1.0,
					time: 0.4,
				},
			],
			0.0,
		);
		let (left, right) = pan_law_path::<Native>(&path, -6.0);
		assert_eq!(left.len(), 65);
		assert_eq!(right.len(), 65);
		assert_eq!(left[0].kind, PanEventKind::Set);
		assert_eq!(left[64].time, 0.4);
	}

	#[test]
	fn a_ramp_through_a_law_above_minus_three_breaks_at_the_knees() {
		let path = build_pan_path(
			&[
				PanPoint {
					pan: -1.0,
					time: 0.0,
				},
				PanPoint {
					pan: 1.0,
					time: 1.0,
				},
			],
			0.0,
		);
		let (left, _) = pan_law_path::<Native>(&path, 0.0);
		assert!(left.len() > 65);
		assert!(left.windows(2).all(|pair| pair[0].time <= pair[1].time));
	}

	#[test]
	fn surround_gains_are_equal_power_between_neighbours() {
		let gains = surround_gains::<Native>(15.0).unwrap();
		assert!((gains[2].powi(2) + gains[1].powi(2) - 1.0).abs() < 1e-12);
		assert_eq!(gains[3], 0.0);
	}

	#[test]
	fn surround_on_a_speaker_gives_it_full_gain() {
		assert_eq!(surround_gains::<Native>(0.0).unwrap()[2], 1.0);
		assert_eq!(surround_gains::<Native>(-90.0).unwrap()[4], 1.0);
	}

	#[test]
	fn surround_rejects_an_angle_that_is_not_finite() {
		assert_eq!(
			surround_gains::<Native>(f64::NAN).unwrap_err().to_string(),
			"surround() angle must be a finite number, got NaN"
		);
	}
}
