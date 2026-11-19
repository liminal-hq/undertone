// The convolver node: uniformly partitioned FFT convolution of an impulse response
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Convolution with an impulse response, exactly (no approximation beyond floating-point rounding).
//!
//! The response is cut into partitions of one quantum, each transformed once with a 256-point FFT. Every
//! quantum the input's block (with the one before it) is transformed too and kept in a delay line of spectra;
//! the output is the sum of each partition's spectrum times the input spectrum from as many quanta ago, one
//! inverse transform, and the second half of it (overlap-save). The delay is zero: the first partition acts on
//! the quantum being rendered.
//!
//! Web Audio's normalisation is applied when the response is set: the response is scaled by
//! `calibration * (44100 / sample_rate) / max(rms, 0.000125)` (and by half for four channels), where `calibration`
//! is -58 dB, `10^(-58/20)` = 0.0012589 (the specification's 0.00125 is that rounded; Chromium's convolver
//! measured 0.0012589 at 44100 Hz, `R-layer4.md`), and `rms` is the
//! root mean square over every sample of every channel. A response of one channel convolves each input
//! channel with it; a response of two channels makes a stereo output (a mono input feeds both); a response of
//! four channels is true stereo (left and right inputs each have a response to each output). A response at a
//! different sample rate than the context is resampled linearly. Setting a new response drops the tail of the
//! old one.

use crate::math::pow;
use crate::render_graph::fft::Fft;
use crate::render_graph::mix::QUANTUM;

/// The transform size: two quanta.
const FFT_SIZE: usize = 2 * QUANTUM;

/// Bins of a real transform of that size, `0..=QUANTUM`.
const BINS: usize = QUANTUM + 1;

/// The calibration gain in decibels: `10^(-58/20)`, which a browser's convolver applies (0.00125 is that rounded).
const GAIN_CALIBRATION_DB: f64 = -58.0;
const CALIBRATION_RATE: f64 = 44_100.0;
const MIN_POWER: f64 = 0.000_125;

/// The spectra of the partitions of one response channel.
#[derive(Debug, Clone)]
struct Spectra {
	re: Vec<f64>,
	im: Vec<f64>,
}

#[derive(Debug, Clone)]
struct Response {
	spectra: Vec<Spectra>,
	partitions: usize,
}

/// The convolver's state.
#[derive(Debug, Clone)]
pub(crate) struct Convolver {
	fft: Fft,
	response: Option<Response>,
	/// Per input channel: the spectra of the last `partitions` input blocks, newest at `newest`.
	history_re: Vec<Vec<f64>>,
	history_im: Vec<Vec<f64>>,
	/// Whether each slot of the history holds a nonzero spectrum.
	live: Vec<Vec<bool>>,
	previous: Vec<Vec<f64>>,
	newest: usize,
	/// Quanta since the last sound went in.
	quiet: usize,
	scratch_re: Vec<f64>,
	scratch_im: Vec<f64>,
	acc_re: Vec<f64>,
	acc_im: Vec<f64>,
}

/// The normalisation scale for a response, from the specification.
fn normalisation(channels: &[Vec<f32>], sample_rate: f64) -> f64 {
	let length = channels.first().map_or(0, Vec::len);
	let total = (channels.len() * length) as f64;
	let energy: f64 = channels
		.iter()
		.flat_map(|c| c.iter())
		.map(|s| f64::from(*s).powi(2))
		.sum();
	let mut power = if total > 0.0 {
		(energy / total).sqrt()
	} else {
		0.0
	};
	if !power.is_finite() || power < MIN_POWER {
		power = MIN_POWER;
	}
	let mut scale =
		pow(10.0, GAIN_CALIBRATION_DB / 20.0) / power * (CALIBRATION_RATE / sample_rate);
	if channels.len() == 4 {
		scale *= 0.5;
	}
	scale
}

