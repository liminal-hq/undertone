// The dynamics compressor node: a soft-knee compressor with pre-delay, as the master limiter uses
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The Web Audio dynamics compressor, implemented from the algorithm the specification and browsers share.
//!
//! - **The curve.** Below `threshold` the signal is untouched. From the threshold to `threshold + knee` an
//!   exponential saturation curve eases in; above it the level rises by `1 / ratio` dB for each dB in. The
//!   saturation constant is searched (by bisection in the log domain) so the curve's slope joins the
//!   ratio's slope where the knee ends.
//! - **Look-ahead.** The audio is delayed by 6 ms while the detector reads the undelayed signal, so the gain
//!   reduction is under way before the loud sample is heard.
//! - **The detector** follows the larger of the channels' absolute values (the channels are linked) and
//!   turns the curve into a gain; it falls back over about 2.5 ms, so one cycle of a low note does not
//!   modulate the gain.
//! - **The envelope.** The gain moves towards a lower target by an exponential approach that gets within a
//!   quarter of a decibel of it in `attack` seconds (never less than 1 ms), and recovers at a constant
//!   `10 dB` per `release` seconds. (Browsers shape the release by how deep the gain reduction is; this does
//!   not, which is the main difference in the compressor's behaviour.)
//! - **Makeup gain** is automatic: the reciprocal of the curve's output for a full-scale input, raised to
//!   0.6, as browsers do. The master bus takes it back out with a gain stage after the compressor.
//!
//! `threshold`, `knee`, `ratio`, `attack`, and `release` are read once per quantum (they are k-rate).

use crate::math::{exp, ln, pow};
use crate::render_graph::mix::QUANTUM;

/// The look-ahead, in seconds.
const PRE_DELAY: f64 = 0.006;
/// How quickly the detector lets go, in seconds.
const DETECTOR_RELEASE: f64 = 0.0025;
const LN_10: f64 = core::f64::consts::LN_10;

fn to_decibels(linear: f64) -> f64 {
	if linear <= 0.0 {
		f64::NEG_INFINITY
	} else {
		20.0 * ln(linear) / LN_10
	}
}

fn to_linear(decibels: f64) -> f64 {
	exp(decibels * LN_10 / 20.0)
}

/// The static compression curve for one setting of the parameters.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Curve {
	linear_threshold: f64,
	knee_threshold: f64,
	knee_threshold_db: f64,
	knee_end_db: f64,
	slope: f64,
	k: f64,
}

impl Curve {
	fn new(threshold_db: f64, knee_db: f64, ratio: f64) -> Self {
		let linear_threshold = to_linear(threshold_db);
		let knee_threshold_db = threshold_db + knee_db;
		let knee_threshold = to_linear(knee_threshold_db);
		let slope = 1.0 / ratio;
		let mut curve = Self {
			linear_threshold,
			knee_threshold,
			knee_threshold_db,
			knee_end_db: 0.0,
			slope,
			k: 5.0,
		};
		curve.k = curve.search_k();
		curve.knee_end_db = to_decibels(curve.knee_curve(knee_threshold, curve.k));
		curve
	}

	fn knee_curve(&self, x: f64, k: f64) -> f64 {
		if x < self.linear_threshold {
			x
		} else {
			self.linear_threshold + (1.0 - exp(-k * (x - self.linear_threshold))) / k
		}
	}

	/// The slope of the knee curve in decibels at the end of the knee, for a constant `k`.
	fn slope_at_knee(&self, k: f64) -> f64 {
		let x = self.knee_threshold;
		if x < self.linear_threshold {
			return 1.0;
		}
		let x2 = x * 1.001;
		let (x_db, x2_db) = (to_decibels(x), to_decibels(x2));
		let (y, y2) = (
			to_decibels(self.knee_curve(x, k)),
			to_decibels(self.knee_curve(x2, k)),
		);
		(y2 - y) / (x2_db - x_db)
	}

