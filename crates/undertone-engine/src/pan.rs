// Where a voice sits in the stereo or surround field: the panner, a pan law, a pan path, and an autopan
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Placement of a voice (`connectOutput`, `connectPanLaw`, and `scaleForPanLaw` in `src/engine.ts`, and
//! `src/panPath.ts` and `src/autopan.ts`).
//!
//! A voice is placed one of four ways:
//!
//! - **Channel gains.** One gain per speaker into a channel merger, folded down as far as the output requires.
//! - **A pan law.** One gain per side into a two-input merger, each booked with the law's gain for the pan, or
//!   for every point of the pan path, so the centre sits at the law's level instead of the stereo panner's
//!   -3 dB. A law is a level in dB from -6 to 0; the panner's own law (-3) and any value that is not a number
//!   mean the plain stereo panner.
//! - **The stereo panner.** For `pan`, a pan path, a pan slide, or an autopan. A pan path moves the pan with
//!   linear ramps between its points; a pan slide is a two-point path from `panSlideFrom` to the voice's pan.
//!   An autopan adds a low-frequency oscillator to the panner's `pan`, so the booked pan is the centre of the
//!   swing. An autopanned voice under a pan law below -3 dB keeps its panner and gets one gain after it; above
//!   -3 dB it keeps the panner's law, with a warning.
//! - **Straight through**, when nothing is set. On a destination widened by `enable_multichannel`, the plain
//!   path also goes through a two-channel merger: a bare mono connect would land in the front-left speaker only
//!   under discrete interpretation.

use crate::graph::{Graph, NodeId, NodeKind, OscillatorType, ParamId, ParamKind, Target};
use crate::math::gains::{
	PanEvent, PanEventKind, PanPoint as PathPoint, build_pan_path, pan_law_gains, pan_law_path,
	pan_law_scale,
};
use crate::math::waves::{LfoShape, autopan_wave_table};
use crate::math::{Active, js_max, js_min};
use crate::params::{AutopanShape, VoiceParams};
use crate::surround::{MAX_CHANNELS, fold_channel_gains};
use crate::warn::Warnings;

/// The pan law of a plain stereo panner: about -3 dB on each side at the centre.
pub const DEFAULT_PAN_LAW: f64 = -3.0;

/// The quietest centre a pan law may ask for, in dB.
pub const MIN_PAN_LAW: f64 = -6.0;

/// The pan law a voice asks for, checked: `None` for the plain stereo panner (no law, a law that is not a
/// finite number, or exactly -3 dB), otherwise the law clamped to -6 to 0 dB.
///
/// ```
/// use undertone_engine::pan::custom_pan_law;
/// assert_eq!(custom_pan_law(Some(-3.0)), None);
/// assert_eq!(custom_pan_law(Some(f64::NAN)), None);
/// assert_eq!(custom_pan_law(Some(-9.0)), Some(-6.0));
/// assert_eq!(custom_pan_law(Some(2.0)), Some(0.0));
/// ```
pub fn custom_pan_law(law: Option<f64>) -> Option<f64> {
	let law = law?;
	if !law.is_finite() || law == DEFAULT_PAN_LAW {
		return None;
	}
	Some(js_max(MIN_PAN_LAW, js_min(0.0, law)))
}

/// A voice's autopan, checked and filled in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AutopanSettings {
	/// LFO rate in hertz.
	pub rate: f64,
	/// Swing either side of the voice's pan, 0 to 1.
	pub depth: f64,
	/// The LFO's wave.
	pub shape: AutopanShape,
	/// Where in its cycle the LFO starts, 0 (inclusive) to 1 (exclusive).
	pub phase: f64,
}

/// The autopan a voice asks for: `None` without a positive, finite `autopan` rate. The depth is clamped to
/// 0 to 1 (default 1), an unknown shape is a sine, and the phase wraps into 0 to 1 (default 0).
///
/// ```
/// use undertone_engine::pan::autopan_settings;
/// use undertone_engine::params::VoiceParams;
///
/// let params = VoiceParams { autopan: Some(2.0), autopan_phase: Some(1.25), ..VoiceParams::empty() };
/// let settings = autopan_settings(&params).unwrap();
/// assert_eq!((settings.rate, settings.depth, settings.phase), (2.0, 1.0, 0.25));
/// assert!(autopan_settings(&VoiceParams::empty()).is_none());
/// ```
#[allow(clippy::neg_cmp_op_on_partial_ord)] // `!(x > 0)` is true for NaN, as the reference's check is
pub fn autopan_settings(params: &VoiceParams) -> Option<AutopanSettings> {
	let rate = params.autopan?;
	if !(rate > 0.0) || !rate.is_finite() {
		return None;
	}
	let depth = match params.autopan_depth {
		Some(depth) if depth.is_finite() => js_max(0.0, js_min(1.0, depth)),
		_ => 1.0,
	};
	let phase = match params.autopan_phase {
		Some(phase) if phase.is_finite() => phase - phase.floor(),
		_ => 0.0,
	};
	Some(AutopanSettings {
		rate,
		depth,
		shape: params.autopan_shape.unwrap_or(AutopanShape::Sine),
		phase,
	})
}

