// Folds a list of channel gains down to what the destination can address
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Fold-down of channel gains (`foldToStereo` and `foldChannelGains` in `src/surround.ts`).
//!
//! The channel order is FL, FR, C, LFE, SL, SR, RL, RR (the Web Audio and SMPTE layout for 2, 6, and 8
//! channels); a shorter list addresses a prefix of it. The speaker-ring gains of `.surround(angle)` live in
//! [`crate::math::gains::surround_gains`].

use std::f64::consts::FRAC_1_SQRT_2;

/// The most channels a voice can be placed on (7.1).
pub const MAX_CHANNELS: usize = 8;

/// Folds a multichannel gain list down to `[left, right]` with the conventional (approximate ITU-style)
/// down-mix coefficients, so voices placed on the centre, sides, and rears stay audible on stereo hardware.
///
/// ```
/// use undertone_engine::surround::fold_to_stereo;
/// assert_eq!(fold_to_stereo(&[1.0, 0.5]), [1.0, 0.5]);
/// ```
pub fn fold_to_stereo(channel_gains: &[f64]) -> [f64; 2] {
	let g = |index: usize| channel_gains.get(index).copied().unwrap_or(0.0);
	let (centre_mix, surround_mix, lfe_mix) = (FRAC_1_SQRT_2, FRAC_1_SQRT_2, 0.5);
	[
		g(0) + centre_mix * g(2) + lfe_mix * g(3) + surround_mix * (g(4) + g(6)),
		g(1) + centre_mix * g(2) + lfe_mix * g(3) + surround_mix * (g(5) + g(7)),
	]
}

/// Folds a channel-gain list down to what a destination of `available` channels can address: the list as it
/// is when it fits, the 7.1 rears folded into the 5.1 sides on a destination of six or seven channels, and a
/// stereo fold-down otherwise.
///
/// ```
/// use undertone_engine::surround::fold_channel_gains;
/// assert_eq!(fold_channel_gains(&[1.0, 0.0, 0.0, 0.0], 4), [1.0, 0.0, 0.0, 0.0]);
/// assert_eq!(fold_channel_gains(&[1.0, 0.5, 0.0, 0.0], 2), [1.0, 0.5]);
/// ```
pub fn fold_channel_gains(channel_gains: &[f64], available: usize) -> Vec<f64> {
	if channel_gains.len() <= available {
		return channel_gains.to_vec();
	}
	if available >= 6 {
		let g = |index: usize| channel_gains.get(index).copied().unwrap_or(0.0);
		let mut five_one = vec![g(0), g(1), g(2), g(3), g(4), g(5)];
		five_one[4] += FRAC_1_SQRT_2 * g(6);
		five_one[5] += FRAC_1_SQRT_2 * g(7);
		return five_one;
	}
	fold_to_stereo(channel_gains).to_vec()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_rear_pair_folds_into_the_sides_on_six_channels() {
		let folded = fold_channel_gains(&[0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 1.0, 1.0], 6);
		assert_eq!(folded.len(), 6);
		assert!((folded[4] - 0.907_106_781).abs() < 1e-9);
	}

	#[test]
	fn the_centre_and_lfe_reach_both_stereo_sides() {
		let [left, right] = fold_to_stereo(&[0.0, 0.0, 1.0, 1.0]);
		assert_eq!(left, right);
		assert!((left - (FRAC_1_SQRT_2 + 0.5)).abs() < 1e-15);
	}
}
