// The wave shaper node: a transfer curve with optional oversampling
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A wave shaper maps each sample through a curve: the curve's `N` points are spread evenly over input `-1` to
//! `1`, values between them are linearly interpolated, and an input past either end takes the end value. With
//! no curve the signal passes unchanged.
//!
//! With `2x` or `4x` oversampling the signal is upsampled with a windowed-sinc low-pass filter, shaped at the
//! higher rate, filtered again, and decimated, which keeps the shaper's harmonics from folding back. The two
//! filters are linear phase and add 16 frames of latency in all (a browser's may differ).

use crate::graph::Oversample;
use crate::math::{cos, sin};
use crate::render_graph::mix::QUANTUM;

/// The curve at `x`, for a curve of at least one point.
fn shape(curve: &[f32], x: f32) -> f32 {
	let last = curve.len() - 1;
	let position = (last as f64 / 2.0) * (f64::from(x) + 1.0);
	if position.is_nan() || position <= 0.0 {
		return curve[0];
	}
	if position >= last as f64 {
		return curve[last];
	}
	let index = position as usize;
	let fraction = position - index as f64;
	((1.0 - fraction) * f64::from(curve[index]) + fraction * f64::from(curve[index + 1])) as f32
}

/// The state of one wave shaper.
#[derive(Debug, Clone)]
pub(crate) struct Shaper {
	curve: Option<Vec<f32>>,
	oversample: Oversample,
	factor: usize,
	filter: Vec<f64>,
	/// Per channel: the history of the upsampling and the decimating filters.
	up: Vec<Vec<f64>>,
	down: Vec<Vec<f64>>,
}

impl Shaper {
	pub(crate) fn new() -> Self {
		Self {
			curve: None,
			oversample: Oversample::None,
			factor: 1,
			filter: Vec::new(),
			up: Vec::new(),
			down: Vec::new(),
		}
	}

	pub(crate) fn set_curve(&mut self, curve: Option<Vec<f32>>) {
		self.curve = curve.filter(|c| !c.is_empty());
	}

	pub(crate) fn set_oversample(&mut self, oversample: Oversample) {
		self.oversample = oversample;
		self.factor = match oversample {
			Oversample::None => 1,
			Oversample::X2 => 2,
			Oversample::X4 => 4,
		};
		// A windowed-sinc low-pass at the original Nyquist frequency, with unity gain at DC.
		self.filter.clear();
		if self.factor > 1 {
			let half = 8 * self.factor;
			let cutoff = 0.5 / self.factor as f64;
			for n in 0..=2 * half {
				let t = n as f64 - half as f64;
				let sinc = if t == 0.0 {
					2.0 * cutoff
				} else {
					sin(2.0 * core::f64::consts::PI * cutoff * t) / (core::f64::consts::PI * t)
				};
				let window =
					0.5 - 0.5 * cos(2.0 * core::f64::consts::PI * n as f64 / (2 * half) as f64);
				self.filter.push(sinc * window);
			}
			let total: f64 = self.filter.iter().sum();
			for tap in &mut self.filter {
				*tap /= total;
			}
		}
		self.up.clear();
		self.down.clear();
	}

	/// Gives the shaper `channels` channels of filter history.
	pub(crate) fn resize(&mut self, channels: usize) {
		if self.factor > 1 && self.up.len() != channels {
			self.up = vec![vec![0.0; self.filter.len()]; channels];
			self.down = vec![vec![0.0; self.filter.len()]; channels];
		}
	}

	/// Shapes one quantum of `channels` planar channels.
	pub(crate) fn process(&mut self, input: &[f32], out: &mut [f32], channels: usize) {
		let Some(curve) = &self.curve else {
			out[..channels * QUANTUM].copy_from_slice(&input[..channels * QUANTUM]);
			return;
		};
		if self.factor == 1 {
			for (o, i) in out[..channels * QUANTUM].iter_mut().zip(input) {
				*o = shape(curve, *i);
			}
			return;
		}
		let factor = self.factor;
		for channel in 0..channels {
			let (up, down) = (&mut self.up[channel], &mut self.down[channel]);
			for i in 0..QUANTUM {
				let x = f64::from(input[channel * QUANTUM + i]);
				let mut low = 0.0;
				for phase in 0..factor {
					up.rotate_right(1);
					up[0] = if phase == 0 { x * factor as f64 } else { 0.0 };
					let high: f64 = self.filter.iter().zip(up.iter()).map(|(h, v)| h * v).sum();
					let shaped = shape(curve, high as f32);
					down.rotate_right(1);
					down[0] = f64::from(shaped);
					if phase == 0 {
						// Keep every `factor`th sample, the one on the original sample's own time.
						low = self
							.filter
							.iter()
							.zip(down.iter())
							.map(|(h, v)| h * v)
							.sum();
					}
				}
				out[channel * QUANTUM + i] = low as f32;
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn run(shaper: &mut Shaper, samples: &[f32]) -> Vec<f32> {
		shaper.resize(1);
		let mut all = Vec::new();
		for chunk in samples.chunks(QUANTUM) {
			let mut input = vec![0.0; QUANTUM];
			input[..chunk.len()].copy_from_slice(chunk);
			let mut out = vec![0.0; QUANTUM];
			shaper.process(&input, &mut out, 1);
			all.extend_from_slice(&out[..chunk.len()]);
		}
		all
	}

	#[test]
	fn no_curve_passes_the_signal() {
		let mut shaper = Shaper::new();
		assert_eq!(run(&mut shaper, &[0.5, -0.25, 3.0]), [0.5, -0.25, 3.0]);
	}

	#[test]
	fn the_curve_is_interpolated_and_held_past_its_ends() {
		let mut shaper = Shaper::new();
		shaper.set_curve(Some(vec![-1.0, 0.0, 0.5]));
		let out = run(&mut shaper, &[-2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 9.0]);
		assert_eq!(out, [-1.0, -1.0, -0.5, 0.0, 0.25, 0.5, 0.5]);
	}

	#[test]
	fn a_clip_curve_never_passes_its_ceiling() {
		let mut shaper = Shaper::new();
		let top = 0.5_f32;
		let curve: Vec<f32> = (0..4097)
			.map(|i| (2.0 * i as f32 / 4096.0 - 1.0).clamp(-top, top))
			.collect();
		shaper.set_curve(Some(curve));
		let samples: Vec<f32> = (0..1000).map(|i| (i as f32 / 100.0).sin() * 3.0).collect();
		let out = run(&mut shaper, &samples);
		assert!(out.iter().all(|s| s.abs() <= top));
		assert_eq!(out[157], samples[157].clamp(-top, top));
	}

	#[test]
	fn oversampling_keeps_the_level_of_a_slow_signal_after_its_latency() {
		let mut shaper = Shaper::new();
		shaper.set_curve(Some(vec![-1.0, 1.0]));
		shaper.set_oversample(Oversample::X4);
		let samples: Vec<f32> = (0..1024)
			.map(|i| {
				(core::f64::consts::TAU * 1_000.0 * f64::from(i) / 48_000.0).sin() as f32 * 0.5
			})
			.collect();
		let out = run(&mut shaper, &samples);
		for n in 200..400 {
			assert!(
				(out[n] - samples[n - 16]).abs() < 2e-3,
				"frame {n}: {} vs {}",
				out[n],
				samples[n - 16]
			);
		}
	}
}
