// The delay node: a ring buffer read with linear interpolation, with a one quantum minimum inside a cycle
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A delay line holds the last `max_delay` seconds of its input per channel and reads it back at
//! `delayTime` seconds (a value for every frame), interpolating linearly between frames. Outside a cycle it
//! writes a frame and then reads, so a delay of zero passes the input straight through. Inside a cycle (a
//! feedback loop) the graph reads the whole quantum first and writes it last, so the delay is at least one
//! quantum, as the specification says.
//!
//! Values that decay below about `1e-20` are written as zero, so a feedback tail ends exactly and the nodes
//! of a finished echo can be skipped.

use crate::render_graph::mix::QUANTUM;

/// Samples smaller than this are written as silence.
const FLOOR: f32 = 1e-20;

/// One delay line.
#[derive(Debug, Clone)]
pub(crate) struct DelayLine {
	ring: Vec<f32>,
	length: usize,
	channels: usize,
	write: usize,
	max_frames: f64,
	/// Frames of silence written since the last sound; a full ring of them means the line is empty.
	quiet: usize,
}

impl DelayLine {
	pub(crate) fn new(max_seconds: f64, sample_rate: f64) -> Self {
		let max_frames = (max_seconds * sample_rate).ceil().max(1.0);
		Self {
			ring: Vec::new(),
			length: max_frames as usize + QUANTUM + 2,
			channels: 0,
			write: 0,
			max_frames,
			quiet: usize::MAX / 2,
		}
	}

	/// Gives the line `channels` channels, keeping its contents when the count is unchanged.
	pub(crate) fn resize(&mut self, channels: usize) {
		if self.channels != channels {
			self.channels = channels;
			self.ring = vec![0.0; channels * self.length];
			self.write = 0;
			self.quiet = usize::MAX / 2;
		}
	}

	/// Whether the line holds nothing but silence.
	pub(crate) fn is_clear(&self) -> bool {
		self.quiet >= self.length
	}

	fn frames(&self, seconds: f64, sample_rate: f64, minimum: f64) -> f64 {
		(seconds * sample_rate).clamp(minimum, self.max_frames)
	}

	/// Reads the delayed signal of frame `i` of the quantum, whose first frame is written at `base`.
	fn read_frame(&self, out: &mut [f32], i: usize, base: usize, frames: f64) {
		let whole = frames.floor();
		let fraction = (frames - whole) as f32;
		let whole = whole as usize;
		let newer = (base + i + self.length - whole) % self.length;
		let older = (newer + self.length - 1) % self.length;
		for channel in 0..self.channels {
			let ring = &self.ring[channel * self.length..(channel + 1) * self.length];
			let (a, b) = (ring[newer], ring[older]);
			out[channel * QUANTUM + i] = a + (b - a) * fraction;
		}
	}

	fn write_frame(&mut self, input: &[f32], i: usize) {
		let at = (self.write + i) % self.length;
		for channel in 0..self.channels {
			let sample = input[channel * QUANTUM + i];
			self.ring[channel * self.length + at] = if sample.abs() < FLOOR { 0.0 } else { sample };
		}
	}

	fn note_written(&mut self, silent: bool) {
		self.quiet = if silent {
			self.quiet.saturating_add(QUANTUM)
		} else {
			0
		};
		self.write = (self.write + QUANTUM) % self.length;
	}

	/// A delay outside a cycle: writes and reads frame by frame.
	pub(crate) fn process(
		&mut self,
		input: &[f32],
		silent_input: bool,
		delay: &[f64],
		sample_rate: f64,
		out: &mut [f32],
	) {
		for (i, seconds) in delay.iter().enumerate().take(QUANTUM) {
			self.write_frame(input, i);
			let frames = self.frames(*seconds, sample_rate, 0.0);
			self.read_frame(out, i, self.write, frames);
		}
		self.note_written(silent_input);
	}

	/// The read half of a delay in a cycle (at least one quantum of delay).
	pub(crate) fn read(&self, delay: &[f64], sample_rate: f64, out: &mut [f32]) {
		for (i, seconds) in delay.iter().enumerate().take(QUANTUM) {
			let frames = self.frames(*seconds, sample_rate, QUANTUM as f64);
			self.read_frame(out, i, self.write, frames);
		}
	}

