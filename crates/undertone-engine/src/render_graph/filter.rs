// The biquad filter node: the Web Audio filter types as a direct form I section
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Biquad filters. Coefficients are worked out in `f64` for the current `frequency` and `Q` (once per quantum
//! when neither moves, for every frame when either does) and the section runs in direct form I with `f64`
//! state.
//!
//! The band-pass, notch, all-pass, peaking, and shelving types are the audio-EQ-cookbook forms the
//! specification gives (`Q` is linear; the engine has no `gain` or `detune` parameter, so peaking and the
//! shelves have 0 dB gain and pass the signal). The low-pass and high-pass types take `Q` in decibels and use
//! the parameterisation browsers use, in which the decibel value is the height of the resonant peak above the
//! pass band; a `Q` of 0 dB is a Butterworth response (a half-power point at the cutoff). A `Q` below 0 dB is
//! treated as 0 dB.

use crate::graph::FilterType;
use crate::math::{cos, pow, sin};
use crate::render_graph::mix::QUANTUM;

/// Coefficients `[b0, b1, b2, a1, a2]`, with `a0` already divided out.
type Coefficients = [f64; 5];

const PASS: Coefficients = [1.0, 0.0, 0.0, 0.0, 0.0];
const SILENCE: Coefficients = [0.0; 5];

/// The coefficients of `kind` at `hertz` and `q` for a sample rate with Nyquist frequency `nyquist`.
pub(crate) fn coefficients(kind: FilterType, hertz: f64, q: f64, nyquist: f64) -> Coefficients {
	let f = (hertz / nyquist).clamp(0.0, 1.0);
	let f = if f.is_nan() { 0.0 } else { f };
	match kind {
		FilterType::Lowpass | FilterType::Highpass => {
			if f >= 1.0 {
				return if kind == FilterType::Lowpass {
					PASS
				} else {
					SILENCE
				};
			}
			if f <= 0.0 {
				return if kind == FilterType::Lowpass {
					SILENCE
				} else {
					PASS
				};
			}
			let g = pow(10.0, 0.05 * q.max(0.0));
			let d = ((4.0 - (16.0 - 16.0 / (g * g)).max(0.0).sqrt()) / 2.0).sqrt();
			let theta = core::f64::consts::PI * f;
			let sn = 0.5 * d * sin(theta);
			let beta = 0.5 * (1.0 - sn) / (1.0 + sn);
			let gamma = (0.5 + beta) * cos(theta);
			let (b0, b1) = if kind == FilterType::Lowpass {
				let alpha = 0.25 * (0.5 + beta - gamma);
				(2.0 * alpha, 4.0 * alpha)
			} else {
				let alpha = 0.25 * (0.5 + beta + gamma);
				(2.0 * alpha, -4.0 * alpha)
			};
			[b0, b1, b0, -2.0 * gamma, 2.0 * beta]
		}
		FilterType::Bandpass | FilterType::Notch | FilterType::Allpass => {
			if f <= 0.0 || f >= 1.0 {
				return match kind {
					FilterType::Bandpass => SILENCE,
					_ => PASS,
				};
			}
			if q <= 0.0 {
				return match kind {
					FilterType::Bandpass => PASS,
					FilterType::Notch => SILENCE,
					_ => [-1.0, 0.0, 0.0, 0.0, 0.0],
				};
			}
			let w0 = core::f64::consts::PI * f;
			let alpha = sin(w0) / (2.0 * q);
			let k = cos(w0);
			let a0 = 1.0 + alpha;
			let (b0, b1, b2) = match kind {
				FilterType::Bandpass => (alpha, 0.0, -alpha),
				FilterType::Notch => (1.0, -2.0 * k, 1.0),
				_ => (1.0 - alpha, -2.0 * k, 1.0 + alpha),
			};
			[b0 / a0, b1 / a0, b2 / a0, -2.0 * k / a0, (1.0 - alpha) / a0]
		}
		// With no gain parameter the shelves and the peak sit at 0 dB: the amplitude `A` is 1 and they pass.
		FilterType::Peaking | FilterType::Lowshelf | FilterType::Highshelf => PASS,
	}
}

/// The state of one biquad node.
#[derive(Debug, Clone)]
pub(crate) struct Biquad {
	pub(crate) kind: FilterType,
	/// Per channel: the last two inputs and the last two outputs.
	state: Vec<[f64; 4]>,
	last: Option<(f64, f64, Coefficients)>,
}

impl Biquad {
	pub(crate) fn new() -> Self {
		Self {
			kind: FilterType::Lowpass,
			state: Vec::new(),
			last: None,
		}
	}

	/// Gives the filter `channels` channels of state, keeping what it has when the count is unchanged.
	pub(crate) fn resize(&mut self, channels: usize) {
		if self.state.len() != channels {
			self.state = vec![[0.0; 4]; channels];
		}
	}

	/// Whether the state has decayed to nothing, so a silent input can be skipped.
	pub(crate) fn settled(&self) -> bool {
		self.state.iter().all(|s| s.iter().all(|v| *v == 0.0))
	}

	/// Filters one quantum of `channels` planar channels. `frequency` and `q` hold a value for every frame;
	/// `steady` says that neither changes over the quantum.
	#[allow(clippy::too_many_arguments)]
	pub(crate) fn process(
		&mut self,
		input: &[f32],
		out: &mut [f32],
		channels: usize,
		frequency: &[f64],
		q: &[f64],
		steady: bool,
		nyquist: f64,
	) {
		for i in 0..QUANTUM {
			let (hertz, quality) = if steady {
				(frequency[0], q[0])
			} else {
				(frequency[i], q[i])
			};
			let [b0, b1, b2, a1, a2] = match self.last {
				Some((f, k, c)) if f == hertz && k == quality => c,
				_ => {
					let c = coefficients(self.kind, hertz, quality, nyquist);
					self.last = Some((hertz, quality, c));
					c
				}
			};
			for (channel, s) in self.state.iter_mut().enumerate().take(channels) {
				let x = f64::from(input[channel * QUANTUM + i]);
				let y = b0 * x + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
				*s = [x, s[0], y, s[2]];
				out[channel * QUANTUM + i] = y as f32;
			}
		}
		// Let a state that has decayed to nothing become exactly nothing, so a silent node can be skipped.
		for s in &mut self.state {
			if s.iter().all(|v| v.abs() < 1e-24) {
				*s = [0.0; 4];
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The magnitude of the response at `hertz`, from the coefficients.
	fn magnitude(c: Coefficients, hertz: f64, rate: f64) -> f64 {
		let w = 2.0 * core::f64::consts::PI * hertz / rate;
		let (c1, s1, c2, s2) = (cos(w), sin(w), cos(2.0 * w), sin(2.0 * w));
		let num = (c[0] + c[1] * c1 + c[2] * c2, -(c[1] * s1 + c[2] * s2));
		let den = (1.0 + c[3] * c1 + c[4] * c2, -(c[3] * s1 + c[4] * s2));
		((num.0 * num.0 + num.1 * num.1) / (den.0 * den.0 + den.1 * den.1)).sqrt()
	}

	fn decibels(x: f64) -> f64 {
		20.0 * x.log10()
	}

	#[test]
	fn a_butterworth_lowpass_is_3_db_down_at_the_cutoff() {
		let c = coefficients(FilterType::Lowpass, 1_000.0, 0.0, 24_000.0);
		assert!((decibels(magnitude(c, 1_000.0, 48_000.0)) + 3.0103).abs() < 1e-3);
		assert!(decibels(magnitude(c, 10.0, 48_000.0)).abs() < 1e-3);
	}

	#[test]
	fn a_lowpass_falls_12_db_an_octave_above_the_cutoff() {
		let c = coefficients(FilterType::Lowpass, 250.0, 0.0, 24_000.0);
		let at = |hertz: f64| decibels(magnitude(c, hertz, 48_000.0));
		let slope = at(2_000.0) - at(4_000.0);
		assert!((slope - 12.0).abs() < 0.5, "{slope}");
	}

	#[test]
	fn the_resonance_is_the_height_of_the_peak() {
		let c = coefficients(FilterType::Lowpass, 2_000.0, 12.0, 24_000.0);
		let peak = (1..200)
			.map(|k| decibels(magnitude(c, f64::from(k) * 20.0, 48_000.0)))
			.fold(f64::MIN, f64::max);
		assert!((peak - 12.0).abs() < 0.6, "{peak}");
	}

	#[test]
	fn a_highpass_mirrors_the_lowpass() {
		let c = coefficients(FilterType::Highpass, 1_000.0, 0.0, 24_000.0);
		assert!((decibels(magnitude(c, 1_000.0, 48_000.0)) + 3.0103).abs() < 1e-3);
		assert!(decibels(magnitude(c, 23_000.0, 48_000.0)).abs() < 0.05);
		assert!(decibels(magnitude(c, 50.0, 48_000.0)) < -50.0);
	}

	#[test]
	fn a_bandpass_peaks_at_unity_at_its_centre() {
		let c = coefficients(FilterType::Bandpass, 3_000.0, 4.0, 24_000.0);
		assert!((magnitude(c, 3_000.0, 48_000.0) - 1.0).abs() < 1e-6);
		assert!(magnitude(c, 300.0, 48_000.0) < 0.2);
	}

	#[test]
	fn a_notch_removes_its_centre_and_an_allpass_keeps_every_level() {
		let notch = coefficients(FilterType::Notch, 3_000.0, 4.0, 24_000.0);
		assert!(magnitude(notch, 3_000.0, 48_000.0) < 1e-6);
		assert!((magnitude(notch, 100.0, 48_000.0) - 1.0).abs() < 0.01);
		let all = coefficients(FilterType::Allpass, 3_000.0, 4.0, 24_000.0);
		for hertz in [50.0, 3_000.0, 12_000.0] {
			assert!((magnitude(all, hertz, 48_000.0) - 1.0).abs() < 1e-9);
		}
	}

	#[test]
	fn the_edges_follow_web_audio() {
		assert_eq!(
			coefficients(FilterType::Lowpass, 30_000.0, 1.0, 24_000.0),
			PASS
		);
		assert_eq!(
			coefficients(FilterType::Lowpass, 0.0, 1.0, 24_000.0),
			SILENCE
		);
		assert_eq!(coefficients(FilterType::Highpass, 0.0, 1.0, 24_000.0), PASS);
		assert_eq!(
			coefficients(FilterType::Peaking, 1_000.0, 1.0, 24_000.0),
			PASS
		);
	}

	#[test]
	fn processing_a_sine_attenuates_by_the_response() {
		let rate = 48_000.0;
		let mut filter = Biquad::new();
		filter.resize(1);
		let hertz = 4_000.0;
		let mut energy_in = 0.0;
		let mut energy_out = 0.0;
		let mut phase = 0.0_f64;
		for quantum in 0..200 {
			let mut input = vec![0.0_f32; QUANTUM];
			for sample in &mut input {
				*sample = sin(phase) as f32;
				phase += 2.0 * core::f64::consts::PI * hertz / rate;
			}
			let mut out = vec![0.0_f32; QUANTUM];
			filter.process(
				&input,
				&mut out,
				1,
				&[1_000.0; QUANTUM],
				&[0.0; QUANTUM],
				true,
				rate / 2.0,
			);
			if quantum > 20 {
				energy_in += input.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
				energy_out += out.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
			}
		}
		let measured = 10.0 * (energy_out / energy_in).log10();
		let c = coefficients(FilterType::Lowpass, 1_000.0, 0.0, 24_000.0);
		let expected = decibels(magnitude(c, hertz, rate));
		assert!(
			(measured - expected).abs() < 0.05,
			"{measured} vs {expected}"
		);
		// Two octaves above a 1 kHz Butterworth: about -24 dB.
		assert!((measured + 24.0).abs() < 1.0, "{measured}");
	}

	#[test]
	fn a_decayed_state_becomes_exactly_silent() {
		let mut filter = Biquad::new();
		filter.resize(1);
		let mut input = vec![0.0_f32; QUANTUM];
		input[0] = 1.0;
		let mut out = vec![0.0_f32; QUANTUM];
		filter.process(
			&input,
			&mut out,
			1,
			&[200.0; QUANTUM],
			&[0.0; QUANTUM],
			true,
			24_000.0,
		);
		assert!(!filter.settled());
		input[0] = 0.0;
		for _ in 0..400 {
			filter.process(
				&input,
				&mut out,
				1,
				&[200.0; QUANTUM],
				&[0.0; QUANTUM],
				true,
				24_000.0,
			);
		}
		assert!(filter.settled());
	}

	#[test]
	fn changing_the_type_between_quanta_replaces_the_cached_coefficients() {
		// A low-pass at 0 Hz is silence; the same frequency and Q as a high-pass must pass the signal.
		let mut filter = Biquad::new();
		filter.resize(1);
		let input = [1.0_f32; QUANTUM];
		let mut out = [0.0_f32; QUANTUM];
		let (frequency, q) = ([0.0; QUANTUM], [0.0; QUANTUM]);
		filter.process(&input, &mut out, 1, &frequency, &q, true, 24_000.0);
		assert!(out.iter().all(|v| *v == 0.0));
		filter.kind = FilterType::Highpass;
		filter.process(&input, &mut out, 1, &frequency, &q, true, 24_000.0);
		assert_eq!(out[QUANTUM - 1], 1.0);
	}
}
