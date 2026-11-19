// Channel up-mixing and down-mixing for the renderer, as Web Audio defines it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! How a connection's channels are mixed into a node's input.
//!
//! Signals are planar blocks: channel `c` of a block is `block[c * QUANTUM..(c + 1) * QUANTUM]`. With
//! `speakers` interpretation the layouts mono, stereo, quad (`L R SL SR`), and 5.1 (`L R C LFE SL SR`) mix by
//! the specification's matrices; any other pair of channel counts, and every pair under `discrete`
//! interpretation, copies the channels they share and drops or leaves silent the rest.

/// The renderer's block length in frames: Web Audio's render quantum.
pub(crate) const QUANTUM: usize = 128;

const HALF_ROOT: f32 = core::f32::consts::FRAC_1_SQRT_2;

/// Entries are `(output channel, input channel, gain)`.
type Matrix = &'static [(usize, usize, f32)];

fn speaker_matrix(from: usize, to: usize) -> Option<Matrix> {
	Some(match (from, to) {
		(1, 2) | (1, 4) => &[(0, 0, 1.0), (1, 0, 1.0)],
		(1, 6) => &[(2, 0, 1.0)],
		(2, 4) | (2, 6) => &[(0, 0, 1.0), (1, 1, 1.0)],
		(4, 6) => &[(0, 0, 1.0), (1, 1, 1.0), (4, 2, 1.0), (5, 3, 1.0)],
		(2, 1) => &[(0, 0, 0.5), (0, 1, 0.5)],
		(4, 1) => &[(0, 0, 0.25), (0, 1, 0.25), (0, 2, 0.25), (0, 3, 0.25)],
		(6, 1) => &[
			(0, 0, HALF_ROOT),
			(0, 1, HALF_ROOT),
			(0, 2, 1.0),
			(0, 4, 0.5),
			(0, 5, 0.5),
		],
		(4, 2) => &[(0, 0, 0.5), (0, 2, 0.5), (1, 1, 0.5), (1, 3, 0.5)],
		(6, 2) => &[
			(0, 0, 1.0),
			(0, 2, HALF_ROOT),
			(0, 4, HALF_ROOT),
			(1, 1, 1.0),
			(1, 2, HALF_ROOT),
			(1, 5, HALF_ROOT),
		],
		(6, 4) => &[
			(0, 0, 1.0),
			(0, 2, HALF_ROOT),
			(1, 1, 1.0),
			(1, 2, HALF_ROOT),
			(2, 4, 1.0),
			(3, 5, 1.0),
		],
		_ => return None,
	})
}

/// Adds `src` (`src_channels` channels) into `dst` (`dst_channels` channels), mixing as the interpretation says.
pub(crate) fn mix_add(
	dst: &mut [f32],
	dst_channels: usize,
	src: &[f32],
	src_channels: usize,
	speakers: bool,
) {
	let matrix = if speakers && src_channels != dst_channels {
		speaker_matrix(src_channels, dst_channels)
	} else {
		None
	};
	match matrix {
		Some(entries) => {
			for &(out, input, gain) in entries {
				let to = &mut dst[out * QUANTUM..(out + 1) * QUANTUM];
				let from = &src[input * QUANTUM..(input + 1) * QUANTUM];
				for (a, b) in to.iter_mut().zip(from) {
					*a += gain * *b;
				}
			}
		}
		None => {
			for channel in 0..src_channels.min(dst_channels) {
				let to = &mut dst[channel * QUANTUM..(channel + 1) * QUANTUM];
				let from = &src[channel * QUANTUM..(channel + 1) * QUANTUM];
				for (a, b) in to.iter_mut().zip(from) {
					*a += *b;
				}
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn planar(channels: &[f32]) -> Vec<f32> {
		channels
			.iter()
			.flat_map(|value| std::iter::repeat_n(*value, QUANTUM))
			.collect()
	}

	fn first_frame(block: &[f32], channels: usize) -> Vec<f32> {
		(0..channels).map(|c| block[c * QUANTUM]).collect()
	}

	fn mixed(src: &[f32], to: usize, speakers: bool) -> Vec<f32> {
		let mut dst = vec![0.0; to * QUANTUM];
		mix_add(&mut dst, to, &planar(src), src.len(), speakers);
		first_frame(&dst, to)
	}

	#[test]
	fn mono_up_to_stereo_copies() {
		assert_eq!(mixed(&[0.5], 2, true), [0.5, 0.5]);
		assert_eq!(mixed(&[0.5], 2, false), [0.5, 0.0]);
	}

	#[test]
	fn stereo_down_to_mono_averages() {
		assert_eq!(mixed(&[1.0, 0.5], 1, true), [0.75]);
		assert_eq!(mixed(&[1.0, 0.5], 1, false), [1.0]);
	}

	#[test]
	fn quad_down_to_stereo_adds_the_surrounds_at_half() {
		assert_eq!(mixed(&[1.0, 0.0, 1.0, 0.5], 2, true), [1.0, 0.25]);
	}

	#[test]
	fn five_one_down_to_stereo_adds_the_centre_and_surrounds_at_the_root_of_a_half() {
		let out = mixed(&[0.0, 0.0, 1.0, 0.7, 0.0, 0.0], 2, true);
		assert!((out[0] - HALF_ROOT).abs() < 1e-7 && (out[1] - HALF_ROOT).abs() < 1e-7);
		assert_eq!(mixed(&[0.0, 0.0, 0.0, 0.0, 1.0, 0.0], 1, true), [0.5]);
	}

	#[test]
	fn mono_up_to_five_one_goes_to_the_centre() {
		assert_eq!(mixed(&[1.0], 6, true), [0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
	}

	#[test]
	fn other_layouts_are_discrete() {
		// Three channels to two: the shared channels pass, the third is dropped.
		assert_eq!(mixed(&[1.0, 2.0, 3.0], 2, true), [1.0, 2.0]);
		// Eight channels have no speaker layout: eight to eight is a copy, eight to six drops two.
		assert_eq!(mixed(&[1.0; 8], 8, true), [1.0; 8]);
		assert_eq!(
			mixed(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0], 6, true),
			[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
		);
	}

	#[test]
	fn mixing_adds_into_what_is_there() {
		let mut dst = planar(&[1.0, 1.0]);
		mix_add(&mut dst, 2, &planar(&[0.25]), 1, true);
		assert_eq!(first_frame(&dst, 2), [1.25, 1.25]);
	}
}