/// The pan path a voice moves on, in seconds from its start: its own `panPath`, or, for a pan slide, a ramp
/// from `panSlideFrom` to the voice's pan (the centre without one) over `panSlideTime` (default: the voice's
/// attack). A path and a slide together keep the path, with a warning.
pub fn voice_pan_path(params: &VoiceParams, warnings: &mut Warnings) -> Option<Vec<PathPoint>> {
	let own = params
		.pan_path
		.as_ref()
		.filter(|points| !points.is_empty())
		.map(|points| {
			points
				.iter()
				.map(|point| PathPoint {
					pan: point.pan,
					time: point.time,
				})
				.collect::<Vec<_>>()
		});
	let Some(from) = params.pan_slide_from.filter(|from| from.is_finite()) else {
		return own;
	};
	if own.is_some() {
		warnings.once(
			"panslide-and-panpath",
			"undertone: panslide() and a pan path overlap \u{2014} the path applies and the slide is ignored.",
		);
		return own;
	}
	let time = params.pan_slide_time.unwrap_or(params.attack);
	Some(vec![
		PathPoint {
			pan: from,
			time: 0.0,
		},
		PathPoint {
			pan: params.pan.unwrap_or(0.0),
			time: if time.is_finite() && time > 0.0 {
				time
			} else {
				0.0
			},
		},
	])
}

/// Books a pan path's events on a parameter: a jump for `Set`, a linear ramp for `Ramp`.
pub fn apply_pan_path<G: Graph>(graph: &mut G, param: ParamId, events: &[PanEvent]) {
	for event in events {
		match event.kind {
			PanEventKind::Set => graph.set_value_at_time(param, event.value, event.time),
			PanEventKind::Ramp => {
				graph.linear_ramp_to_value_at_time(param, event.value, event.time)
			}
		}
	}
}

/// Cuts a booked pan path short at `stop_at`: every event from then on is cancelled and the pan holds the
/// value the path had reached, so a voice stopped mid-sweep fades out where it was rather than finishing the
/// sweep. Does nothing when the path has already finished by then or the voice had not started.
pub fn stop_pan_path<G: Graph>(graph: &mut G, param: ParamId, events: &[PanEvent], stop_at: f64) {
	let Some(next) = events.iter().position(|event| event.time >= stop_at) else {
		return;
	};
	if next == 0 {
		return;
	}
	let before = events[next - 1];
	let after = events[next];
	graph.cancel_scheduled_values(param, stop_at);
	if after.kind == PanEventKind::Ramp {
		// Re-book the part of the ramp already under way, ending at the value it reaches at the stop.
		let value = before.value
			+ ((after.value - before.value) * (stop_at - before.time)) / (after.time - before.time);
		graph.linear_ramp_to_value_at_time(param, value, stop_at);
	} else {
		graph.set_value_at_time(param, before.value, stop_at);
	}
}

/// Gives `lfo` its shape, started `phase` of a cycle in. Phase 0 uses the built-in oscillator type; any other
/// phase uses a periodic wave of the same series with every harmonic turned by a pure time shift.
fn shape_lfo<G: Graph>(graph: &mut G, lfo: NodeId, shape: AutopanShape, phase: f64) {
	let (kind, wave) = match shape {
		AutopanShape::Sine => (OscillatorType::Sine, LfoShape::Sine),
		AutopanShape::Triangle => (OscillatorType::Triangle, LfoShape::Triangle),
		AutopanShape::Square => (OscillatorType::Square, LfoShape::Square),
	};
	graph.set_oscillator_type(lfo, kind);
	if phase == 0.0 {
		return;
	}
	let table = autopan_wave_table::<Active>(wave, phase);
	let wave = graph.create_periodic_wave(&table.real, &table.imag, false);
	graph.set_periodic_wave(lfo, wave);
}

