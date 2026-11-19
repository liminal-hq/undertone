// Periodic-wave tables for the shaped waveforms and the phased autopan LFO, built as the reference does
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Periodic-wave tables, built the way `src/waves.ts` and `src/autopan.ts` build them.
//!
//! A table is the `real` and `imag` coefficient arrays of a Web Audio `PeriodicWave`, stored as
//! `f32` because the reference stores them in `Float32Array`s. Every table is built with the
//! caller's choice of [`Maths`] back-end.

use super::Maths;
use std::f64::consts::PI;

/// Harmonics of a shaped wave (its band limit).
pub const SHAPED_HARMONICS: usize = 64;

/// Points per period in the Fourier analysis of a shaped wave.
pub const ANALYSIS_SAMPLES: usize = 4096;

/// Harmonics of a phased triangle or square autopan LFO.
pub const LFO_HARMONICS: usize = 64;

/// The coefficients of a periodic wave: index 0 (the DC term) is always zero.
#[derive(Debug, Clone, PartialEq)]
pub struct WaveTable {
	/// Cosine coefficients, indexed by harmonic.
	pub real: Vec<f32>,
	/// Sine coefficients, indexed by harmonic.
	pub imag: Vec<f32>,
}

/// A shaped waveform: one period of a sine, cut or folded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapedWave {
	/// The positive half of a sine, then silence.
	HalfSine,
	/// Both halves of a sine made positive.
	AbsSine,
	/// The rising quarter of each half-cycle of `|sine|`, then silence.
	PulseSine,
}

/// The shape of an autopan LFO.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LfoShape {
	/// A sine.
	Sine,
	/// A triangle.
	Triangle,
	/// A square.
	Square,
}

/// One period of a shaped wave at `theta` in `[0, 2π)`.
fn shape<M: Maths>(wave: ShapedWave, theta: f64) -> f64 {
	let s = M::sin(theta);
	match wave {
		ShapedWave::HalfSine => {
			if s > 0.0 {
				s
			} else {
				0.0
			}
		}
		ShapedWave::AbsSine => s.abs(),
		ShapedWave::PulseSine => {
			if theta % PI < PI / 2.0 {
				s.abs()
			} else {
				0.0
			}
		}
	}
}

/// The Fourier coefficients of a shaped wave: 64 harmonics from 4096 points per period, summed in
/// order in double precision, then stored as `f32` (`shapedWaveTable` in `src/waves.ts`).
pub fn shaped_wave_table<M: Maths>(wave: ShapedWave) -> WaveTable {
	let n_points = ANALYSIS_SAMPLES as f64;
	let samples: Vec<f64> = (0..ANALYSIS_SAMPLES)
		.map(|n| shape::<M>(wave, (2.0 * PI * n as f64) / n_points))
		.collect();
	let mut real = vec![0.0_f32; SHAPED_HARMONICS + 1];
	let mut imag = vec![0.0_f32; SHAPED_HARMONICS + 1];
	for k in 1..=SHAPED_HARMONICS {
		let mut cos_sum = 0.0;
		let mut sin_sum = 0.0;
		for (n, sample) in samples.iter().enumerate() {
			let angle = (2.0 * PI * k as f64 * n as f64) / n_points;
			cos_sum += sample * M::cos(angle);
			sin_sum += sample * M::sin(angle);
		}
		real[k] = ((2.0 * cos_sum) / n_points) as f32;
		imag[k] = ((2.0 * sin_sum) / n_points) as f32;
	}
	WaveTable { real, imag }
}

/// The sine coefficient of harmonic `k` of a built-in oscillator wave, as the Web Audio
/// specification defines them (`sineCoefficient` in `src/autopan.ts`).
fn sine_coefficient<M: Maths>(shape: LfoShape, k: u32) -> f64 {
	let k = f64::from(k);
	match shape {
		LfoShape::Sine => {
			if k == 1.0 {
				1.0
			} else {
				0.0
			}
		}
		LfoShape::Triangle => (8.0 * M::sin((k * PI) / 2.0)) / M::pow(PI * k, 2.0),
		LfoShape::Square => (2.0 * (1.0 - M::pow(-1.0, k))) / (k * PI),
	}
}

/// The table of an autopan LFO started `phase` of a cycle in, with every harmonic `k` turned by
/// `k · 2π · phase` (the table `shapeLfo` in `src/autopan.ts` hands to `createPeriodicWave`).
///
/// A phase of zero uses the built-in oscillator type instead, so callers pass a non-zero one.
pub fn autopan_wave_table<M: Maths>(lfo: LfoShape, phase: f64) -> WaveTable {
	let harmonics = if lfo == LfoShape::Sine {
		1
	} else {
		LFO_HARMONICS
	};
	let mut real = vec![0.0_f32; harmonics + 1];
	let mut imag = vec![0.0_f32; harmonics + 1];
	for k in 1..=harmonics {
		let b = sine_coefficient::<M>(lfo, k as u32);
		let turn = 2.0 * PI * k as f64 * phase;
		real[k] = (b * M::sin(turn)) as f32;
		imag[k] = (b * M::cos(turn)) as f32;
	}
	WaveTable { real, imag }
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::math::Native;

	#[test]
	fn shaped_tables_have_65_entries_and_no_dc_term() {
		for wave in [
			ShapedWave::HalfSine,
			ShapedWave::AbsSine,
			ShapedWave::PulseSine,
		] {
			let table = shaped_wave_table::<Native>(wave);
			assert_eq!(table.real.len(), 65);
			assert_eq!(table.imag.len(), 65);
			assert_eq!(table.real[0], 0.0);
			assert_eq!(table.imag[0], 0.0);
		}
	}

	#[test]
	fn a_half_sine_has_a_fundamental_of_one_half() {
		// The positive half of a sine has b1 = 1/2 (and no cosine part at the fundamental).
		let table = shaped_wave_table::<Native>(ShapedWave::HalfSine);
		assert!((f64::from(table.imag[1]) - 0.5).abs() < 1e-6);
		assert!(f64::from(table.real[1]).abs() < 1e-6);
	}

	#[test]
	fn an_abs_sine_has_only_even_harmonics() {
		let table = shaped_wave_table::<Native>(ShapedWave::AbsSine);
		for k in (1..=63).step_by(2) {
			assert!(f64::from(table.imag[k]).abs() < 1e-6, "odd harmonic {k}");
		}
	}

	#[test]
	fn a_half_cycle_phase_sine_is_a_negated_cosine_pair() {
		let table = autopan_wave_table::<Native>(LfoShape::Sine, 0.5);
		assert_eq!(table.real.len(), 2);
		assert!(f64::from(table.real[1]).abs() < 1e-6);
		assert_eq!(table.imag[1], -1.0);
	}

	#[test]
	fn phased_triangles_and_squares_have_64_harmonics() {
		assert_eq!(
			autopan_wave_table::<Native>(LfoShape::Triangle, 0.5)
				.real
				.len(),
			65
		);
		assert_eq!(
			autopan_wave_table::<Native>(LfoShape::Square, 0.3)
				.imag
				.len(),
			65
		);
	}
}
