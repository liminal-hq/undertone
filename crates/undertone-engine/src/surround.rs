// Folds a list of channel gains down to what the destination can address
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Multichannel (up to 7.1) placement: the speaker ring, the fold-down, the destination setup, and the mono
//! fold (`src/surround.ts` and `src/monoFold.ts`).
//!
//! The channel order is [`CHANNEL_ORDER`]: FL, FR, C, LFE, SL, SR, RL, RR, the Web Audio and SMPTE layout for
//! 2 (stereo), 6 (5.1), and 8 (7.1) channel destinations. A shorter list of gains addresses a prefix of it.
//!
//! - [`surround_gains`] computes the 7.1 gains that place a sound at an angle on the speaker ring (what
//!   `.surround(angle)` writes into a voice's `channelGains`).
//! - [`fold_to_stereo`] and [`fold_channel_gains`] fold gains down to what the destination can address.
//! - [`enable_multichannel`] opts a destination into its full hardware channel count with discrete channel
//!   interpretation, so channel gains address real speakers.
//! - [`create_mono_fold`] makes a node that folds everything played into it down to mono.

use crate::graph::{ChannelCountMode, ChannelInterpretation, Graph, NodeId, NodeKind};
use crate::math::{Active, gains};
use std::f64::consts::FRAC_1_SQRT_2;
use undertone_pattern::{Error, Result, js};

/// The most channels a voice can be placed on (7.1): the length of [`CHANNEL_ORDER`].
pub const MAX_CHANNELS: usize = CHANNEL_ORDER.len();

/// The channel order used throughout: FL, FR, C, LFE, SL, SR, RL, RR, the conventional Web Audio and SMPTE
/// layout for 2 (stereo), 6 (5.1), and 8 (7.1) channel destinations. Shorter lists of gains address a prefix
/// of it.
///
/// ```
/// use undertone_engine::surround::{CHANNEL_ORDER, MAX_CHANNELS};
/// assert_eq!(CHANNEL_ORDER[2], "C");
/// assert_eq!(MAX_CHANNELS, 8);
/// ```
pub const CHANNEL_ORDER: [&str; 8] = ["FL", "FR", "C", "LFE", "SL", "SR", "RL", "RR"];

/// Computes the 7.1 channel gains that place a sound at `angle_degrees` on the speaker ring (0 degrees is
/// front-centre, 30 front-right, plus or minus 90 the sides, plus or minus 150 the rears, and plus or minus
/// 180 dead behind) using equal-power panning between the two nearest speakers. The LFE channel is always 0:
/// route to it explicitly with `channels` if you want rumble. Any angle is wrapped onto the ring.
///
/// # Errors
///
/// An angle that is not finite fails with the reference's message,
/// `surround() angle must be a finite number, got NaN`.
///
/// ```
/// use undertone_engine::surround::surround_gains;
/// // Midway between C (0) and FR (30): equal power, 0.707 each.
/// let gains = surround_gains(15.0)?;
/// assert!((gains[2] - 0.5_f64.sqrt()).abs() < 1e-12 && (gains[1] - 0.5_f64.sqrt()).abs() < 1e-12);
/// assert_eq!(surround_gains(90.0)?[5], 1.0);
/// assert!(surround_gains(f64::NAN).is_err());
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
pub fn surround_gains(angle_degrees: f64) -> Result<[f64; MAX_CHANNELS]> {
	gains::surround_gains::<Active>(angle_degrees).map_err(|_| {
		Error::new(format!(
			"surround() angle must be a finite number, got {}",
			js::number_to_string(angle_degrees)
		))
	})
}

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

/// Opts a graph's destination into its full hardware channel count (up to [`MAX_CHANNELS`]) with discrete
/// channel interpretation, so channel gains address real speakers (`enableMultichannel`). Call it once, right
/// after making the graph; without it (or on plain stereo hardware) multichannel voices fold down to stereo.
/// Does nothing on hardware of two channels or fewer. Returns the destination's channel count afterwards.
///
/// ```
/// use undertone_engine::graph::LogGraph;
/// use undertone_engine::surround::enable_multichannel;
/// // A destination of two channels on hardware that offers sixteen: it claims eight.
/// let mut graph = LogGraph::with_max_channels(48_000.0, 2, 16);
/// assert_eq!(enable_multichannel(&mut graph), 8);
/// // Plain stereo hardware is left alone.
/// let mut stereo = LogGraph::new(48_000.0, 2);
/// assert_eq!(enable_multichannel(&mut stereo), 2);
/// ```
pub fn enable_multichannel<G: Graph>(graph: &mut G) -> u32 {
	let destination = graph.destination();
	let max = graph.destination_max_channels();
	if max > 2 {
		graph.set_channel_count(destination, max.min(MAX_CHANNELS as u32));
		graph.set_channel_interpretation(destination, ChannelInterpretation::Discrete);
	}
	graph.destination_channels()
}

