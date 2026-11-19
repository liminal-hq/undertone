// The master bus: a gain stage, a limiter, and an optional hard ceiling between the voices and the speakers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`create_master_bus`] (`createMasterBus` in `src/masterBus.ts`).
//!
//! Voices play into the bus's input, pass a gain stage and a limiter, and reach the output (the speakers by
//! default). Undertone writes straight to the destination otherwise, so a dense mix can peak near or above
//! full scale; the bus keeps it in range.
//!
//! The limiter is a fast, high-ratio compressor. It is skipped, with a warning, when the output has more than
//! two channels (a dynamics compressor handles stereo only, so it would fold a surround mix down); the gain
//! stage still works. Browsers' compressors add automatic makeup gain; with `compensate` on (the default) a gain
//! stage after the compressor takes it back out, so the threshold really is near the ceiling. The
//! compensation is worked out for a hard knee at full-scale input, so it is approximate when `knee` is above 0.
//!
//! **The ceiling** is a hard ceiling in dBFS (0 or below), the last stage of the bus: a wave shaper that
//! passes every sample below the ceiling unchanged and clips any sample above it to the ceiling, so the output
//! never exceeds it. It catches the transients the limiter's attack lets through, works with or without the
//! limiter and on any number of channels, and bounds sample values, not the peaks between samples. The default
//! is no ceiling, and no node.

use crate::graph::{Graph, NodeId, NodeKind, Oversample, ParamKind};
use crate::math::{js_max, js_min, js_pow};
use crate::warn::Warnings;
use undertone_pattern::js::number_to_string;
use undertone_pattern::{Error, Result};

/// Settings for the bus's limiter. Every field left `None` takes the default.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LimiterOptions {
	/// Level in dB above which gain reduction starts. Default -2.
	pub threshold: Option<f64>,
	/// dB range over which the reduction eases in. Default 0 (a hard knee).
	pub knee: Option<f64>,
	/// Compression ratio; 20 is close to brick-wall. Default 20.
	pub ratio: Option<f64>,
	/// Seconds the limiter takes to clamp down on a peak. Default 0.003.
	pub attack: Option<f64>,
	/// Seconds the limiter takes to let go afterwards. Default 0.1.
	pub release: Option<f64>,
	/// Whether a gain stage takes the compressor's automatic makeup back out. Default `true`.
	pub compensate: Option<bool>,
}

/// The limiter of a master bus: `limiter` in the TypeScript options (`true`, `false`, or an object).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum Limiter {
	/// The default limiter (`true`).
	#[default]
	Default,
	/// No limiter, gain only (`false`).
	Off,
	/// A tuned limiter.
	Tuned(LimiterOptions),
}

/// Options of [`create_master_bus`].
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MasterBusOptions {
	/// Where the bus sends its signal. Default the destination.
	pub output: Option<NodeId>,
	/// Output level multiplier applied before the limiter. Default 1.
	pub gain: Option<f64>,
	/// The limiter. Default [`Limiter::Default`].
	pub limiter: Limiter,
	/// A hard ceiling in dBFS (0 or below). Default none.
	pub ceiling: Option<f64>,
}

/// The nodes of a master bus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MasterBus {
	/// Pass this as the output of voices; its `gain` parameter is the bus level.
	pub input: NodeId,
	/// The limiter, when one is in the path.
	pub compressor: Option<NodeId>,
	/// The ceiling's clip, when a ceiling is set.
	pub clipper: Option<NodeId>,
}

const DEFAULT_THRESHOLD: f64 = -2.0;
const DEFAULT_KNEE: f64 = 0.0;
const DEFAULT_RATIO: f64 = 20.0;
const DEFAULT_ATTACK: f64 = 0.003;
const DEFAULT_RELEASE: f64 = 0.1;

/// A compressor's automatic makeup gain, as implemented in WebKit, Blink, and Gecko: the reciprocal of the
/// gain a full-scale (0 dB) input would be left with, raised to 0.6.
const MAKEUP_EXPONENT: f64 = 0.6;

/// The linear gain that cancels the compressor's automatic makeup for a hard knee.
#[allow(clippy::neg_cmp_op_on_partial_ord)] // `!(x > 0)` is true for NaN, as the reference's check is
pub fn makeup_compensation(threshold_db: f64, ratio: f64) -> f64 {
	if !(threshold_db < 0.0) || !(ratio > 1.0) {
		return 1.0; // nothing above the threshold is reduced, so no makeup is added
	}
	let full_scale_out_db = threshold_db + (0.0 - threshold_db) / ratio;
	let full_scale_gain = js_pow(10.0, full_scale_out_db / 20.0);
	js_pow(1.0 / full_scale_gain, -MAKEUP_EXPONENT)
}

