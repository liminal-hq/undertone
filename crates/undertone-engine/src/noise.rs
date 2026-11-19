// White, pink, and brown noise buffers for noise voices, generated as the reference generates them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`build_noise_buffer`]: a single-channel noise buffer (`buildNoiseBuffer` in `src/noise.ts`).
//!
//! White noise is the random source scaled to `-1..1`; pink noise is Paul Kellet's refined filter (the economy
//! variant); brown noise is a leaky random walk. Samples are stored as `f32`, as the reference stores them in
//! a `Float32Array`. The random source is the seeded generator the engine hands in, so a seed gives the same
//! buffer on every device.

use crate::graph::{BufferId, Graph};
use undertone_pattern::js;
use undertone_pattern::random::SeededRandom;

/// The colour of a noise voice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NoiseColour {
	/// Equal energy at every frequency.
	White,
	/// Energy falling with frequency (3 dB per octave).
	Pink,
	/// A leaky random walk: more energy still at the low end.
	Brown,
}

impl NoiseColour {
	/// The sound-type word (`"white"`, `"pink"`, `"brown"`), which also keys the engine's random draws.
	pub fn name(self) -> &'static str {
		match self {
			Self::White => "white",
			Self::Pink => "pink",
			Self::Brown => "brown",
		}
	}
}

/// How many frames a buffer of `seconds` has at `sample_rate`: `Math.max(1, Math.round(rate * seconds))`.
pub(crate) fn frame_count(sample_rate: f64, seconds: f64) -> usize {
	let frames = js::round(sample_rate * seconds);
	if frames >= 1.0 { frames as usize } else { 1 }
}

/// Makes a one-channel noise buffer of `duration_seconds` on `graph`, drawing from `random`.
///
/// ```
/// use undertone_engine::graph::LogGraph;
/// use undertone_engine::noise::{NoiseColour, build_noise_buffer};
/// use undertone_pattern::random::seeded_random;
///
/// let mut graph = LogGraph::new(44_100.0, 2);
/// let mut random = seeded_random("noise");
/// let buffer = build_noise_buffer(&mut graph, NoiseColour::White, 0.1, &mut random);
/// # let _ = buffer;
/// ```
pub fn build_noise_buffer<G: Graph>(
	graph: &mut G,
	colour: NoiseColour,
	duration_seconds: f64,
	random: &mut SeededRandom,
) -> BufferId {
	let sample_rate = graph.sample_rate();
	let length = frame_count(sample_rate, duration_seconds);
	let buffer = graph.create_buffer(1, length, sample_rate);
	let data = graph.buffer_channel_mut(buffer, 0);
	match colour {
		NoiseColour::White => {
			for sample in data.iter_mut().take(length) {
				*sample = (random.next_value() * 2.0 - 1.0) as f32;
			}
		}
		NoiseColour::Pink => {
			// Paul Kellet's refined pink noise filter (economy variant).
			let (mut b0, mut b1, mut b2, mut b3, mut b4, mut b5, mut b6) = (
				0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64,
			);
			for sample in data.iter_mut().take(length) {
				let white = random.next_value() * 2.0 - 1.0;
				b0 = 0.99886 * b0 + white * 0.0555179;
				b1 = 0.99332 * b1 + white * 0.0750759;
				b2 = 0.969 * b2 + white * 0.153852;
				b3 = 0.8665 * b3 + white * 0.3104856;
				b4 = 0.55 * b4 + white * 0.5329522;
				b5 = -0.7616 * b5 - white * 0.016898;
				let pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
				b6 = white * 0.115926;
				*sample = (pink * 0.11) as f32;
			}
		}
		NoiseColour::Brown => {
			// A leaky random walk (integrated white noise).
			let mut last = 0.0_f64;
			for sample in data.iter_mut().take(length) {
				let white = random.next_value() * 2.0 - 1.0;
				last = (last + 0.02 * white) / 1.02;
				*sample = (last * 3.5) as f32;
			}
		}
	}
	buffer
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::graph::LogGraph;
	use undertone_pattern::random::seeded_random;

	#[test]
	fn a_buffer_has_the_rounded_frame_count() {
		assert_eq!(frame_count(44_100.0, 0.05), 2205);
		assert_eq!(frame_count(44_100.0, 0.0), 1);
		assert_eq!(frame_count(44_100.0, -1.0), 1);
	}

	#[test]
	fn white_noise_stays_in_range_and_repeats_for_a_seed() {
		let mut graph = LogGraph::new(1000.0, 2);
		let a = build_noise_buffer(&mut graph, NoiseColour::White, 1.0, &mut seeded_random("x"));
		let first: Vec<f32> = graph.buffer_channel_mut(a, 0).to_vec();
		assert_eq!(first.len(), 1000);
		assert!(first.iter().all(|s| (-1.0..1.0).contains(s)));
		let b = build_noise_buffer(&mut graph, NoiseColour::White, 1.0, &mut seeded_random("x"));
		assert_eq!(graph.buffer_channel_mut(b, 0).to_vec(), first);
	}
}