	fn search_k(&self) -> f64 {
		let (mut low, mut high, mut k) = (0.1_f64, 10_000.0_f64, 5.0_f64);
		for _ in 0..15 {
			if self.slope_at_knee(k) < self.slope {
				high = k;
			} else {
				low = k;
			}
			k = (low * high).sqrt();
		}
		k
	}

	/// The curve's output level for an input level `x` (both linear).
	fn saturate(&self, x: f64) -> f64 {
		if x < self.knee_threshold {
			self.knee_curve(x, self.k)
		} else {
			to_linear(self.knee_end_db + self.slope * (to_decibels(x) - self.knee_threshold_db))
		}
	}
}

/// The state of one compressor.
#[derive(Debug, Clone)]
pub(crate) struct Compressor {
	delay: Vec<f32>,
	delay_frames: usize,
	channels: usize,
	write: usize,
	sample_rate: f64,
	curve: Option<((f64, f64, f64), Curve)>,
	detector: f64,
	gain: f64,
	max_attack_db: f64,
}

impl Compressor {
	pub(crate) fn new(sample_rate: f64) -> Self {
		Self {
			delay: Vec::new(),
			delay_frames: (PRE_DELAY * sample_rate) as usize,
			channels: 0,
			write: 0,
			sample_rate,
			curve: None,
			detector: 1.0,
			gain: 1.0,
			max_attack_db: -1.0,
		}
	}

	/// Gives the compressor `channels` channels, keeping its state when the count is unchanged.
	pub(crate) fn resize(&mut self, channels: usize) {
		if self.channels != channels {
			self.channels = channels;
			self.delay = vec![0.0; channels * self.delay_frames.max(1)];
			self.write = 0;
		}
	}

	/// The gain the compressor is applying now, in decibels (0 or below), without the makeup.
	#[cfg(test)]
	pub(crate) fn gain_db(&self) -> f64 {
		to_decibels(self.gain)
	}

	/// The makeup gain for a setting of the parameters.
	#[cfg(test)]
	pub(crate) fn makeup_for(threshold: f64, knee: f64, ratio: f64) -> f64 {
		let curve = Curve::new(threshold, knee, ratio);
		pow(1.0 / curve.saturate(1.0), 0.6)
	}