/// Adds an autopan LFO to a panner's `pan`: an oscillator at `rate` hertz into a depth gain into the
/// parameter. Web Audio adds a connected node's output to the parameter's own value, so the booked pan is
/// the centre of the swing, and the panner clamps the sum to -1 to 1. Returns the oscillator, which the
/// caller starts and stops with the voice.
pub(crate) fn connect_autopan<G: Graph>(
	graph: &mut G,
	pan: ParamId,
	settings: AutopanSettings,
	voice_start: f64,
) -> NodeId {
	let lfo = graph.create_node(NodeKind::Oscillator);
	shape_lfo(graph, lfo, settings.shape, settings.phase);
	let frequency = graph.param(lfo, ParamKind::Frequency);
	graph.set_value_at_time(frequency, settings.rate, voice_start);
	let depth = graph.create_node(NodeKind::Gain);
	let depth_gain = graph.param(depth, ParamKind::Gain);
	graph.set_value_at_time(depth_gain, settings.depth, voice_start);
	graph.connect_node(lfo, depth);
	graph.connect(depth, Target::Param(pan), 0, 0);
	lfo
}

/// What placement made: the voice's last node, and the pan paths it booked, so a stop can cut them short.
#[derive(Debug, Clone)]
pub(crate) struct Placement {
	pub(crate) node: NodeId,
	pub(crate) pan_paths: Vec<(ParamId, Vec<PanEvent>)>,
}

/// Places a voice under a pan law other than the stereo panner's: one gain per side into a two-input merger.
fn connect_pan_law<G: Graph>(
	graph: &mut G,
	output: NodeId,
	gain_node: NodeId,
	pan: Option<f64>,
	path: Option<&[PathPoint]>,
	voice_start: f64,
	law: f64,
) -> Placement {
	let merger = graph.create_node(NodeKind::ChannelMerger { inputs: 2 });
	let left = graph.create_node(NodeKind::Gain);
	let right = graph.create_node(NodeKind::Gain);
	let left_gain = graph.param(left, ParamKind::Gain);
	let right_gain = graph.param(right, ParamKind::Gain);
	let mut pan_paths = Vec::new();
	if let Some(path) = path {
		let (left_events, right_events) =
			pan_law_path::<Active>(&build_pan_path(path, voice_start), law);
		apply_pan_path(graph, left_gain, &left_events);
		apply_pan_path(graph, right_gain, &right_events);
		pan_paths.push((left_gain, left_events));
		pan_paths.push((right_gain, right_events));
	} else {
		let gains = pan_law_gains::<Active>(pan.unwrap_or(0.0), law);
		graph.set_value_at_time(left_gain, gains.left, voice_start);
		graph.set_value_at_time(right_gain, gains.right, voice_start);
	}
	graph.connect_node(gain_node, left);
	graph.connect_node(gain_node, right);
	graph.connect(left, Target::Node(merger), 0, 0);
	graph.connect(right, Target::Node(merger), 0, 1);
	graph.connect_node(merger, output);
	Placement {
		node: merger,
		pan_paths,
	}
}

/// An autopanned voice keeps its stereo panner, so the LFO has a `pan` to drive. A law below -3 dB is the
/// panner's curve scaled by `sqrt(2) * 10^(law/20)`, exact at every pan, so one gain after the panner gives
/// it. A law above -3 dB caps each side at full, which no gain can do on a moving pan, so the voice keeps the
/// panner's law, with a warning.
fn scale_for_pan_law<G: Graph>(
	graph: &mut G,
	warnings: &mut Warnings,
	panner: NodeId,
	law: f64,
	voice_start: f64,
) -> NodeId {
	let scale = pan_law_scale::<Active>(law);
	if scale >= 1.0 {
		warnings.once(
			"autopan-pan-law",
			format!(
				"undertone: an autopanned voice keeps the stereo panner's -3 dB law; a pan law above -3 dB (got {}) cannot follow a moving pan.",
				undertone_pattern::js::number_to_string(law)
			),
		);
		return panner;
	}
	let level = graph.create_node(NodeKind::Gain);
	let level_gain = graph.param(level, ParamKind::Gain);
	graph.set_value_at_time(level_gain, scale, voice_start);
	graph.connect_node(panner, level);
	level
}