/// Creates a node that folds everything played into it down to mono before `output` (the destination, by
/// default, in the reference), the way a phone speaker or a mono Bluetooth speaker plays a stereo mix. Hand
/// the node to [`Engine::play_to`](crate::engine::Engine::play_to) as the output, or put it in front of a
/// master bus, to check that a natively stereo cue still balances on one speaker.
///
/// The fold-down is Web Audio's standard speakers down-mix, `0.5 * (L + R)`: a centred voice (equal-power
/// pan, left and right at about 0.707) keeps its level, and a voice panned fully to one side drops by 6 dB.
/// The node is a gain with one channel, an explicit channel count mode, and speakers interpretation.
///
/// ```
/// use undertone_engine::graph::{Graph, LogGraph};
/// use undertone_engine::surround::create_mono_fold;
/// let mut graph = LogGraph::new(48_000.0, 2);
/// let destination = graph.destination();
/// let fold = create_mono_fold(&mut graph, destination);
/// assert_ne!(fold, destination);
/// ```
pub fn create_mono_fold<G: Graph>(graph: &mut G, output: NodeId) -> NodeId {
	let fold = graph.create_node(NodeKind::Gain);
	graph.set_channel_count(fold, 1);
	graph.set_channel_count_mode(fold, ChannelCountMode::Explicit);
	graph.set_channel_interpretation(fold, ChannelInterpretation::Speakers);
	graph.connect_node(fold, output);
	fold
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::graph::LogGraph;

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

	// The tests of `src/surround.test.ts`, ported.
	const C: usize = 2;
	const FL: usize = 0;
	const FR: usize = 1;
	const LFE: usize = 3;
	const SL: usize = 4;
	const SR: usize = 5;
	const RL: usize = 6;
	const RR: usize = 7;

	#[test]
	fn surround_hits_single_speakers_exactly_at_their_ring_angles() {
		for (angle, speaker) in [
			(0.0, C),
			(-30.0, FL),
			(30.0, FR),
			(90.0, SR),
			(-90.0, SL),
			(150.0, RR),
			(-150.0, RL),
		] {
			assert_eq!(surround_gains(angle).unwrap()[speaker], 1.0, "{angle}");
		}
	}

	#[test]
	fn surround_splits_equal_power_and_wraps_behind() {
		let gains = surround_gains(15.0).unwrap();
		assert!((gains[C] - FRAC_1_SQRT_2).abs() < 1e-10);
		assert!((gains[FR] - FRAC_1_SQRT_2).abs() < 1e-10);
		assert_eq!(gains.iter().filter(|g| **g > 0.0).count(), 2);
		let behind = surround_gains(180.0).unwrap();
		assert!((behind[RR] - FRAC_1_SQRT_2).abs() < 1e-10);
		assert!((behind[RL] - FRAC_1_SQRT_2).abs() < 1e-10);
	}

	#[test]
	fn surround_normalises_any_angle_and_conserves_power() {
		assert_eq!(
			surround_gains(390.0).unwrap(),
			surround_gains(30.0).unwrap()
		);
		assert_eq!(
			surround_gains(-330.0).unwrap(),
			surround_gains(30.0).unwrap()
		);
		let mut angle = -180.0;
		while angle <= 180.0 {
			let gains = surround_gains(angle).unwrap();
			assert_eq!(gains[LFE], 0.0, "the LFE is never routed to");
			let power: f64 = gains.iter().map(|g| g * g).sum();
			assert!((power - 1.0).abs() < 1e-10, "{angle}");
			angle += 7.0;
		}
	}

	#[test]
	fn surround_rejects_an_angle_that_is_not_finite() {
		assert_eq!(
			surround_gains(f64::NAN).unwrap_err().message(),
			"surround() angle must be a finite number, got NaN"
		);
		assert_eq!(
			surround_gains(f64::NEG_INFINITY).unwrap_err().message(),
			"surround() angle must be a finite number, got -Infinity"
		);
	}

	#[test]
	fn the_pattern_crate_and_the_engine_place_a_voice_the_same_way() {
		for angle in [-180.0, -77.5, 0.0, 12.25, 150.0, 1e9] {
			assert_eq!(
				surround_gains(angle).unwrap(),
				undertone_pattern::controls::surround_gains(angle).unwrap(),
				"{angle}"
			);
		}
	}

	#[test]
	fn fold_to_stereo_passes_stereo_through_and_folds_the_rest() {
		assert_eq!(fold_to_stereo(&[0.3, 0.7]), [0.3, 0.7]);
		let mut centre = [0.0; MAX_CHANNELS];
		centre[C] = 1.0;
		let [left, right] = fold_to_stereo(&centre);
		assert!((left - FRAC_1_SQRT_2).abs() < 1e-10 && (right - FRAC_1_SQRT_2).abs() < 1e-10);
		let mut rear_left = [0.0; MAX_CHANNELS];
		rear_left[RL] = 1.0;
		let [left, right] = fold_to_stereo(&rear_left);
		assert!((left - FRAC_1_SQRT_2).abs() < 1e-10);
		assert_eq!(right, 0.0);
		let mut side_right = [0.0; MAX_CHANNELS];
		side_right[SR] = 1.0;
		assert_eq!(fold_to_stereo(&side_right)[0], 0.0);
	}

	#[test]
	fn enable_multichannel_claims_the_hardware_up_to_eight_channels() {
		for (hardware, expected) in [(16, 8), (8, 8), (6, 6), (4, 4), (3, 3)] {
			let mut graph = LogGraph::with_max_channels(48_000.0, 2, hardware);
			assert_eq!(enable_multichannel(&mut graph), expected);
			let record = graph.finish(None);
			assert_eq!(record.channels, expected);
		}
		for hardware in [1, 2] {
			let mut graph = LogGraph::with_max_channels(48_000.0, hardware, hardware);
			assert_eq!(enable_multichannel(&mut graph), hardware);
		}
	}

	#[test]
	fn a_mono_fold_is_a_one_channel_explicit_gain_connected_to_the_output() {
		let mut graph = LogGraph::new(48_000.0, 2);
		let destination = graph.destination();
		let fold = create_mono_fold(&mut graph, destination);
		let record = graph.finish(None);
		let node = &record.nodes[fold.index()];
		assert_eq!(node.kind, "gain");
		assert_eq!(node.to, vec!["n0".to_string()]);
		let fields: Vec<_> = node.fields.iter().map(|(k, _)| k.as_str()).collect();
		assert_eq!(
			fields,
			["channelCount", "channelCountMode", "channelInterpretation"]
		);
	}
}