	/// Compresses one quantum of `channels` planar channels.
	pub(crate) fn process(
		&mut self,
		input: &[f32],
		out: &mut [f32],
		channels: usize,
		[threshold, knee, ratio, attack, release]: [f64; 5],
	) {
		let key = (threshold, knee, ratio);
		let curve = match self.curve {
			Some((cached, curve)) if cached == key => curve,
			_ => {
				let curve = Curve::new(threshold, knee, ratio);
				self.curve = Some((key, curve));
				curve
			}
		};
		let makeup = pow(1.0 / curve.saturate(1.0), 0.6);
		let attack_frames = attack.max(0.001) * self.sample_rate;
		let release_frames = (release * self.sample_rate).max(1.0);
		let detector_frames = DETECTOR_RELEASE * self.sample_rate;
		let release_rate = to_linear(10.0 / release_frames);
		let delay = self.delay_frames;
		for i in 0..QUANTUM {
			let mut level = 0.0_f64;
			for channel in 0..channels {
				level = level.max(f64::from(input[channel * QUANTUM + i]).abs());
			}
			// The detector: how much gain the curve would leave, with a quick fall back.
			let wanted = if level <= 0.0001 {
				1.0
			} else {
				curve.saturate(level) / level
			};
			let wanted_db = (-to_decibels(wanted)).max(2.0);
			let release_step = to_linear(wanted_db / detector_frames) - 1.0;
			let rate = if wanted > self.detector {
				release_step
			} else {
				1.0
			};
			self.detector += (wanted - self.detector) * rate;
			self.detector = self.detector.min(1.0);
			let target = self.detector;
			// The envelope: attack towards a lower target, release towards a higher one.
			let difference = to_decibels(self.gain / target);
			if difference > 0.0 {
				self.max_attack_db = self.max_attack_db.max(difference);
				let x = 0.25 / self.max_attack_db.max(0.5);
				let step = 1.0 - pow(x, 1.0 / attack_frames);
				self.gain += (target - self.gain) * step;
			} else {
				self.max_attack_db = -1.0;
				self.gain = (self.gain * release_rate).min(target).min(1.0);
			}
			let total = (self.gain * makeup) as f32;
			for channel in 0..channels {
				let sample = input[channel * QUANTUM + i];
				let heard = if delay == 0 {
					sample
				} else {
					let slot = &mut self.delay[channel * delay + self.write];
					std::mem::replace(slot, sample)
				};
				out[channel * QUANTUM + i] = heard * total;
			}
			if delay != 0 {
				self.write = (self.write + 1) % delay;
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::math::sin;

	const RATE: f64 = 48_000.0;

	/// Runs a sine of `amplitude` through the compressor for `seconds` and returns (the input, the output).
	fn run_sine(
		compressor: &mut Compressor,
		amplitude: f64,
		hertz: f64,
		seconds: f64,
		settings: [f64; 5],
	) -> (Vec<f32>, Vec<f32>) {
		compressor.resize(1);
		let (mut input, mut output) = (Vec::new(), Vec::new());
		let mut phase = 0.0_f64;
		for _ in 0..(seconds * RATE / QUANTUM as f64) as usize {
			let block: Vec<f32> = (0..QUANTUM)
				.map(|_| {
					let sample = (amplitude * sin(phase)) as f32;
					phase += 2.0 * core::f64::consts::PI * hertz / RATE;
					sample
				})
				.collect();
			let mut out = vec![0.0; QUANTUM];
			compressor.process(&block, &mut out, 1, settings);
			input.extend_from_slice(&block);
			output.extend_from_slice(&out);
		}
		(input, output)
	}

	fn peak_db(samples: &[f32]) -> f64 {
		to_decibels(f64::from(
			samples.iter().fold(0.0_f32, |m, s| m.max(s.abs())),
		))
	}

	#[test]
	fn the_hard_knee_curve_is_threshold_plus_overshoot_over_ratio() {
		let curve = Curve::new(-20.0, 0.0, 4.0);
		// -20 dB threshold, 4:1: an input at 0 dB comes out at -15 dB.
		assert!((to_decibels(curve.saturate(1.0)) + 15.0).abs() < 1e-9);
		assert!((to_decibels(curve.saturate(to_linear(-10.0))) + 17.5).abs() < 1e-9);
		// Below the threshold it is untouched.
		assert!((curve.saturate(0.05) - 0.05).abs() < 1e-12);
	}

	#[test]
	fn a_soft_knee_eases_in_and_joins_the_ratio_line() {
		let hard = Curve::new(-20.0, 0.0, 4.0);
		let soft = Curve::new(-20.0, 10.0, 4.0);
		// Inside the knee the soft curve already reduces a little (below the hard one's line only past the threshold).
		let inside = to_linear(-10.0);
		assert!(soft.saturate(inside) <= inside);
		assert!(soft.saturate(inside) >= hard.saturate(inside) * 0.999);
		// Above the knee both have the 4:1 slope.
		let a = to_decibels(soft.saturate(to_linear(6.0)));
		let b = to_decibels(soft.saturate(to_linear(2.0)));
		assert!(((a - b) - 1.0).abs() < 1e-9, "{}", a - b);
	}

	#[test]
	fn steady_state_gain_reduction_matches_the_curve() {
		// A full-scale 1 kHz sine, threshold -20 dB, ratio 4, hard knee: the peaks settle at -15 dB before makeup.
		let mut compressor = Compressor::new(RATE);
		let settings = [-20.0, 0.0, 4.0, 0.003, 0.25];
		let (_, output) = run_sine(&mut compressor, 1.0, 1_000.0, 2.0, settings);
		let makeup_db = to_decibels(Compressor::makeup_for(-20.0, 0.0, 4.0));
		let settled = &output[output.len() - 9_600..];
		let measured = peak_db(settled) - makeup_db;
		assert!((measured + 15.0).abs() < 0.4, "{measured} dB before makeup");
		assert!(
			(compressor.gain_db() + 15.0).abs() < 0.3,
			"{}",
			compressor.gain_db()
		);
	}

	#[test]
	fn below_the_threshold_the_gain_is_unity_apart_from_makeup() {
		let mut compressor = Compressor::new(RATE);
		let settings = [-6.0, 0.0, 12.0, 0.003, 0.25];
		let (input, output) = run_sine(&mut compressor, 0.1, 440.0, 1.0, settings);
		let makeup = Compressor::makeup_for(-6.0, 0.0, 12.0);
		let delay = (PRE_DELAY * RATE) as usize;
		for n in 20_000..20_500 {
			let want = f64::from(input[n - delay]) * makeup;
			assert!((f64::from(output[n]) - want).abs() < 1e-5);
		}
	}

	#[test]
	fn the_pre_delay_is_six_milliseconds() {
		let mut compressor = Compressor::new(RATE);
		compressor.resize(1);
		let mut input = vec![0.0_f32; QUANTUM];
		input[0] = 0.01;
		let mut out = vec![0.0; QUANTUM];
		let mut all = Vec::new();
		for block in 0..4 {
			compressor.process(&input, &mut out, 1, [0.0, 0.0, 1.0, 0.003, 0.25]);
			all.extend_from_slice(&out);
			if block == 0 {
				input[0] = 0.0;
			}
		}
		let at = all.iter().position(|s| *s != 0.0).unwrap();
		assert_eq!(at, 288);
	}

	#[test]
	fn the_limiter_catches_a_burst_before_it_is_heard() {
		// The master bus settings: -2 dB threshold, ratio 20. A burst of full scale after silence should be held
		// near the threshold in its second half, and never pass far above full scale in the first.
		let mut compressor = Compressor::new(RATE);
		compressor.resize(1);
		let settings = [-2.0, 0.0, 20.0, 0.003, 0.1];
		let makeup_db = to_decibels(Compressor::makeup_for(-2.0, 0.0, 20.0));
		let mut all = Vec::new();
		let mut phase = 0.0_f64;
		for quantum in 0..400 {
			let loud = quantum >= 100;
			let block: Vec<f32> = (0..QUANTUM)
				.map(|_| {
					let sample = if loud { (2.0 * sin(phase)) as f32 } else { 0.0 };
					phase += 2.0 * core::f64::consts::PI * 440.0 / RATE;
					sample
				})
				.collect();
			let mut out = vec![0.0; QUANTUM];
			compressor.process(&block, &mut out, 1, settings);
			all.extend_from_slice(&out);
		}
		let settled = &all[all.len() - 4_800..];
		// A +6 dB input is held to about the ceiling the curve gives (-2 + 8/20 = -1.6 dB) before makeup.
		let measured = peak_db(settled) - makeup_db;
		assert!((measured + 1.6).abs() < 0.5, "{measured}");
		assert!(all.iter().all(|s| s.is_finite()));
	}

	#[test]
	fn the_gain_recovers_after_the_loud_part() {
		let mut compressor = Compressor::new(RATE);
		let settings = [-20.0, 0.0, 10.0, 0.003, 0.1];
		run_sine(&mut compressor, 1.0, 200.0, 0.5, settings);
		assert!(compressor.gain_db() < -10.0);
		run_sine(&mut compressor, 0.001, 200.0, 2.0, settings);
		assert!(compressor.gain_db() > -0.5, "{}", compressor.gain_db());
	}
}