/// Points in the ceiling's curve: odd, so 0 maps to exactly 0, and fine enough that the knee is sharp.
const CEILING_CURVE_POINTS: usize = 4097;

/// The clip curve for a ceiling at `level` (linear, 0 to 1): the identity, clamped to the largest magnitude
/// the ceiling allows ([`ceiling_top`]).
///
/// A wave shaper maps input -1..1 onto the curve by linear interpolation and holds the end values beyond it,
/// so input past full scale comes out at the ceiling too. Because the clamp is concave above zero (and convex
/// below), interpolating between points never overshoots the level.
pub fn ceiling_curve(level: f64) -> Vec<f32> {
	let top = ceiling_top(level);
	let last = (CEILING_CURVE_POINTS - 1) as f64;
	(0..CEILING_CURVE_POINTS)
		.map(|i| {
			let identity = (2.0 * i as f64) / last - 1.0;
			js_max(-top, js_min(top, identity)) as f32
		})
		.collect()
}

/// The largest magnitude the ceiling lets through for a ceiling of `level` (linear): one float32 step below
/// it, as the clip curve's flat part is. A wave shaper interpolates in float32, and blending two equal points
/// can round up by one step, so the flat part sits a step low to land at or under the ceiling all the same.
/// Code that bounds samples outside the graph, such as an offline render after it folds a tail, uses this to
/// clamp to exactly what the bus does.
pub fn ceiling_top(level: f64) -> f64 {
	let mut word = level as f32;
	let mut bits = word.to_bits();
	if f64::from(word) > level {
		bits = bits.wrapping_sub(1); // positive floats order like their bits
	}
	bits = bits.wrapping_sub(1);
	word = f32::from_bits(bits);
	f64::from(word)
}

/// Puts the ceiling's clip between `from` and `output` when there is one, and returns it.
fn connect_ceiling<G: Graph>(
	graph: &mut G,
	from: NodeId,
	output: NodeId,
	ceiling: Option<f64>,
) -> Option<NodeId> {
	let Some(ceiling) = ceiling else {
		graph.connect_node(from, output);
		return None;
	};
	let clipper = graph.create_node(NodeKind::WaveShaper);
	let curve = graph.create_curve(&ceiling_curve(js_pow(10.0, ceiling / 20.0)));
	graph.set_curve(clipper, Some(curve));
	graph.set_oversample(clipper, Oversample::None);
	graph.connect_node(from, clipper);
	graph.connect_node(clipper, output);
	Some(clipper)
}

/// The channel count of an output node: the destination's, and two for any other node (a Web Audio gain node's
/// default).
pub(crate) fn output_channels<G: Graph>(graph: &G, output: NodeId) -> u32 {
	if output == graph.destination() {
		graph.destination_channels()
	} else {
		2
	}
}