/// The most frames an impulse response keeps after resampling to the context's rate (about 43 seconds at
/// 48000 Hz). A longer one is cut: a response that long is a mistake, and its partitions would be an
/// allocation and a per-quantum cost out of all proportion.
pub(crate) const MAX_RESPONSE_FRAMES: usize = 1 << 21;

/// `data` resampled from `from` hertz to `to` hertz by linear interpolation, at most [`MAX_RESPONSE_FRAMES`]
/// long. A rate that is not positive and finite leaves the data as it is (the graph rejects such a buffer
/// before it gets here; this keeps the convolver itself from an unbounded length).
fn resample(data: &[f32], from: f64, to: f64) -> Vec<f32> {
	let usable = from.is_finite() && from > 0.0 && to.is_finite() && to > 0.0;
	if !usable || from == to || data.is_empty() {
		return data[..data.len().min(MAX_RESPONSE_FRAMES)].to_vec();
	}
	let wanted = (data.len() as f64 * to / from).round();
	let length = if wanted.is_nan() {
		1
	} else {
		(wanted.min(MAX_RESPONSE_FRAMES as f64) as usize).max(1)
	};
	(0..length)
		.map(|i| {
			let at = i as f64 * from / to;
			let index = (at as usize).min(data.len() - 1);
			let next = (index + 1).min(data.len() - 1);
			let fraction = (at - index as f64) as f32;
			data[index] + (data[next] - data[index]) * fraction
		})
		.collect()
}

impl Convolver {
	pub(crate) fn new() -> Self {
		Self {
			fft: Fft::new(FFT_SIZE),
			response: None,
			history_re: Vec::new(),
			history_im: Vec::new(),
			live: Vec::new(),
			previous: Vec::new(),
			newest: 0,
			quiet: usize::MAX / 2,
			scratch_re: vec![0.0; FFT_SIZE],
			scratch_im: vec![0.0; FFT_SIZE],
			acc_re: vec![0.0; BINS],
			acc_im: vec![0.0; BINS],
		}
	}

	/// How many channels the response has (0 for none).
	pub(crate) fn response_channels(&self) -> usize {
		self.response.as_ref().map_or(0, |r| r.spectra.len())
	}

	/// The output channels for `input_channels` inputs (1 or 2).
	pub(crate) fn output_channels(&self, input_channels: usize) -> usize {
		match self.response_channels() {
			0 | 1 => input_channels,
			_ => 2,
		}
	}

	/// Sets the impulse response (`None` or an empty buffer for none), normalised, and drops the old tail.
	pub(crate) fn set_response(
		&mut self,
		channels: Option<&[Vec<f32>]>,
		sample_rate: f64,
		context_rate: f64,
	) {
		self.response = None;
		self.history_re.clear();
		self.history_im.clear();
		self.live.clear();
		self.previous.clear();
		self.quiet = usize::MAX / 2;
		let Some(channels) = channels else {
			return;
		};
		if channels.is_empty() || channels[0].is_empty() {
			return;
		}
		let scale = normalisation(channels, sample_rate);
		let resampled: Vec<Vec<f32>> = channels
			.iter()
			.map(|c| resample(c, sample_rate, context_rate))
			.collect();
		let length = resampled[0].len();
		let partitions = length.div_ceil(QUANTUM);
		let mut spectra = Vec::with_capacity(resampled.len());
		for channel in &resampled {
			let mut re = vec![0.0; partitions * BINS];
			let mut im = vec![0.0; partitions * BINS];
			for p in 0..partitions {
				self.scratch_re.fill(0.0);
				self.scratch_im.fill(0.0);
				let part = &channel[p * QUANTUM..((p + 1) * QUANTUM).min(channel.len())];
				for (slot, sample) in self.scratch_re.iter_mut().zip(part) {
					*slot = f64::from(*sample) * scale;
				}
				self.fft.forward(&mut self.scratch_re, &mut self.scratch_im);
				re[p * BINS..(p + 1) * BINS].copy_from_slice(&self.scratch_re[..BINS]);
				im[p * BINS..(p + 1) * BINS].copy_from_slice(&self.scratch_im[..BINS]);
			}
			spectra.push(Spectra { re, im });
		}
		self.response = Some(Response {
			spectra,
			partitions,
		});
		self.newest = 0;
	}

