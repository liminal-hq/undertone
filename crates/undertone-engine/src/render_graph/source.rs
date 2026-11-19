// The buffer source node: plays an audio buffer at a playback rate, once or looping
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A buffer source reads its buffer at `playbackRate * buffer_rate / context_rate` frames per output frame
//! with linear interpolation. Without `loop` it ends (and is silent for good) when the position leaves the
//! buffer; with `loop` it wraps over the whole buffer. A source that was never started, or that has ended,
//! is silent.

use crate::graph::BufferId;
use crate::render_graph::mix::QUANTUM;

/// The state of one buffer source.
#[derive(Debug, Clone)]
pub(crate) struct SourceState {
	pub(crate) buffer: Option<BufferId>,
	pub(crate) looping: bool,
	position: f64,
	pub(crate) start: Option<u64>,
	pub(crate) stop: Option<u64>,
	finished: bool,
}

impl SourceState {
	pub(crate) fn new() -> Self {
		Self {
			buffer: None,
			looping: false,
			position: 0.0,
			start: None,
			stop: None,
			finished: false,
		}
	}

	/// Whether the source can make sound in the quantum starting at `frame`.
	pub(crate) fn is_live(&self, frame: u64) -> bool {
		!self.finished
			&& self.buffer.is_some()
			&& self
				.start
				.is_some_and(|start| start < frame + QUANTUM as u64)
			&& self.stop.is_none_or(|stop| stop > frame)
	}

	/// Renders one quantum into `out` (`channels` planar channels). Returns whether it is silent.
	pub(crate) fn process(
		&mut self,
		data: &[Vec<f32>],
		buffer_rate: f64,
		context_rate: f64,
		rate: &[f64],
		out: &mut [f32],
		first_frame: u64,
	) -> bool {
		let length = data.first().map_or(0, Vec::len);
		let Some(start) = self.start else {
			return true;
		};
		if length == 0 {
			return true;
		}
		let ratio = buffer_rate / context_rate;
		let mut sounded = false;
		for i in 0..QUANTUM {
			let frame = first_frame + i as u64;
			let active = frame >= start && self.stop.is_none_or(|stop| frame < stop);
			if self.finished || !active {
				for channel in 0..data.len() {
					out[channel * QUANTUM + i] = 0.0;
				}
				if self.stop.is_some_and(|stop| frame >= stop) {
					self.finished = true;
				}
				continue;
			}
			let end = length as f64;
			if self.looping {
				if self.position >= end || self.position < 0.0 {
					self.position -= (self.position / end).floor() * end;
				}
			} else if self.position >= end || self.position < 0.0 {
				self.finished = true;
				for channel in 0..data.len() {
					out[channel * QUANTUM + i] = 0.0;
				}
				continue;
			}
			let index = self.position as usize;
			let fraction = (self.position - index as f64) as f32;
			let next = if index + 1 < length {
				Some(index + 1)
			} else if self.looping {
				Some(0)
			} else {
				None
			};
			for (channel, samples) in data.iter().enumerate() {
				let a = samples[index];
				let b = next.map_or(0.0, |n| samples[n]);
				out[channel * QUANTUM + i] = a + (b - a) * fraction;
			}
			sounded = true;
			self.position += rate[i] * ratio;
		}
		!sounded
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn run(state: &mut SourceState, data: &[Vec<f32>], rate: f64, frame: u64) -> (Vec<f32>, bool) {
		let mut out = vec![0.0; QUANTUM * data.len()];
		let silent = state.process(data, 48_000.0, 48_000.0, &[rate; QUANTUM], &mut out, frame);
		(out, silent)
	}

	#[test]
	fn plays_once_and_ends() {
		let mut state = SourceState::new();
		state.buffer = Some(BufferId::new(0));
		state.start = Some(0);
		let data = vec![vec![1.0, 2.0, 3.0]];
		let (out, silent) = run(&mut state, &data, 1.0, 0);
		assert!(!silent);
		assert_eq!(&out[..5], &[1.0, 2.0, 3.0, 0.0, 0.0]);
		let (_, silent) = run(&mut state, &data, 1.0, 128);
		assert!(silent);
	}

	#[test]
	fn loops_over_the_whole_buffer() {
		let mut state = SourceState::new();
		state.buffer = Some(BufferId::new(0));
		state.looping = true;
		state.start = Some(0);
		let data = vec![vec![1.0, 2.0, 3.0]];
		let (out, _) = run(&mut state, &data, 1.0, 0);
		assert_eq!(&out[..7], &[1.0, 2.0, 3.0, 1.0, 2.0, 3.0, 1.0]);
	}

	#[test]
	fn half_rate_interpolates() {
		let mut state = SourceState::new();
		state.buffer = Some(BufferId::new(0));
		state.start = Some(0);
		let data = vec![vec![0.0, 1.0, 0.0]];
		let (out, _) = run(&mut state, &data, 0.5, 0);
		assert_eq!(&out[..5], &[0.0, 0.5, 1.0, 0.5, 0.0]);
	}

	#[test]
	fn starts_at_its_frame_and_stops_at_its_frame() {
		let mut state = SourceState::new();
		state.buffer = Some(BufferId::new(0));
		state.looping = true;
		state.start = Some(4);
		state.stop = Some(8);
		let data = vec![vec![1.0]];
		let (out, _) = run(&mut state, &data, 1.0, 0);
		assert_eq!(
			&out[..10],
			&[0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0]
		);
	}
}
