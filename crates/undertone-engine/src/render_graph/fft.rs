// A small radix-2 FFT for the wave tables and the convolver
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A power-of-two complex FFT on split real and imaginary slices, with twiddles from [`crate::math`] so the
//! numbers do not depend on the platform's C library.

use crate::math::{cos, sin};

/// The plan for one transform size.
#[derive(Debug, Clone)]
pub(crate) struct Fft {
	size: usize,
	cos: Vec<f64>,
	sin: Vec<f64>,
	reversed: Vec<u32>,
}

impl Fft {
	/// A plan for `size` points (a power of two, at least 2).
	pub(crate) fn new(size: usize) -> Self {
		assert!(
			size.is_power_of_two() && size >= 2,
			"FFT size must be a power of two"
		);
		let half = size / 2;
		let step = -2.0 * core::f64::consts::PI / size as f64;
		let cos_table = (0..half).map(|k| cos(step * k as f64)).collect();
		let sin_table = (0..half).map(|k| sin(step * k as f64)).collect();
		let bits = size.trailing_zeros();
		let reversed = (0..size as u32)
			.map(|i| i.reverse_bits() >> (32 - bits))
			.collect();
		Self {
			size,
			cos: cos_table,
			sin: sin_table,
			reversed,
		}
	}

	/// The forward transform `X[k] = sum x[n] e^(-2 pi i k n / N)`, in place.
	pub(crate) fn forward(&self, re: &mut [f64], im: &mut [f64]) {
		debug_assert!(re.len() == self.size && im.len() == self.size);
		for i in 0..self.size {
			let j = self.reversed[i] as usize;
			if j > i {
				re.swap(i, j);
				im.swap(i, j);
			}
		}
		let mut len = 2;
		while len <= self.size {
			let half = len / 2;
			let stride = self.size / len;
			for start in (0..self.size).step_by(len) {
				for k in 0..half {
					let (wr, wi) = (self.cos[k * stride], self.sin[k * stride]);
					let (a, b) = (start + k, start + k + half);
					let tr = re[b] * wr - im[b] * wi;
					let ti = re[b] * wi + im[b] * wr;
					re[b] = re[a] - tr;
					im[b] = im[a] - ti;
					re[a] += tr;
					im[a] += ti;
				}
			}
			len *= 2;
		}
	}

	#[allow(dead_code)] // the convolver uses it
	/// The inverse transform scaled by `1 / N`, in place (through the conjugate).
	pub(crate) fn inverse(&self, re: &mut [f64], im: &mut [f64]) {
		for value in im.iter_mut() {
			*value = -*value;
		}
		self.forward(re, im);
		let scale = 1.0 / self.size as f64;
		for value in re.iter_mut() {
			*value *= scale;
		}
		for value in im.iter_mut() {
			*value = -*value * scale;
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_cosine_lands_in_its_bin() {
		let fft = Fft::new(64);
		let mut re: Vec<f64> = (0..64)
			.map(|n| cos(2.0 * core::f64::consts::PI * 5.0 * n as f64 / 64.0))
			.collect();
		let mut im = vec![0.0; 64];
		fft.forward(&mut re, &mut im);
		assert!((re[5] - 32.0).abs() < 1e-9 && (re[59] - 32.0).abs() < 1e-9);
		assert!(re[6].abs() < 1e-9 && im[5].abs() < 1e-9);
	}

	#[test]
	fn inverse_undoes_forward() {
		let fft = Fft::new(256);
		let original: Vec<f64> = (0..256)
			.map(|n| sin(n as f64 * 0.37) + 0.1 * n as f64)
			.collect();
		let mut re = original.clone();
		let mut im = vec![0.0; 256];
		fft.forward(&mut re, &mut im);
		fft.inverse(&mut re, &mut im);
		for (a, b) in re.iter().zip(&original) {
			assert!((a - b).abs() < 1e-9);
		}
		assert!(im.iter().all(|v| v.abs() < 1e-9));
	}
}