	/// Gives the convolver state for `channels` input channels, keeping it when the count is unchanged.
	pub(crate) fn resize(&mut self, channels: usize) {
		let Some(response) = &self.response else {
			return;
		};
		if self.history_re.len() != channels {
			let size = response.partitions * BINS;
			self.history_re = vec![vec![0.0; size]; channels];
			self.history_im = vec![vec![0.0; size]; channels];
			self.live = vec![vec![false; response.partitions]; channels];
			self.previous = vec![vec![0.0; QUANTUM]; channels];
			self.newest = 0;
			self.quiet = usize::MAX / 2;
		}
	}

	/// Whether the tail has run out, so a silent input gives silence.
	pub(crate) fn is_finished(&self) -> bool {
		self.response
			.as_ref()
			.is_none_or(|r| self.quiet > r.partitions)
	}

	/// The pairs `(input channel, response channel)` that make up output `output`.
	fn pairs(&self, input_channels: usize, output: usize) -> [Option<(usize, usize)>; 2] {
		let response = self.response_channels();
		match response {
			1 => [Some((output, 0)), None],
			2 => [
				Some((if input_channels == 2 { output } else { 0 }, output)),
				None,
			],
			_ => {
				let right = if input_channels == 2 { 1 } else { 0 };
				[Some((0, output)), Some((right, output + 2))]
			}
		}
	}

