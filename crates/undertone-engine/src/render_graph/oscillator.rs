// Band-limited periodic waves and the oscillator that reads them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Periodic waves as band-limited wave tables, and the oscillator state that plays them.
//!
//! A wave is `x(t) = sum over k >= 1 of real[k] cos(k w t) + imag[k] sin(k w t)` (the DC term is ignored, as
//! the specification says). It is rendered into tables of [`TABLE_SIZE`] samples by an inverse FFT, one table
//! per third of an octave of fundamental frequency, each with only the partials that stay under the Nyquist
//! frequency for every frequency in its band, so playing the wave does not alias. The oscillator picks the
//! table for the frequency it is playing and reads it with linear interpolation.
//!
//! The four built-in types use the specification's coefficients and are normalised like a periodic wave made
//! with `createPeriodicWave` (unless that disabled it): the scale is one over the peak of the table with the
//! most partials, applied to every band. A truncated square or sawtooth overshoots by the Gibbs factor
//! 1.179, so they are scaled to 0.848 of the ideal wave, as Chromium's are (measured in layer 4, `R-layer4.md`).

use crate::graph::OscillatorType;
use crate::math::{pow, sin};
use crate::render_graph::fft::Fft;

/// Samples per table.
pub(crate) const TABLE_SIZE: usize = 4096;

/// The most partials a table can hold without folding over itself.
const MAX_PARTIALS: usize = TABLE_SIZE / 2 - 1;

/// The upper edge of the lowest band of fundamental frequencies, in hertz.
const FIRST_EDGE: f64 = 8.0;

/// The tables of one wave: a band of fundamental frequencies each.
#[derive(Debug, Clone)]
pub(crate) struct WaveTables {
	/// The highest fundamental each band serves, ascending.
	edges: Vec<f64>,
	tables: Vec<Vec<f32>>,
}

impl WaveTables {
	/// Builds the tables for coefficients `real` and `imag` (index `k` is the partial `k`; index 0 is unused).
	pub(crate) fn new(real: &[f64], imag: &[f64], normalise: bool, sample_rate: f64) -> Self {
		let nyquist = sample_rate / 2.0;
		let total = real
			.len()
			.max(imag.len())
			.saturating_sub(1)
			.min(MAX_PARTIALS);
		let fft = Fft::new(TABLE_SIZE);
		let mut edges = Vec::new();
		let mut tables = Vec::new();
		let mut edge = FIRST_EDGE;
		let mut scale = 1.0;
		loop {
			let last = edge >= nyquist;
			let top = if last { nyquist } else { edge };
			let partials = (((nyquist / top).floor() as usize).max(1)).min(total.max(1));
			let mut re = vec![0.0; TABLE_SIZE];
			let mut im = vec![0.0; TABLE_SIZE];
			for k in 1..=partials {
				re[k] = real.get(k).copied().unwrap_or(0.0);
				im[k] = imag.get(k).copied().unwrap_or(0.0);
			}
			fft.forward(&mut re, &mut im);
			// x[n] = Re(sum (r_k + i m_k) e^(-i k theta)) = sum r_k cos + m_k sin, as needed.
			if tables.is_empty() && normalise {
				let peak = re.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
				scale = if peak > 0.0 { 1.0 / peak } else { 1.0 };
			}
			tables.push(re.iter().map(|v| (v * scale) as f32).collect());
			edges.push(top);
			if last {
				break;
			}
			edge *= pow(2.0, 1.0 / 3.0);
		}
		Self { edges, tables }
	}

	/// The tables of a built-in oscillator type.
	pub(crate) fn basic(kind: OscillatorType, sample_rate: f64) -> Self {
		let count = MAX_PARTIALS + 1;
		let mut imag = vec![0.0; count];
		for (k, value) in imag.iter_mut().enumerate().skip(1) {
			let n = k as f64;
			let pi_n = core::f64::consts::PI * n;
			*value = match kind {
				OscillatorType::Sine => f64::from(k == 1),
				OscillatorType::Square => {
					if k % 2 == 1 {
						4.0 / pi_n
					} else {
						0.0
					}
				}
				OscillatorType::Sawtooth => {
					let sign = if k % 2 == 1 { 1.0 } else { -1.0 };
					2.0 * sign / pi_n
				}
				OscillatorType::Triangle => 8.0 * sin(pi_n / 2.0) / (pi_n * pi_n),
			};
		}
		Self::new(&[], &imag, true, sample_rate)
	}

	/// The band for a fundamental of `frequency` hertz (its sign is ignored).
	pub(crate) fn band(&self, frequency: f64) -> usize {
		let frequency = frequency.abs();
		self.edges
			.partition_point(|edge| *edge < frequency)
			.min(self.tables.len() - 1)
	}

	/// The sample of `band` at `phase` (in cycles, `0..1`), linearly interpolated.
	#[inline]
	pub(crate) fn read(&self, band: usize, phase: f64) -> f32 {
		let table = &self.tables[band];
		let position = phase * TABLE_SIZE as f64;
		let index = position as usize;
		let fraction = (position - index as f64) as f32;
		let a = table[index & (TABLE_SIZE - 1)];
		let b = table[(index + 1) & (TABLE_SIZE - 1)];
		a + (b - a) * fraction
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_sine_table_is_a_sine() {
		let tables = WaveTables::basic(OscillatorType::Sine, 48_000.0);
		let band = tables.band(440.0);
		for phase in [0.0, 0.1, 0.25, 0.5, 0.8] {
			let got = f64::from(tables.read(band, phase));
			let want = sin(2.0 * core::f64::consts::PI * phase);
			assert!((got - want).abs() < 1e-6, "{phase}: {got} vs {want}");
		}
	}

	#[test]
	fn bands_keep_the_partials_under_nyquist() {
		let sample_rate = 48_000.0;
		let tables = WaveTables::basic(OscillatorType::Sawtooth, sample_rate);
		let band = tables.band(5_000.0);
		// Up to 24000 / 6400 = 3 partials survive; the sawtooth's fourth would alias.
		let fft = Fft::new(TABLE_SIZE);
		let mut re: Vec<f64> = tables.tables[band].iter().map(|v| f64::from(*v)).collect();
		let mut im = vec![0.0; TABLE_SIZE];
		fft.forward(&mut re, &mut im);
		let magnitude =
			|k: usize| (re[k] * re[k] + im[k] * im[k]).sqrt() / (TABLE_SIZE as f64 / 2.0);
		assert!(magnitude(1) > 0.5 && magnitude(3) > 0.1);
		assert!(magnitude(5) < 1e-6, "{}", magnitude(5));
	}

	#[test]
	fn a_custom_wave_is_normalised_to_a_peak_of_one() {
		let tables = WaveTables::new(&[0.0, 0.0], &[0.0, 0.25], true, 48_000.0);
		let peak = tables.tables[0].iter().fold(0.0_f32, |m, v| m.max(v.abs()));
		assert!((peak - 1.0).abs() < 1e-6);
		let raw = WaveTables::new(&[0.0, 0.0], &[0.0, 0.25], false, 48_000.0);
		let peak = raw.tables[0].iter().fold(0.0_f32, |m, v| m.max(v.abs()));
		assert!((peak - 0.25).abs() < 1e-6);
	}
}
