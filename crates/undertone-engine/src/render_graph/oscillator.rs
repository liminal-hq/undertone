// Band-limited periodic waves and the oscillator that reads them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Periodic waves as band-limited wave tables, and the oscillator state that plays them.
//!
//! A wave is `x(t) = sum over k >= 1 of real[k] cos(k w t) + imag[k] sin(k w t)` (the DC term is ignored, as
//! the specification says). It is rendered into [`RANGES`] tables of [`TABLE_SIZE`] samples by an inverse FFT, one
//! per third of an octave of fundamental frequency, the table `i` keeping the `floor(2048 / 2^(i/3))` partials
//! that stay under the Nyquist frequency for every fundamental up to `lowest * 2^(i/3)`, where `lowest` is the
//! Nyquist frequency over 2048. The oscillator reads two neighbouring tables for the frequency it is playing and
//! blends them, so the partials near Nyquist fade out over a third of an octave instead of stopping at an edge.
//! This is the layout Chromium uses (measured against it in layer 4, `R-layer4.md`: the partials of a sawtooth
//! at 440 Hz and 32768 Hz, 26 to 32, come out at 0.656 of their full level, which is the blend of the tables
//! with 32 and 25 partials), so the renderer and a browser agree down to the quietest bands.
//!
//! The four built-in types use the specification's coefficients and are normalised like a periodic wave made
//! with `createPeriodicWave` (unless that disabled it): the scale is one over the peak of the table with the
//! most partials, applied to every band. A truncated square or sawtooth overshoots by the Gibbs factor
//! 1.179, so they are scaled to 0.848 of the ideal wave, as Chromium's are (measured in layer 4, `R-layer4.md`).
//!
//! Chromium picks the table size from the sample rate (2048 up to 24 kHz, 4096 up to 88.2 kHz, 8192 above); this
//! crate always uses 4096, so at the rates in between it matches and at the others it only follows the same layout.

use crate::graph::OscillatorType;
use crate::math::{ln, pow, sin};
use crate::render_graph::fft::Fft;

/// Samples per table.
pub(crate) const TABLE_SIZE: usize = 4096;

/// The most partials a table can hold without folding over itself (the Nyquist bin counts).
const MAX_PARTIALS: usize = TABLE_SIZE / 2;

/// Tables per wave: three per octave of the table size's logarithm.
const RANGES: usize = 3 * TABLE_SIZE.trailing_zeros() as usize;

/// The two tables to read for a frequency and how much of the second to take.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Lookup {
	lower: usize,
	upper: usize,
	/// Weight of the `upper` table, from 0 to 1 (the `lower` table has the rest).
	mix: f32,
}

/// The tables of one wave: a third of an octave of fundamental frequencies each.
#[derive(Debug, Clone)]
pub(crate) struct WaveTables {
	/// The lowest fundamental, in hertz: the Nyquist frequency over [`MAX_PARTIALS`].
	lowest: f64,
	tables: Vec<Vec<f32>>,
}

impl WaveTables {
	/// Builds the tables for coefficients `real` and `imag` (index `k` is the partial `k`; index 0 is unused).
	pub(crate) fn new(real: &[f64], imag: &[f64], normalise: bool, sample_rate: f64) -> Self {
		let total = real
			.len()
			.max(imag.len())
			.saturating_sub(1)
			.min(MAX_PARTIALS);
		let fft = Fft::new(TABLE_SIZE);
		let mut tables = Vec::with_capacity(RANGES);
		let mut scale = 1.0;
		for range in 0..RANGES {
			// A table `range` thirds of an octave up keeps 1/2^(range/3) of the partials.
			let fit = (MAX_PARTIALS as f64 / pow(2.0, range as f64 / 3.0)).floor() as usize;
			let partials = fit.max(1).min(total.max(1));
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
		}
		Self {
			lowest: sample_rate / 2.0 / MAX_PARTIALS as f64,
			tables,
		}
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

	/// The two tables for a fundamental of `frequency` hertz (its sign is ignored) and their blend. Each table
	/// serves the frequencies up to its edge, and the lookup rounds up one range, so the partials that would
	/// alias are gone just before they could.
	pub(crate) fn lookup(&self, frequency: f64) -> Lookup {
		let frequency = frequency.abs();
		let ratio = if frequency > 0.0 {
			frequency / self.lowest
		} else {
			0.5
		};
		let range =
			(1.0 + 3.0 * ln(ratio) / core::f64::consts::LN_2).clamp(0.0, (RANGES - 1) as f64);
		let lower = range as usize;
		let upper = if lower < RANGES - 1 { lower + 1 } else { lower };
		Lookup {
			lower,
			upper,
			mix: (range - lower as f64) as f32,
		}
	}

	/// The sample at `phase` (in cycles, `0..1`) of the blend of the two tables of `lookup`, each linearly interpolated.
	#[inline]
	pub(crate) fn read(&self, lookup: Lookup, phase: f64) -> f32 {
		let position = phase * TABLE_SIZE as f64;
		let index = position as usize;
		let fraction = (position - index as f64) as f32;
		let sample = |table: &[f32]| {
			let a = table[index & (TABLE_SIZE - 1)];
			let b = table[(index + 1) & (TABLE_SIZE - 1)];
			a + (b - a) * fraction
		};
		let lower = sample(&self.tables[lookup.lower]);
		if lookup.mix == 0.0 {
			return lower;
		}
		let upper = sample(&self.tables[lookup.upper]);
		lower + (upper - lower) * lookup.mix
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_sine_table_is_a_sine() {
		let tables = WaveTables::basic(OscillatorType::Sine, 48_000.0);
		let band = tables.lookup(440.0);
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
		let band = tables.lookup(5_000.0).lower;
		// The table for 5 kHz keeps floor(2048 / 2^(27/3)) = 4 partials, all under 24 kHz up to 6 kHz; the fifth would alias.
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
	fn two_tables_are_blended_as_chromium_does() {
		// A sawtooth at 440 Hz and 32768 Hz: the lowest fundamental is 8 Hz, so the range is
		// 1 + 3 log2(55) = 18.34: tables 18 (32 partials) and 19 (25 partials), a third of the way between.
		let tables = WaveTables::basic(OscillatorType::Sawtooth, 32_768.0);
		let lookup = tables.lookup(440.0);
		assert_eq!((lookup.lower, lookup.upper), (18, 19));
		assert!(
			(f64::from(lookup.mix) - 0.3437).abs() < 1e-3,
			"{}",
			lookup.mix
		);
		// A frequency below the lowest and a frequency above Nyquist stay inside the tables.
		assert_eq!(tables.lookup(0.0).lower, 0);
		assert_eq!(tables.lookup(1.0e9).upper, RANGES - 1);
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