	/// The write half of a delay in a cycle.
	pub(crate) fn write(&mut self, input: &[f32], silent_input: bool) {
		if silent_input && self.is_clear() {
			return;
		}
		for i in 0..QUANTUM {
			self.write_frame(input, i);
		}
		self.note_written(silent_input);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn impulse() -> Vec<f32> {
		let mut block = vec![0.0; QUANTUM];
		block[0] = 1.0;
		block
	}

	#[test]
	fn delays_by_whole_frames() {
		let mut line = DelayLine::new(1.0, 1_000.0);
		line.resize(1);
		let mut out = vec![0.0; QUANTUM];
		line.process(&impulse(), false, &[0.01; QUANTUM], 1_000.0, &mut out);
		assert_eq!(out.iter().position(|s| *s == 1.0), Some(10));
		assert_eq!(out.iter().filter(|s| **s != 0.0).count(), 1);
	}

	#[test]
	fn a_fractional_delay_interpolates() {
		let mut line = DelayLine::new(1.0, 1_000.0);
		line.resize(1);
		let mut out = vec![0.0; QUANTUM];
		line.process(&impulse(), false, &[0.0105; QUANTUM], 1_000.0, &mut out);
		assert!((out[10] - 0.5).abs() < 1e-6 && (out[11] - 0.5).abs() < 1e-6);
	}

	#[test]
	fn zero_delay_passes_the_input_through() {
		let mut line = DelayLine::new(1.0, 1_000.0);
		line.resize(1);
		let mut out = vec![0.0; QUANTUM];
		line.process(&impulse(), false, &[0.0; QUANTUM], 1_000.0, &mut out);
		assert_eq!(out, impulse());
	}

	#[test]
	fn the_delay_carries_over_quanta() {
		let mut line = DelayLine::new(1.0, 1_000.0);
		line.resize(1);
		let mut out = vec![0.0; QUANTUM];
		line.process(&impulse(), false, &[0.2; QUANTUM], 1_000.0, &mut out);
		assert!(out.iter().all(|s| *s == 0.0));
		line.process(
			&vec![0.0; QUANTUM],
			true,
			&[0.2; QUANTUM],
			1_000.0,
			&mut out,
		);
		assert_eq!(out.iter().position(|s| *s == 1.0), Some(72));
	}

	#[test]
	fn a_cycle_delay_has_a_one_quantum_floor() {
		let mut line = DelayLine::new(1.0, 1_000.0);
		line.resize(1);
		let mut out = vec![0.0; QUANTUM];
		line.read(&[0.01; QUANTUM], 1_000.0, &mut out);
		assert!(out.iter().all(|s| *s == 0.0));
		line.write(&impulse(), false);
		// Asked for 10 frames, gets 128: the impulse written at frame 0 arrives at frame 0 of the next quantum.
		line.read(&[0.01; QUANTUM], 1_000.0, &mut out);
		assert_eq!(out[0], 1.0);
		assert_eq!(out.iter().filter(|s| **s != 0.0).count(), 1);
	}

	#[test]
	fn an_empty_line_is_clear_and_a_sound_clears_after_one_trip_round_the_ring() {
		let mut line = DelayLine::new(0.5, 1_000.0);
		line.resize(1);
		assert!(line.is_clear());
		let mut out = vec![0.0; QUANTUM];
		line.process(&impulse(), false, &[0.1; QUANTUM], 1_000.0, &mut out);
		assert!(!line.is_clear());
		for _ in 0..6 {
			line.process(
				&vec![0.0; QUANTUM],
				true,
				&[0.1; QUANTUM],
				1_000.0,
				&mut out,
			);
		}
		assert!(line.is_clear());
	}

	#[test]
	fn a_cycle_delay_at_a_very_low_sample_rate_does_not_panic() {
		// Five seconds is 5 frames at 1 Hz, under the one quantum a cycle needs: the quantum wins.
		let mut line = DelayLine::new(5.0, 1.0);
		line.resize(1);
		let mut out = vec![0.0; QUANTUM];
		line.read(&[1.0; QUANTUM], 1.0, &mut out);
		line.write(&impulse(), false);
		line.read(&[1.0; QUANTUM], 1.0, &mut out);
		// Outside a cycle the delay still tops out at the maximum time (5 frames).
		line.process(&impulse(), false, &[1.0e9; QUANTUM], 1.0, &mut out);
		assert!(out.iter().all(|s| s.is_finite()));
	}

	#[test]
	fn a_nan_delay_time_reads_as_the_minimum() {
		let mut line = DelayLine::new(1.0, 1_000.0);
		line.resize(1);
		let mut out = vec![0.0; QUANTUM];
		line.process(&impulse(), false, &[f64::NAN; QUANTUM], 1_000.0, &mut out);
		assert_eq!(out, impulse());
	}
}