	/// Convolves one quantum of `input_channels` planar channels into `out`; `silent` says the input is
	/// exactly silent.
	pub(crate) fn process(
		&mut self,
		input: &[f32],
		input_channels: usize,
		silent: bool,
		out: &mut [f32],
	) {
		let Some(response) = &self.response else {
			out.fill(0.0);
			return;
		};
		let partitions = response.partitions;
		self.quiet = if silent {
			self.quiet.saturating_add(1)
		} else {
			0
		};
		if self.quiet > partitions {
			// Every slot of the history is older than the response is long: nothing more can come out. Leave
			// the state clean, so a node skipped from here on resumes as if it had run.
			for live in &mut self.live {
				live.fill(false);
			}
			for previous in &mut self.previous {
				previous.fill(0.0);
			}
			out.fill(0.0);
			return;
		}
		self.newest = (self.newest + 1) % partitions;
		// Transform the newest block of every input channel into its slot of the history.
		for channel in 0..input_channels {
			let block = &input[channel * QUANTUM..(channel + 1) * QUANTUM];
			let was_live = self.previous[channel].iter().any(|v| *v != 0.0);
			self.scratch_re[..QUANTUM].copy_from_slice(&self.previous[channel]);
			for (slot, sample) in self.scratch_re[QUANTUM..].iter_mut().zip(block) {
				*slot = if silent { 0.0 } else { f64::from(*sample) };
			}
			self.scratch_im.fill(0.0);
			let live = was_live || !silent;
			self.live[channel][self.newest] = live;
			if live {
				self.fft.forward(&mut self.scratch_re, &mut self.scratch_im);
				let base = self.newest * BINS;
				self.history_re[channel][base..base + BINS]
					.copy_from_slice(&self.scratch_re[..BINS]);
				self.history_im[channel][base..base + BINS]
					.copy_from_slice(&self.scratch_im[..BINS]);
			}
			for (slot, sample) in self.previous[channel].iter_mut().zip(block) {
				*slot = if silent { 0.0 } else { f64::from(*sample) };
			}
		}
		let outputs = self.output_channels(input_channels);
		for output in 0..outputs {
			self.acc_re.fill(0.0);
			self.acc_im.fill(0.0);
			let mut any = false;
			for (channel, kernel) in self.pairs(input_channels, output).into_iter().flatten() {
				let spectra = &response.spectra[kernel];
				for p in 0..partitions {
					let slot = (self.newest + partitions - p) % partitions;
					if !self.live[channel][slot] {
						continue;
					}
					any = true;
					let x = slot * BINS;
					let h = p * BINS;
					let (xr, xi) = (
						&self.history_re[channel][x..x + BINS],
						&self.history_im[channel][x..x + BINS],
					);
					let (hr, hi) = (&spectra.re[h..h + BINS], &spectra.im[h..h + BINS]);
					for k in 0..BINS {
						self.acc_re[k] += hr[k] * xr[k] - hi[k] * xi[k];
						self.acc_im[k] += hr[k] * xi[k] + hi[k] * xr[k];
					}
				}
			}
			let target = &mut out[output * QUANTUM..(output + 1) * QUANTUM];
			if !any {
				target.fill(0.0);
				continue;
			}
			// Rebuild the full spectrum of a real signal and take the second half of the inverse.
			self.scratch_re[..BINS].copy_from_slice(&self.acc_re);
			self.scratch_im[..BINS].copy_from_slice(&self.acc_im);
			for k in 1..QUANTUM {
				self.scratch_re[FFT_SIZE - k] = self.acc_re[k];
				self.scratch_im[FFT_SIZE - k] = -self.acc_im[k];
			}
			self.fft.inverse(&mut self.scratch_re, &mut self.scratch_im);
			for (slot, value) in target.iter_mut().zip(&self.scratch_re[QUANTUM..]) {
				*slot = *value as f32;
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn run(convolver: &mut Convolver, signal: &[f32], input_channels: usize) -> Vec<Vec<f32>> {
		convolver.resize(input_channels);
		let outputs = convolver.output_channels(input_channels);
		let mut result = vec![Vec::new(); outputs];
		for block in signal.chunks(QUANTUM) {
			let mut input = vec![0.0; QUANTUM * input_channels];
			for channel in 0..input_channels {
				input[channel * QUANTUM..channel * QUANTUM + block.len()].copy_from_slice(block);
			}
			let silent = block.iter().all(|s| *s == 0.0);
			let mut out = vec![0.0; QUANTUM * outputs];
			convolver.process(&input, input_channels, silent, &mut out);
			for (channel, all) in result.iter_mut().enumerate() {
				all.extend_from_slice(&out[channel * QUANTUM..(channel + 1) * QUANTUM]);
			}
		}
		result
	}

	fn direct(signal: &[f32], kernel: &[f32], scale: f64) -> Vec<f64> {
		let mut out = vec![0.0; signal.len()];
		for (n, slot) in out.iter_mut().enumerate() {
			for (k, h) in kernel.iter().enumerate() {
				if n >= k {
					*slot += f64::from(signal[n - k]) * f64::from(*h) * scale;
				}
			}
		}
		out
	}

	#[test]
	fn matches_direct_convolution_across_partitions() {
		// A 600-frame response (five partitions) against a 900-frame signal.
		let kernel: Vec<f32> = (0..600)
			.map(|i| ((i * 37 % 101) as f32 - 50.0) / 100.0)
			.collect();
		let signal: Vec<f32> = (0..1024)
			.map(|i| ((i * 13 % 59) as f32 - 29.0) / 30.0)
			.collect();
		let mut convolver = Convolver::new();
		convolver.set_response(Some(std::slice::from_ref(&kernel)), 48_000.0, 48_000.0);
		let scale = normalisation(std::slice::from_ref(&kernel), 48_000.0);
		let got = run(&mut convolver, &signal, 1);
		let want = direct(&signal, &kernel, scale);
		for (n, (g, w)) in got[0].iter().zip(&want).enumerate() {
			assert!(
				(f64::from(*g) - w).abs() < 1e-4 * (1.0 + w.abs()),
				"frame {n}: {g} vs {w}"
			);
		}
	}

	#[test]
	fn an_impulse_reproduces_the_response_and_the_tail_ends() {
		let kernel = vec![0.0, 0.5, 0.25, -0.125];
		let mut convolver = Convolver::new();
		convolver.set_response(Some(std::slice::from_ref(&kernel)), 44_100.0, 44_100.0);
		let mut signal = vec![0.0_f32; 3 * QUANTUM];
		signal[0] = 1.0;
		let got = run(&mut convolver, &signal, 1);
		let gain = normalisation(std::slice::from_ref(&kernel), 44_100.0);
		for (n, h) in kernel.iter().enumerate() {
			assert!((f64::from(got[0][n]) - f64::from(*h) * gain).abs() < 1e-6);
		}
		assert!(got[0][4..].iter().all(|s| s.abs() < 1e-6));
		assert!(convolver.is_finished());
	}

	#[test]
	fn the_normalisation_follows_the_specification() {
		// One channel of 100 samples of 0.5: rms 0.5, so calibration / 0.5 at 44100 Hz. Chromium's convolver gave
		// 0.0012589251855 for an impulse through a response of 0.5s at 44100 Hz (0.00125 / 0.5 * 0.5 of -58 dB).
		let calibration = pow(10.0, -58.0 / 20.0);
		assert!((calibration - 0.001_258_925_4).abs() < 1e-9);
		let channels = [vec![0.5_f32; 100]];
		assert!((normalisation(&channels, 44_100.0) - calibration / 0.5).abs() < 1e-12);
		assert!((normalisation(&channels, 22_050.0) - calibration / 0.25).abs() < 1e-12);
		// A silent response falls back to the minimum power.
		assert!((normalisation(&[vec![0.0; 10]], 44_100.0) - calibration * 8000.0).abs() < 1e-9);
		assert!((normalisation(&vec![vec![0.5; 4]; 4], 44_100.0) - calibration).abs() < 1e-12);
	}

	#[test]
	fn a_stereo_response_makes_stereo_from_mono() {
		let left = vec![1.0_f32, 0.0];
		let right = vec![0.0_f32, 1.0];
		let mut convolver = Convolver::new();
		convolver.set_response(Some(&[left.clone(), right.clone()]), 44_100.0, 44_100.0);
		assert_eq!(convolver.output_channels(1), 2);
		let mut signal = vec![0.0_f32; QUANTUM];
		signal[0] = 1.0;
		let got = run(&mut convolver, &signal, 1);
		let gain = normalisation(&[left, right], 44_100.0);
		assert!((f64::from(got[0][0]) - gain).abs() < 1e-6 && got[0][1].abs() < 1e-6);
		assert!(got[1][0].abs() < 1e-6 && (f64::from(got[1][1]) - gain).abs() < 1e-6);
	}

	#[test]
	fn a_new_response_drops_the_old_tail() {
		let mut convolver = Convolver::new();
		let long = vec![0.5_f32; 1000];
		convolver.set_response(Some(std::slice::from_ref(&long)), 44_100.0, 44_100.0);
		let mut signal = vec![0.0_f32; QUANTUM];
		signal[0] = 1.0;
		run(&mut convolver, &signal, 1);
		convolver.set_response(Some(&[long]), 44_100.0, 44_100.0);
		let got = run(&mut convolver, &vec![0.0; 2 * QUANTUM], 1);
		assert!(got[0].iter().all(|s| *s == 0.0));
	}

	#[test]
	fn a_response_at_an_unusable_rate_does_not_panic() {
		for rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
			let mut convolver = Convolver::new();
			convolver.set_response(Some(&[vec![0.5_f32; 100]]), rate, 48_000.0);
			assert_eq!(convolver.response_channels(), 1, "{rate}");
		}
	}

	#[test]
	fn a_resampled_response_is_cut_to_the_limit() {
		let data = vec![0.5_f32; 1_000];
		let resampled = resample(&data, 1.0, 100_000.0);
		assert_eq!(resampled.len(), MAX_RESPONSE_FRAMES);
	}
}