/// Routes the enveloped voice to `output` (`connectOutput`); see the [module documentation](self) for the
/// four ways. `stoppables` gets an autopan LFO, which the caller stops with the voice.
#[allow(clippy::too_many_arguments)]
pub(crate) fn connect_output<G: Graph>(
	graph: &mut G,
	warnings: &mut Warnings,
	output: NodeId,
	available: usize,
	gain_node: NodeId,
	params: &VoiceParams,
	voice_start: f64,
	voice_end: f64,
	stoppables: &mut Vec<NodeId>,
) -> Placement {
	let mut placement: Option<Vec<f64>> = params
		.channel_gains
		.as_ref()
		.map(|gains| gains.iter().take(MAX_CHANNELS).copied().collect());
	if placement.as_ref().is_some_and(Vec::is_empty) {
		placement = None;
	}

	let path = if placement.is_none() {
		voice_pan_path(params, warnings)
	} else {
		None
	};
	let autopan = if placement.is_none() {
		autopan_settings(params)
	} else {
		None
	};
	let pan_law = custom_pan_law(params.pan_law);
	let panned = params.pan.is_some() || path.is_some() || autopan.is_some();
	if placement.is_none()
		&& panned
		&& autopan.is_none()
		&& let Some(law) = pan_law
	{
		return connect_pan_law(
			graph,
			output,
			gain_node,
			params.pan,
			path.as_deref(),
			voice_start,
			law,
		);
	}
	if placement.is_none() && panned {
		let panner = graph.create_node(NodeKind::StereoPanner);
		let pan = graph.param(panner, ParamKind::Pan);
		let mut pan_paths = Vec::new();
		if let Some(path) = &path {
			let events = build_pan_path(path, voice_start);
			apply_pan_path(graph, pan, &events);
			pan_paths.push((pan, events));
		} else {
			graph.set_value_at_time(pan, params.pan.unwrap_or(0.0), voice_start);
		}
		graph.connect_node(gain_node, panner);
		let mut last = panner;
		if let Some(settings) = autopan {
			let lfo = connect_autopan(graph, pan, settings, voice_start);
			graph.start(lfo, voice_start);
			graph.stop(lfo, voice_end);
			stoppables.push(lfo);
			if let Some(law) = pan_law {
				last = scale_for_pan_law(graph, warnings, panner, law, voice_start);
			}
		}
		graph.connect_node(last, output);
		return Placement {
			node: last,
			pan_paths,
		};
	}

	let mut gains = match placement {
		Some(gains) => gains,
		None => {
			if available <= 2 {
				graph.connect_node(gain_node, output);
				return Placement {
					node: gain_node,
					pan_paths: Vec::new(),
				};
			}
			vec![1.0, 1.0] // a centred stereo image, matching the spec's mono to stereo up-mix
		}
	};
	while gains.len() < 2 {
		gains.push(0.0); // a one-channel merger would up-mix to both speakers, ignoring the placement
	}
	let gains = fold_channel_gains(&gains, available);
	let merger = graph.create_node(NodeKind::ChannelMerger {
		inputs: gains.len() as u32,
	});
	for (channel, level) in gains.iter().enumerate() {
		if *level > 0.0 {
			let channel_gain = graph.create_node(NodeKind::Gain);
			let param = graph.param(channel_gain, ParamKind::Gain);
			graph.set_value_at_time(param, *level, voice_start);
			graph.connect_node(gain_node, channel_gain);
			graph.connect(channel_gain, Target::Node(merger), 0, channel as u32);
		}
	}
	graph.connect_node(merger, output);
	Placement {
		node: merger,
		pan_paths: Vec::new(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::params::PanPoint;

	#[test]
	fn a_slide_defaults_to_the_attack_and_ends_on_the_pan() {
		let params = VoiceParams {
			pan_slide_from: Some(-1.0),
			pan: Some(0.5),
			attack: 0.2,
			..VoiceParams::empty()
		};
		let path = voice_pan_path(&params, &mut Warnings::default()).unwrap();
		assert_eq!(
			path,
			[
				PathPoint {
					pan: -1.0,
					time: 0.0
				},
				PathPoint {
					pan: 0.5,
					time: 0.2
				}
			]
		);
	}

	#[test]
	fn a_path_beats_a_slide_with_a_warning() {
		let params = VoiceParams {
			pan_slide_from: Some(-1.0),
			pan_path: Some(vec![PanPoint {
				time: 0.0,
				pan: 1.0,
			}]),
			..VoiceParams::empty()
		};
		let mut warnings = Warnings::default();
		let path = voice_pan_path(&params, &mut warnings).unwrap();
		assert_eq!(path.len(), 1);
		assert_eq!(warnings.all()[0].key, "panslide-and-panpath");
	}

	#[test]
	fn autopan_needs_a_positive_finite_rate() {
		for rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
			let params = VoiceParams {
				autopan: Some(rate),
				..VoiceParams::empty()
			};
			assert!(autopan_settings(&params).is_none(), "{rate}");
		}
	}
}