/// Creates a master bus on `graph`: voices play into [`MasterBus::input`], pass a gain stage and a limiter,
/// and reach the output.
///
/// Nothing is created until this is called, and the bus is an ordinary value the caller holds, so a game
/// with several mix groups can make one per group.
///
/// # Errors
///
/// Fails, before any node is made, with the reference's message when `gain` is negative (or `NaN`), when
/// `ceiling` is above 0 dBFS (or `NaN`), or when `ceiling` is negative infinity.
///
/// ```
/// use undertone_engine::graph::LogGraph;
/// use undertone_engine::master::{MasterBusOptions, create_master_bus};
/// use undertone_engine::warn::Warnings;
///
/// let mut graph = LogGraph::new(44_100.0, 2);
/// let bus = create_master_bus(&mut graph, &mut Warnings::default(), MasterBusOptions::default())?;
/// assert!(bus.compressor.is_some() && bus.clipper.is_none());
/// let record = graph.finish(None);
/// assert_eq!(record.counts.last().unwrap().1, 4); // destination, input gain, compressor, makeup gain
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
#[allow(clippy::neg_cmp_op_on_partial_ord)] // `!(x > 0)` is true for NaN, as the reference's check is
pub fn create_master_bus<G: Graph>(
	graph: &mut G,
	warnings: &mut Warnings,
	options: MasterBusOptions,
) -> Result<MasterBus> {
	let output = options.output.unwrap_or_else(|| graph.destination());
	let level = options.gain.unwrap_or(1.0);
	if !(level >= 0.0) {
		return Err(Error::new(format!(
			"createMasterBus() gain must not be negative, got {}",
			number_to_string(level)
		)));
	}
	let ceiling = options.ceiling;
	if let Some(ceiling) = ceiling {
		if !(ceiling <= 0.0) {
			return Err(Error::new(format!(
				"createMasterBus() ceiling must be 0 dBFS or below, got {}",
				number_to_string(ceiling)
			)));
		}
		if ceiling == f64::NEG_INFINITY {
			return Err(Error::new(
				"createMasterBus() ceiling must be a finite level in dBFS",
			));
		}
	}

	let now = graph.current_time();
	let input = graph.create_node(NodeKind::Gain);
	let input_gain = graph.param(input, ParamKind::Gain);
	graph.set_value_at_time(input_gain, level, now);
	let finish = |graph: &mut G, from: NodeId, compressor: Option<NodeId>| {
		let clipper = connect_ceiling(graph, from, output, ceiling);
		MasterBus {
			input,
			compressor,
			clipper,
		}
	};

	let tuned = match options.limiter {
		Limiter::Off => return Ok(finish(graph, input, None)),
		Limiter::Default => LimiterOptions::default(),
		Limiter::Tuned(tuned) => tuned,
	};

	let channels = output_channels(graph, output);
	if channels > 2 {
		warnings.once(
			"master-bus-surround",
			format!(
				"undertone: the master bus limiter is skipped because the output has {channels} channels; a compressor would fold it to stereo."
			),
		);
		return Ok(finish(graph, input, None));
	}

	let threshold = tuned.threshold.unwrap_or(DEFAULT_THRESHOLD);
	let knee = tuned.knee.unwrap_or(DEFAULT_KNEE);
	let ratio = tuned.ratio.unwrap_or(DEFAULT_RATIO);
	let attack = tuned.attack.unwrap_or(DEFAULT_ATTACK);
	let release = tuned.release.unwrap_or(DEFAULT_RELEASE);
	let compensate = tuned.compensate.unwrap_or(true);

	let compressor = graph.create_node(NodeKind::DynamicsCompressor);
	for (kind, value) in [
		(ParamKind::Threshold, threshold),
		(ParamKind::Knee, knee),
		(ParamKind::Ratio, ratio),
		(ParamKind::Attack, attack),
		(ParamKind::Release, release),
	] {
		let param = graph.param(compressor, kind);
		graph.set_value_at_time(param, value, now);
	}
	graph.connect_node(input, compressor);
	if compensate {
		let makeup = graph.create_node(NodeKind::Gain);
		let makeup_gain = graph.param(makeup, ParamKind::Gain);
		graph.set_value_at_time(makeup_gain, makeup_compensation(threshold, ratio), now);
		graph.connect_node(compressor, makeup);
		return Ok(finish(graph, makeup, Some(compressor)));
	}
	Ok(finish(graph, compressor, Some(compressor)))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::graph::LogGraph;

	#[test]
	fn the_default_makeup_is_the_recorded_one() {
		let makeup = makeup_compensation(-2.0, 20.0);
		assert!((makeup - 0.877_000_821).abs() < 1e-9, "{makeup}");
	}

	#[test]
	fn no_reduction_means_no_compensation() {
		assert_eq!(makeup_compensation(0.0, 20.0), 1.0);
		assert_eq!(makeup_compensation(-6.0, 1.0), 1.0);
		assert_eq!(makeup_compensation(f64::NAN, 20.0), 1.0);
	}

	#[test]
	fn the_ceiling_sits_a_float_step_below_the_level() {
		let top = ceiling_top(1.0);
		assert_eq!(top, f64::from(f32::from_bits(1.0_f32.to_bits() - 1)));
		assert!(top < 1.0);
		let curve = ceiling_curve(1.0);
		assert_eq!(curve.len(), 4097);
		assert_eq!(curve[2048], 0.0);
		assert_eq!(f64::from(curve[0]), -top);
	}

	#[test]
	fn a_bad_gain_or_ceiling_fails_before_any_node() {
		let mut graph = LogGraph::new(44_100.0, 2);
		let mut warnings = Warnings::default();
		let bad = |gain, ceiling| MasterBusOptions {
			gain,
			ceiling,
			..MasterBusOptions::default()
		};
		assert_eq!(
			create_master_bus(&mut graph, &mut warnings, bad(Some(-1.0), None))
				.unwrap_err()
				.message(),
			"createMasterBus() gain must not be negative, got -1"
		);
		assert_eq!(
			create_master_bus(&mut graph, &mut warnings, bad(None, Some(3.0)))
				.unwrap_err()
				.message(),
			"createMasterBus() ceiling must be 0 dBFS or below, got 3"
		);
		assert_eq!(
			create_master_bus(&mut graph, &mut warnings, bad(None, Some(f64::NAN)))
				.unwrap_err()
				.message(),
			"createMasterBus() ceiling must be 0 dBFS or below, got NaN"
		);
		assert_eq!(
			create_master_bus(
				&mut graph,
				&mut warnings,
				bad(None, Some(f64::NEG_INFINITY))
			)
			.unwrap_err()
			.message(),
			"createMasterBus() ceiling must be a finite level in dBFS"
		);
		assert_eq!(graph.finish(None).nodes.len(), 1);
	}
}
