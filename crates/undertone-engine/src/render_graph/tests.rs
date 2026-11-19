// Tests of the render graph: nodes, automation, streaming, and determinism
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::*;

const RATE: f64 = 48_000.0;

fn rms(samples: &[f32]) -> f64 {
	(samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
}

fn peak(samples: &[f32]) -> f32 {
	samples.iter().fold(0.0, |m, s| m.max(s.abs()))
}

fn osc_to_destination(graph: &mut RenderGraph, hertz: f64) -> NodeId {
	let osc = graph.create_node(NodeKind::Oscillator);
	let frequency = graph.param(osc, ParamKind::Frequency);
	graph.set_value_at_time(frequency, hertz, 0.0);
	graph.connect_node(osc, graph.destination());
	graph.start(osc, 0.0);
	osc
}

#[test]
fn a_sine_has_the_expected_rms_and_peak() {
	let mut graph = RenderGraph::new(RATE, 1, 48_000);
	osc_to_destination(&mut graph, 1_000.0);
	let out = graph.render_all();
	assert!((rms(&out[0]) - core::f64::consts::FRAC_1_SQRT_2).abs() < 1e-4);
	assert!((peak(&out[0]) - 1.0).abs() < 1e-3);
	// It starts at phase zero.
	assert_eq!(out[0][0], 0.0);
	assert!(
		(f64::from(out[0][12]) - 1.0).abs() < 1e-3,
		"a quarter cycle in"
	);
}

#[test]
fn a_mono_source_fills_both_stereo_channels() {
	let mut graph = RenderGraph::new(RATE, 2, 4_800);
	osc_to_destination(&mut graph, 440.0);
	let out = graph.render_all();
	assert_eq!(out[0], out[1]);
}

/// One over the peak of a many-partial square or sawtooth sum (the Gibbs overshoot, 1.179).
const GIBBS_SCALE: f64 = 0.848;

#[test]
fn the_other_oscillator_types_have_their_waveform_levels() {
	let level = |kind: OscillatorType| {
		let mut graph = RenderGraph::new(RATE, 1, 48_000);
		let osc = osc_to_destination(&mut graph, 100.0);
		graph.set_oscillator_type(osc, kind);
		rms(&graph.render_all()[0])
	};
	// The ideal RMS of a square is 1, of a triangle and a sawtooth 1 over root 3; the square and the sawtooth are
	// scaled by the table's normalisation, one over the Gibbs overshoot of their partial sums (about 0.848).
	assert!((level(OscillatorType::Square) - GIBBS_SCALE).abs() < 0.01);
	assert!((level(OscillatorType::Triangle) - 1.0 / 3.0_f64.sqrt()).abs() < 0.01);
	assert!((level(OscillatorType::Sawtooth) - GIBBS_SCALE / 3.0_f64.sqrt()).abs() < 0.01);
}

#[test]
fn a_periodic_wave_plays_its_partials() {
	let mut graph = RenderGraph::new(RATE, 1, 48_000);
	let osc = osc_to_destination(&mut graph, 1_000.0);
	// The second partial only, unnormalised at 0.5: a 2 kHz sine of amplitude 0.5.
	let wave = graph.create_periodic_wave(&[0.0, 0.0, 0.0], &[0.0, 0.0, 0.5], true);
	graph.set_periodic_wave(osc, wave);
	let out = graph.render_all();
	assert!((peak(&out[0]) - 0.5).abs() < 1e-3);
	let crossings = out[0]
		.windows(2)
		.filter(|w| w[0] < 0.0 && w[1] >= 0.0)
		.count();
	assert!((1999..=2001).contains(&crossings), "{crossings}");
}

#[test]
fn an_oscillator_does_not_alias_near_nyquist() {
	let mut graph = RenderGraph::new(RATE, 1, 48_000);
	let osc = osc_to_destination(&mut graph, 13_000.0);
	graph.set_oscillator_type(osc, OscillatorType::Sawtooth);
	let out = graph.render_all();
	// At 13 kHz only the fundamental fits below 24 kHz (a second partial at 26 kHz would fold back): the output is a plain sine of amplitude 2/pi, normalised.
	let expected = 2.0 / core::f64::consts::PI * GIBBS_SCALE;
	assert!((f64::from(peak(&out[0])) - expected).abs() < 5e-3);
}

#[test]
fn start_and_stop_land_on_their_frames() {
	let mut graph = RenderGraph::new(1_000.0, 1, 1_000);
	let osc = graph.create_node(NodeKind::Oscillator);
	graph.connect_node(osc, graph.destination());
	let frequency = graph.param(osc, ParamKind::Frequency);
	graph.set_value_at_time(frequency, 250.0, 0.0);
	graph.start(osc, 0.2);
	graph.stop(osc, 0.4);
	let out = graph.render_all();
	assert!(out[0][..200].iter().all(|s| *s == 0.0));
	assert!(out[0][200..400].iter().any(|s| s.abs() > 0.5));
	assert!(out[0][400..].iter().all(|s| *s == 0.0));
}

#[test]
fn a_gain_ramp_scales_a_constant_source() {
	// A buffer source of ones, through a gain that ramps 0 to 1 over a second.
	let mut graph = RenderGraph::new(1_000.0, 1, 1_000);
	let buffer = graph.create_buffer(1, 1, 1_000.0);
	graph.buffer_channel_mut(buffer, 0)[0] = 1.0;
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(buffer));
	graph.set_loop(source, true);
	let gain = graph.create_node(NodeKind::Gain);
	let level = graph.param(gain, ParamKind::Gain);
	graph.set_value_at_time(level, 0.0, 0.0);
	graph.linear_ramp_to_value_at_time(level, 1.0, 1.0);
	graph.connect_node(source, gain);
	graph.connect_node(gain, graph.destination());
	graph.start(source, 0.0);
	let out = graph.render_all();
	for frame in [0, 1, 100, 500, 999] {
		assert!(
			(f64::from(out[0][frame]) - frame as f64 / 1000.0).abs() < 1e-6,
			"frame {frame}: {}",
			out[0][frame]
		);
	}
}

#[test]
fn gain_automation_with_set_target_decays_exponentially() {
	let mut graph = RenderGraph::new(1_000.0, 1, 1_000);
	let buffer = graph.create_buffer(1, 1, 1_000.0);
	graph.buffer_channel_mut(buffer, 0)[0] = 1.0;
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(buffer));
	graph.set_loop(source, true);
	let gain = graph.create_node(NodeKind::Gain);
	let level = graph.param(gain, ParamKind::Gain);
	graph.set_value_at_time(level, 1.0, 0.0);
	graph.set_target_at_time(level, 0.0, 0.1, 0.1);
	graph.connect_node(source, gain);
	graph.connect_node(gain, graph.destination());
	graph.start(source, 0.0);
	let out = graph.render_all();
	assert_eq!(out[0][99], 1.0);
	// One time constant after the target starts: 1/e.
	assert!((f64::from(out[0][200]) - (-1.0_f64).exp()).abs() < 1e-6);
}

#[test]
fn a_connected_signal_modulates_a_parameter() {
	// A constant 0.5 added to a gain of 0.25 makes 0.75.
	let mut graph = RenderGraph::new(1_000.0, 1, 256);
	let ones = graph.create_buffer(1, 1, 1_000.0);
	graph.buffer_channel_mut(ones, 0)[0] = 1.0;
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(ones));
	graph.set_loop(source, true);
	let half = graph.create_node(NodeKind::Gain);
	let half_level = graph.param(half, ParamKind::Gain);
	graph.set_value_at_time(half_level, 0.5, 0.0);
	let gain = graph.create_node(NodeKind::Gain);
	let level = graph.param(gain, ParamKind::Gain);
	graph.set_value_at_time(level, 0.25, 0.0);
	graph.connect_node(source, gain);
	graph.connect_node(source, half);
	graph.connect(half, Target::Param(level), 0, 0);
	graph.connect_node(gain, graph.destination());
	graph.start(source, 0.0);
	let out = graph.render_all();
	assert!((out[0][200] - 0.75).abs() < 1e-6);
}

#[test]
fn the_panner_is_equal_power() {
	let render = |pan: f64| {
		let mut graph = RenderGraph::new(1_000.0, 2, 256);
		let ones = graph.create_buffer(1, 1, 1_000.0);
		graph.buffer_channel_mut(ones, 0)[0] = 1.0;
		let source = graph.create_node(NodeKind::BufferSource);
		graph.set_buffer(source, Some(ones));
		graph.set_loop(source, true);
		let panner = graph.create_node(NodeKind::StereoPanner);
		let position = graph.param(panner, ParamKind::Pan);
		graph.set_value_at_time(position, pan, 0.0);
		graph.connect_node(source, panner);
		graph.connect_node(panner, graph.destination());
		graph.start(source, 0.0);
		let out = graph.render_all();
		(f64::from(out[0][200]), f64::from(out[1][200]))
	};
	let (l, r) = render(0.0);
	assert!((l - 0.5_f64.sqrt()).abs() < 1e-6 && (r - 0.5_f64.sqrt()).abs() < 1e-6);
	let (l, r) = render(-1.0);
	assert!((l - 1.0).abs() < 1e-6 && r.abs() < 1e-6);
	let (l, r) = render(1.0);
	assert!(l.abs() < 1e-6 && (r - 1.0).abs() < 1e-6);
	let (l, r) = render(0.5);
	assert!((l * l + r * r - 1.0).abs() < 1e-6);
}

#[test]
fn the_merger_routes_each_input_to_its_channel() {
	let mut graph = RenderGraph::new(1_000.0, 2, 256);
	let ones = graph.create_buffer(1, 1, 1_000.0);
	graph.buffer_channel_mut(ones, 0)[0] = 1.0;
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(ones));
	graph.set_loop(source, true);
	let quiet = graph.create_node(NodeKind::Gain);
	let level = graph.param(quiet, ParamKind::Gain);
	graph.set_value_at_time(level, 0.25, 0.0);
	let merger = graph.create_node(NodeKind::ChannelMerger { inputs: 2 });
	// The source into the second input, a quieter copy into the first.
	graph.connect(source, Target::Node(merger), 0, 1);
	graph.connect_node(source, quiet);
	graph.connect(quiet, Target::Node(merger), 0, 0);
	graph.connect_node(merger, graph.destination());
	graph.start(source, 0.0);
	let out = graph.render_all();
	assert!((out[0][200] - 0.25).abs() < 1e-6 && (out[1][200] - 1.0).abs() < 1e-6);
}

#[test]
fn the_destination_down_mixes_and_up_mixes() {
	// Stereo content into a mono destination averages; mono into six channels goes to the centre.
	let mut graph = RenderGraph::new(1_000.0, 1, 256);
	let ones = graph.create_buffer(2, 1, 1_000.0);
	graph.buffer_channel_mut(ones, 0)[0] = 1.0;
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(ones));
	graph.set_loop(source, true);
	graph.connect_node(source, graph.destination());
	graph.start(source, 0.0);
	assert!((graph.render_all()[0][200] - 0.5).abs() < 1e-6);

	let mut graph = RenderGraph::new(1_000.0, 6, 256);
	let ones = graph.create_buffer(1, 1, 1_000.0);
	graph.buffer_channel_mut(ones, 0)[0] = 1.0;
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(ones));
	graph.set_loop(source, true);
	graph.connect_node(source, graph.destination());
	graph.start(source, 0.0);
	let out = graph.render_all();
	let column: Vec<f32> = out.iter().map(|c| c[200]).collect();
	assert_eq!(column, [0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
}

#[test]
fn discrete_destination_keeps_channels_apart() {
	let mut graph = RenderGraph::new(1_000.0, 4, 256);
	graph.set_channel_interpretation(graph.destination(), ChannelInterpretation::Discrete);
	let ones = graph.create_buffer(1, 1, 1_000.0);
	graph.buffer_channel_mut(ones, 0)[0] = 1.0;
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(ones));
	graph.set_loop(source, true);
	graph.connect_node(source, graph.destination());
	graph.start(source, 0.0);
	let out = graph.render_all();
	let column: Vec<f32> = out.iter().map(|c| c[200]).collect();
	assert_eq!(column, [1.0, 0.0, 0.0, 0.0]);
}

/// A varied graph: an FM pair into a gain envelope and a panner.
fn busy_graph(length: u64) -> RenderGraph {
	let mut graph = RenderGraph::new(RATE, 2, length);
	let carrier = graph.create_node(NodeKind::Oscillator);
	let modulator = graph.create_node(NodeKind::Oscillator);
	let depth = graph.create_node(NodeKind::Gain);
	let gain = graph.create_node(NodeKind::Gain);
	let panner = graph.create_node(NodeKind::StereoPanner);
	let carrier_frequency = graph.param(carrier, ParamKind::Frequency);
	graph.set_value_at_time(carrier_frequency, 330.0, 0.0);
	graph.exponential_ramp_to_value_at_time(carrier_frequency, 220.0, 0.3);
	let modulator_frequency = graph.param(modulator, ParamKind::Frequency);
	graph.set_value_at_time(modulator_frequency, 165.0, 0.0);
	let depth_level = graph.param(depth, ParamKind::Gain);
	graph.set_value_at_time(depth_level, 80.0, 0.0);
	graph.connect_node(modulator, depth);
	graph.connect(depth, Target::Param(carrier_frequency), 0, 0);
	let level = graph.param(gain, ParamKind::Gain);
	graph.set_value_at_time(level, 0.0, 0.0);
	graph.linear_ramp_to_value_at_time(level, 0.5, 0.01);
	graph.set_target_at_time(level, 0.0, 0.2, 0.05);
	let position = graph.param(panner, ParamKind::Pan);
	graph.set_value_at_time(position, -0.4, 0.0);
	graph.linear_ramp_to_value_at_time(position, 0.8, 0.5);
	graph.connect_node(carrier, gain);
	graph.connect_node(gain, panner);
	graph.connect_node(panner, graph.destination());
	graph.set_oscillator_type(carrier, OscillatorType::Sawtooth);
	graph.start(carrier, 0.0);
	graph.start(modulator, 0.0);
	graph.stop(carrier, 0.6);
	graph.stop(modulator, 0.6);
	graph
}

fn render_in_blocks(mut graph: RenderGraph, block: usize) -> Vec<Vec<f32>> {
	let total = graph.length_frames() as usize;
	let mut out = vec![Vec::new(); graph.channels()];
	let mut done = 0;
	while done < total {
		let size = block.min(total - done);
		let mut chunks: Vec<Vec<f32>> = vec![vec![0.0; size]; out.len()];
		let mut slices: Vec<&mut [f32]> = chunks.iter_mut().map(Vec::as_mut_slice).collect();
		assert_eq!(graph.render_block(&mut slices), size);
		for (all, chunk) in out.iter_mut().zip(&chunks) {
			all.extend_from_slice(chunk);
		}
		done += size;
	}
	out
}

#[test]
fn block_size_does_not_change_the_samples() {
	let length = 40_000;
	let whole = busy_graph(length).render_all();
	assert!(peak(&whole[0]) > 0.1 && peak(&whole[1]) > 0.1);
	for block in [1, 7, 128, 1_000] {
		assert_eq!(
			render_in_blocks(busy_graph(length), block),
			whole,
			"block of {block}"
		);
	}
}

#[test]
fn rendering_is_deterministic() {
	assert_eq!(
		busy_graph(20_000).render_all(),
		busy_graph(20_000).render_all()
	);
}

#[test]
fn a_render_stops_at_its_length() {
	let mut graph = RenderGraph::new(RATE, 1, 300);
	osc_to_destination(&mut graph, 440.0);
	let mut block = vec![0.0_f32; 500];
	assert_eq!(graph.render_block(&mut [block.as_mut_slice()]), 300);
	assert_eq!(graph.render_block(&mut [block.as_mut_slice()]), 0);
	assert_eq!(graph.frames_rendered(), 300);
}

#[test]
fn booking_between_blocks_takes_effect_from_the_next_quantum() {
	let mut graph = RenderGraph::new(1_000.0, 1, 1_000);
	let ones = graph.create_buffer(1, 1, 1_000.0);
	graph.buffer_channel_mut(ones, 0)[0] = 1.0;
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(ones));
	graph.set_loop(source, true);
	graph.connect_node(source, graph.destination());
	let mut first = vec![0.0_f32; 256];
	graph.render_block(&mut [first.as_mut_slice()]);
	assert!(first.iter().all(|s| *s == 0.0));
	assert_eq!(graph.current_time(), 0.256);
	graph.start(source, graph.current_time());
	let mut second = vec![0.0_f32; 256];
	graph.render_block(&mut [second.as_mut_slice()]);
	assert!(second.iter().all(|s| *s == 1.0));
}

#[test]
fn disconnecting_silences_a_node() {
	let mut graph = RenderGraph::new(RATE, 1, 512);
	let osc = osc_to_destination(&mut graph, 440.0);
	let mut first = vec![0.0_f32; 256];
	graph.render_block(&mut [first.as_mut_slice()]);
	graph.disconnect(osc);
	let mut second = vec![0.0_f32; 256];
	graph.render_block(&mut [second.as_mut_slice()]);
	assert!(peak(&first) > 0.0 && peak(&second) == 0.0);
}

// ----- Filters, delay, and the convolver through the graph -----

/// A buffer source that plays `samples` once, into the returned node.
fn once(graph: &mut RenderGraph, samples: &[f32], rate: f64) -> NodeId {
	let buffer = graph.create_buffer(1, samples.len(), rate);
	graph.buffer_channel_mut(buffer, 0).copy_from_slice(samples);
	let source = graph.create_node(NodeKind::BufferSource);
	graph.set_buffer(source, Some(buffer));
	graph.start(source, 0.0);
	source
}

fn impulse_at_zero() -> [f32; 1] {
	[1.0]
}

#[test]
fn a_lowpass_attenuates_above_its_cutoff_by_the_expected_amount() {
	let level = |hertz: f64| {
		let mut graph = RenderGraph::new(RATE, 1, 48_000);
		let osc = graph.create_node(NodeKind::Oscillator);
		let frequency = graph.param(osc, ParamKind::Frequency);
		graph.set_value_at_time(frequency, hertz, 0.0);
		let filter = graph.create_node(NodeKind::BiquadFilter);
		let cutoff = graph.param(filter, ParamKind::Frequency);
		graph.set_value_at_time(cutoff, 1_000.0, 0.0);
		let q = graph.param(filter, ParamKind::Q);
		graph.set_value_at_time(q, -3.0103, 0.0); // a Butterworth: 10^(Q/20) = 1/sqrt(2)
		graph.connect_node(osc, filter);
		graph.connect_node(filter, graph.destination());
		graph.start(osc, 0.0);
		let out = graph.render_all();
		20.0 * (rms(&out[0][4_800..]) / core::f64::consts::FRAC_1_SQRT_2).log10()
	};
	assert!(level(100.0).abs() < 0.01);
	assert!((level(1_000.0) + 3.01).abs() < 0.05);
	// Two octaves up, a Butterworth is about 24 dB down (12 dB an octave).
	assert!((level(4_000.0) + 24.0).abs() < 1.0, "{}", level(4_000.0));
}

#[test]
fn a_highpass_and_a_bandpass_select_their_bands() {
	let level = |kind: FilterType, hertz: f64| {
		let mut graph = RenderGraph::new(RATE, 1, 24_000);
		let osc = graph.create_node(NodeKind::Oscillator);
		let frequency = graph.param(osc, ParamKind::Frequency);
		graph.set_value_at_time(frequency, hertz, 0.0);
		let filter = graph.create_node(NodeKind::BiquadFilter);
		graph.set_filter_type(filter, kind);
		let cutoff = graph.param(filter, ParamKind::Frequency);
		graph.set_value_at_time(cutoff, 2_000.0, 0.0);
		let q = graph.param(filter, ParamKind::Q);
		graph.set_value_at_time(q, 5.0, 0.0);
		graph.connect_node(osc, filter);
		graph.connect_node(filter, graph.destination());
		graph.start(osc, 0.0);
		rms(&graph.render_all()[0][4_800..]) / core::f64::consts::FRAC_1_SQRT_2
	};
	assert!(level(FilterType::Highpass, 100.0) < 0.005);
	assert!((level(FilterType::Highpass, 15_000.0) - 1.0).abs() < 0.03);
	assert!((level(FilterType::Bandpass, 2_000.0) - 1.0).abs() < 0.01);
	assert!(level(FilterType::Bandpass, 200.0) < 0.2);
}

#[test]
fn a_swept_filter_cutoff_is_followed_per_frame() {
	// The cutoff ramps from 100 Hz to 10 kHz while a 2 kHz tone plays: quiet at first, loud at the end.
	let mut graph = RenderGraph::new(RATE, 1, 48_000);
	let osc = osc_to_destination(&mut graph, 2_000.0);
	graph.disconnect(osc);
	let filter = graph.create_node(NodeKind::BiquadFilter);
	let cutoff = graph.param(filter, ParamKind::Frequency);
	graph.set_value_at_time(cutoff, 100.0, 0.0);
	graph.exponential_ramp_to_value_at_time(cutoff, 10_000.0, 1.0);
	graph.connect_node(osc, filter);
	graph.connect_node(filter, graph.destination());
	let out = graph.render_all();
	assert!(rms(&out[0][2_400..4_800]) < 0.02);
	assert!(rms(&out[0][43_200..]) > 0.6);
}

#[test]
fn a_delay_of_n_frames_moves_an_impulse_n_frames() {
	let mut graph = RenderGraph::new(1_000.0, 1, 1_000);
	let source = once(&mut graph, &impulse_at_zero(), 1_000.0);
	let delay = graph.create_node(NodeKind::Delay);
	let time = graph.param(delay, ParamKind::DelayTime);
	graph.set_value_at_time(time, 0.3, 0.0); // 300 frames, across two quanta
	graph.connect_node(source, delay);
	graph.connect_node(delay, graph.destination());
	let out = graph.render_all();
	assert_eq!(out[0][300], 1.0);
	assert_eq!(out[0].iter().filter(|s| **s != 0.0).count(), 1);
}

#[test]
fn a_delay_inside_a_feedback_loop_repeats_and_decays() {
	// Delay 200 frames with feedback 0.5: echoes at 200, 400, 600 of 1, 0.5, 0.25.
	let mut graph = RenderGraph::new(1_000.0, 1, 1_000);
	let source = once(&mut graph, &impulse_at_zero(), 1_000.0);
	let delay = graph.create_node(NodeKind::Delay);
	let time = graph.param(delay, ParamKind::DelayTime);
	graph.set_value_at_time(time, 0.2, 0.0);
	let feedback = graph.create_node(NodeKind::Gain);
	let level = graph.param(feedback, ParamKind::Gain);
	graph.set_value_at_time(level, 0.5, 0.0);
	graph.connect_node(source, delay);
	graph.connect_node(delay, graph.destination());
	graph.connect_node(delay, feedback);
	graph.connect_node(feedback, delay);
	let out = graph.render_all();
	for (frame, want) in [(200, 1.0), (400, 0.5), (600, 0.25), (800, 0.125)] {
		assert!(
			(out[0][frame] - want).abs() < 1e-6,
			"frame {frame}: {}",
			out[0][frame]
		);
	}
	assert_eq!(out[0].iter().filter(|s| s.abs() > 1e-6).count(), 4);
}

#[test]
fn a_delay_in_a_cycle_has_a_one_quantum_floor() {
	let mut graph = RenderGraph::new(1_000.0, 1, 1_000);
	let source = once(&mut graph, &impulse_at_zero(), 1_000.0);
	let delay = graph.create_node(NodeKind::Delay);
	let time = graph.param(delay, ParamKind::DelayTime);
	graph.set_value_at_time(time, 0.01, 0.0); // asked for 10 frames
	let feedback = graph.create_node(NodeKind::Gain);
	let level = graph.param(feedback, ParamKind::Gain);
	graph.set_value_at_time(level, 0.0, 0.0);
	graph.connect_node(source, delay);
	graph.connect_node(delay, graph.destination());
	graph.connect_node(delay, feedback);
	graph.connect_node(feedback, delay);
	let out = graph.render_all();
	assert_eq!(out[0][128], 1.0);
	assert!(out[0][..128].iter().all(|s| *s == 0.0));
}

#[test]
fn a_cycle_without_a_delay_is_muted_and_does_not_hang() {
	let mut graph = RenderGraph::new(1_000.0, 1, 512);
	let source = once(&mut graph, &impulse_at_zero(), 1_000.0);
	let a = graph.create_node(NodeKind::Gain);
	let b = graph.create_node(NodeKind::Gain);
	graph.connect_node(source, a);
	graph.connect_node(a, b);
	graph.connect_node(b, a);
	graph.connect_node(b, graph.destination());
	let out = graph.render_all();
	assert!(out[0].iter().all(|s| s.is_finite()));
}

#[test]
fn a_convolver_with_an_impulse_response_reproduces_it_at_the_normalised_level() {
	let response = [0.0_f32, 0.5, 0.0, 0.25];
	let mut graph = RenderGraph::new(44_100.0, 1, 1_024);
	let source = once(&mut graph, &impulse_at_zero(), 44_100.0);
	let convolver = graph.create_node(NodeKind::Convolver);
	let buffer = graph.create_buffer(1, response.len(), 44_100.0);
	graph
		.buffer_channel_mut(buffer, 0)
		.copy_from_slice(&response);
	graph.set_buffer(convolver, Some(buffer));
	graph.connect_node(source, convolver);
	graph.connect_node(convolver, graph.destination());
	let out = graph.render_all();
	// rms of the response is sqrt((0.25 + 0.0625) / 4); the scale is -58 dB (0.0012589, as Chromium's) over that.
	let scale = 10.0_f64.powf(-58.0 / 20.0) / (0.3125_f64 / 4.0).sqrt();
	assert!((f64::from(out[0][1]) - 0.5 * scale).abs() < 1e-6);
	assert!((f64::from(out[0][3]) - 0.25 * scale).abs() < 1e-6);
	assert!(out[0][4..].iter().all(|s| s.abs() < 1e-7));
}

#[test]
fn a_long_reverb_tail_runs_across_many_quanta_then_stops() {
	let mut graph = RenderGraph::new(8_000.0, 2, 8_000);
	let source = once(&mut graph, &impulse_at_zero(), 8_000.0);
	let convolver = graph.create_node(NodeKind::Convolver);
	let length = 2_000;
	let buffer = graph.create_buffer(2, length, 8_000.0);
	for channel in 0..2 {
		for (i, sample) in graph
			.buffer_channel_mut(buffer, channel)
			.iter_mut()
			.enumerate()
		{
			*sample = (((i * (7 + channel as usize * 4)) % 17) as f32 - 8.0) / 8.0;
		}
	}
	graph.set_buffer(convolver, Some(buffer));
	graph.connect_node(source, convolver);
	graph.connect_node(convolver, graph.destination());
	let out = graph.render_all();
	assert!(out[0][1_900..2_000].iter().any(|s| s.abs() > 0.0));
	assert!(out[0][2_100..].iter().all(|s| s.abs() < 1e-6));
	assert_ne!(out[0][..2_000], out[1][..2_000]);
}

/// Oscillators through a filter, a send into a feedback delay and a convolver, panned: every kind of stateful node.
fn effects_graph(length: u64) -> RenderGraph {
	let mut graph = RenderGraph::new(RATE, 2, length);
	let osc = graph.create_node(NodeKind::Oscillator);
	graph.set_oscillator_type(osc, OscillatorType::Square);
	let frequency = graph.param(osc, ParamKind::Frequency);
	graph.set_value_at_time(frequency, 220.0, 0.0);
	let filter = graph.create_node(NodeKind::BiquadFilter);
	let cutoff = graph.param(filter, ParamKind::Frequency);
	graph.set_value_at_time(cutoff, 400.0, 0.0);
	graph.linear_ramp_to_value_at_time(cutoff, 4_000.0, 0.4);
	let panner = graph.create_node(NodeKind::StereoPanner);
	let position = graph.param(panner, ParamKind::Pan);
	graph.set_value_at_time(position, 0.3, 0.0);
	let delay = graph.create_node(NodeKind::Delay);
	let time = graph.param(delay, ParamKind::DelayTime);
	graph.set_value_at_time(time, 0.05, 0.0);
	let feedback = graph.create_node(NodeKind::Gain);
	let level = graph.param(feedback, ParamKind::Gain);
	graph.set_value_at_time(level, 0.4, 0.0);
	let convolver = graph.create_node(NodeKind::Convolver);
	let buffer = graph.create_buffer(2, 5_000, RATE);
	for channel in 0..2 {
		for (i, sample) in graph
			.buffer_channel_mut(buffer, channel)
			.iter_mut()
			.enumerate()
		{
			*sample = (((i * 31 + channel as usize * 7) % 23) as f32 - 11.0) / 11.0
				* (1.0 - i as f32 / 5_000.0);
		}
	}
	graph.set_buffer(convolver, Some(buffer));
	graph.connect_node(osc, filter);
	graph.connect_node(filter, panner);
	graph.connect_node(panner, graph.destination());
	graph.connect_node(panner, delay);
	graph.connect_node(delay, graph.destination());
	graph.connect_node(delay, feedback);
	graph.connect_node(feedback, delay);
	graph.connect_node(filter, convolver);
	graph.connect_node(convolver, graph.destination());
	graph.start(osc, 0.0);
	graph.stop(osc, 0.3);
	graph
}

#[test]
fn block_size_does_not_change_effects_either() {
	let length = 30_000;
	let whole = effects_graph(length).render_all();
	assert!(peak(&whole[0]) > 0.0 && whole.iter().flatten().all(|s| s.is_finite()));
	for block in [1, 7, 128, 4_001] {
		assert_eq!(
			render_in_blocks(effects_graph(length), block),
			whole,
			"block of {block}"
		);
	}
	assert_eq!(effects_graph(length).render_all(), whole);
}

// ----- The wave shaper, the compressor, and the destination -----

#[test]
fn a_wave_shaper_applies_its_curve_and_clips_at_a_ceiling() {
	let mut graph = RenderGraph::new(RATE, 1, 4_800);
	let osc = graph.create_node(NodeKind::Oscillator);
	let frequency = graph.param(osc, ParamKind::Frequency);
	graph.set_value_at_time(frequency, 200.0, 0.0);
	let shaper = graph.create_node(NodeKind::WaveShaper);
	let gain = graph.create_node(NodeKind::Gain);
	let level = graph.param(gain, ParamKind::Gain);
	graph.set_value_at_time(level, 3.0, 0.0);
	let curve = crate::master::ceiling_curve(0.5);
	let curve = graph.create_curve(&curve);
	graph.set_curve(shaper, Some(curve));
	graph.set_oversample(shaper, Oversample::None);
	graph.connect_node(osc, gain);
	graph.connect_node(gain, shaper);
	graph.connect_node(shaper, graph.destination());
	graph.start(osc, 0.0);
	let out = graph.render_all();
	let top = crate::master::ceiling_top(0.5) as f32;
	assert!(
		out[0].iter().all(|s| s.abs() <= top),
		"never over the ceiling"
	);
	assert!((peak(&out[0]) - top).abs() < 1e-6, "clipped flat at it");
}

#[test]
fn the_master_bus_limits_a_loud_sine_with_the_ceiling_as_a_backstop() {
	use crate::master::{Limiter, MasterBusOptions, create_master_bus};
	use crate::warn::Warnings;
	let mut graph = RenderGraph::new(RATE, 2, 48_000);
	let bus = create_master_bus(
		&mut graph,
		&mut Warnings::default(),
		MasterBusOptions {
			ceiling: Some(-0.5),
			limiter: Limiter::Default,
			..MasterBusOptions::default()
		},
	)
	.unwrap();
	let osc = graph.create_node(NodeKind::Oscillator);
	let loud = graph.create_node(NodeKind::Gain);
	let level = graph.param(loud, ParamKind::Gain);
	graph.set_value_at_time(level, 4.0, 0.0);
	graph.connect_node(osc, loud);
	graph.connect_node(loud, bus.input);
	graph.start(osc, 0.0);
	let out = graph.render_all();
	let ceiling = 10.0_f32.powf(-0.5 / 20.0);
	assert!(peak(&out[0]) <= ceiling, "{}", peak(&out[0]));
	// The limiter brings a +12 dB sine to about the ceiling of its curve; the makeup stage takes the makeup out.
	let settled = peak(&out[0][24_000..]);
	assert!(settled > 0.7 && settled <= ceiling, "{settled}");
	assert_eq!(out[0], out[1]);
}

#[test]
fn the_compressor_node_applies_its_parameters_and_follows_them_per_quantum() {
	let mut graph = RenderGraph::new(RATE, 1, 48_000);
	let osc = graph.create_node(NodeKind::Oscillator);
	let frequency = graph.param(osc, ParamKind::Frequency);
	graph.set_value_at_time(frequency, 1_000.0, 0.0);
	let compressor = graph.create_node(NodeKind::DynamicsCompressor);
	for (kind, value) in [
		(ParamKind::Threshold, -20.0),
		(ParamKind::Knee, 0.0),
		(ParamKind::Ratio, 4.0),
	] {
		let param = graph.param(compressor, kind);
		graph.set_value_at_time(param, value, 0.0);
	}
	graph.connect_node(osc, compressor);
	graph.connect_node(compressor, graph.destination());
	graph.start(osc, 0.0);
	let out = graph.render_all();
	// Steady state: the curve gives -15 dB at full scale; the node's makeup is 0.6 of the 15 dB it gave away.
	let measured = 20.0 * f64::from(peak(&out[0][24_000..])).log10();
	assert!((measured - (-15.0 + 9.0)).abs() < 0.5, "{measured}");
}

#[test]
fn every_destination_width_from_one_to_eight_mixes_a_stereo_source() {
	for channels in 1..=8_u32 {
		let mut graph = RenderGraph::new(1_000.0, channels, 256);
		let two = graph.create_buffer(2, 1, 1_000.0);
		graph.buffer_channel_mut(two, 0)[0] = 1.0;
		graph.buffer_channel_mut(two, 1)[0] = 0.5;
		let source = graph.create_node(NodeKind::BufferSource);
		graph.set_buffer(source, Some(two));
		graph.set_loop(source, true);
		graph.connect_node(source, graph.destination());
		graph.start(source, 0.0);
		let out = graph.render_all();
		assert_eq!(out.len(), channels as usize);
		let column: Vec<f32> = out.iter().map(|c| c[200]).collect();
		let want: Vec<f32> = match channels {
			1 => vec![0.75],
			2 => vec![1.0, 0.5],
			4 | 6 => {
				let mut v = vec![0.0; channels as usize];
				v[0] = 1.0;
				v[1] = 0.5;
				v
			}
			// Three, five, seven, and eight channels have no speaker layout: discrete, the first two carry it.
			_ => {
				let mut v = vec![0.0; channels as usize];
				v[0] = 1.0;
				v[1] = 0.5;
				v
			}
		};
		assert_eq!(column, want, "{channels} channels");
	}
}

#[test]
fn the_multichannel_setup_of_the_engine_gives_a_discrete_eight_channel_destination() {
	use crate::engine::{Engine, OutputSetup};
	let graph = RenderGraph::new(RATE, 8, 4_800);
	let setup = OutputSetup {
		multichannel: true,
		..OutputSetup::default()
	};
	let mut engine = Engine::new(graph, setup).unwrap();
	assert_eq!(engine.graph().destination_channels(), 8);
	let voice = crate::params::VoiceParams {
		sound_type: Some(crate::params::SoundType::Sine),
		pitch: Some(crate::params::Pitch::Name("a4".into())),
		duration: Some(0.05),
		..crate::params::VoiceParams::empty()
	};
	engine.play(&voice, 0.0).unwrap();
	let out = engine.into_graph().render_all();
	assert_eq!(out.len(), 8);
	assert!(out.iter().any(|c| peak(c) > 0.01));
}

#[test]
fn a_delay_cycle_at_a_very_low_sample_rate_renders() {
	// The delay's five seconds are 5 frames at 1 Hz, under the 128 frames a cycle needs.
	let mut graph = RenderGraph::new(1.0, 1, 256);
	let source = osc_to_destination(&mut graph, 0.25);
	let delay = graph.create_node(NodeKind::Delay);
	let feedback = graph.create_node(NodeKind::Gain);
	graph.connect_node(source, delay);
	graph.connect_node(delay, feedback);
	graph.connect_node(feedback, delay);
	graph.connect_node(delay, graph.destination());
	let out = graph.render_all();
	assert_eq!(out[0].len(), 256);
	assert!(out[0].iter().all(|s| s.is_finite()));
}

#[test]
fn absurd_sample_rates_are_errors_from_try_new() {
	for rate in [0.0, -1.0, f64::NAN, f64::INFINITY, 1e300, 0.5] {
		let error = RenderGraph::try_new(rate, 1, 128).unwrap_err();
		assert!(error.message().contains("sample rate"), "{rate}: {error:?}");
	}
	assert!(RenderGraph::try_new(1.0, 1, 128).is_ok());
	assert!(RenderGraph::try_new(1_000_000.0, 1, 128).is_ok());
	assert!(RenderGraph::try_new(48_000.0, 0, 128).is_err());
	assert!(RenderGraph::try_new(48_000.0, 33, 128).is_err());
}

#[test]
#[should_panic(expected = "sample rate")]
fn new_panics_on_an_absurd_sample_rate() {
	let _ = RenderGraph::new(1e300, 1, 128);
}

#[test]
#[should_panic(expected = "buffer sample rate")]
fn a_buffer_at_a_zero_sample_rate_is_rejected() {
	let mut graph = RenderGraph::new(RATE, 1, 128);
	let _ = graph.create_buffer(1, 100, 0.0);
}

#[test]
#[should_panic(expected = "buffer sample rate")]
fn a_buffer_at_an_infinite_sample_rate_is_rejected() {
	let mut graph = RenderGraph::new(RATE, 1, 128);
	let _ = graph.create_buffer(1, 100, f64::INFINITY);
}

#[test]
#[should_panic(expected = "buffer is too long")]
fn an_absurdly_long_buffer_is_rejected() {
	let mut graph = RenderGraph::new(RATE, 1, 128);
	let _ = graph.create_buffer(2, usize::MAX / 8, RATE);
}

#[test]
fn an_absurd_render_length_is_an_error() {
	let error = RenderGraph::try_new(48_000.0, 2, u64::MAX).unwrap_err();
	assert!(error.message().contains("render length"), "{error:?}");
	assert!(RenderGraph::try_new(48_000.0, 2, 268_435_456).is_ok());
}

#[test]
#[should_panic(expected = "render length")]
fn set_length_frames_rejects_an_absurd_length() {
	let mut graph = RenderGraph::new(RATE, 1, 128);
	graph.set_length_frames(u64::MAX);
}

#[test]
#[should_panic(expected = "render_all")]
fn render_all_refuses_a_render_that_could_not_be_held() {
	let mut graph = RenderGraph::new(RATE, 32, 268_435_456);
	let _ = graph.render_all();
}

// ----- Retiring scopes -----

#[test]
fn a_retired_scope_gives_its_nodes_and_buffers_back_and_their_numbers_are_reused() {
	let mut graph = RenderGraph::new(RATE, 1, 4_800);
	graph.begin_scope();
	let first = osc_to_destination(&mut graph, 440.0);
	let gain = graph.create_node(NodeKind::Gain);
	let buffer = graph.create_buffer(1, 100, RATE);
	let scope = graph.end_scope();
	assert_eq!((graph.live_nodes(), graph.live_buffers()), (3, 1));

	graph.retire_scope(scope);
	assert_eq!((graph.live_nodes(), graph.live_buffers()), (1, 0));
	graph.retire_scope(scope); // already retired: nothing happens
	assert_eq!(graph.live_nodes(), 1);

	// The next nodes and buffer take the numbers that were given back.
	let again = graph.create_node(NodeKind::Gain);
	let other = graph.create_node(NodeKind::Gain);
	assert!([first.index(), gain.index()].contains(&again.index()));
	assert!([first.index(), gain.index()].contains(&other.index()));
	assert_eq!(graph.create_buffer(1, 10, RATE).index(), buffer.index());
	assert_eq!(graph.node_slots(), 3);
}

#[test]
fn a_retired_source_is_silent_and_a_shared_stretch_is_never_retired() {
	let mut graph = RenderGraph::new(RATE, 1, 4_800);
	graph.begin_scope();
	graph.begin_shared();
	let shared = graph.create_node(NodeKind::Gain);
	graph.connect_node(shared, graph.destination());
	graph.end_shared();
	osc_to_destination(&mut graph, 1_000.0);
	let scope = graph.end_scope();
	let silent_destination = graph.end_scope();
	assert_eq!(silent_destination, Scope::NONE, "no scope is open now");

	graph.retire_scope(scope);
	// The oscillator is gone; the shared node is still a live node of the graph.
	assert_eq!(graph.live_nodes(), 2);
	let out = graph.render_all();
	assert_eq!(peak(&out[0]), 0.0);
}

#[test]
fn retiring_none_or_the_destination_does_nothing() {
	let mut graph = RenderGraph::new(RATE, 1, 480);
	graph.retire_scope(Scope::NONE);
	graph.retire_node(0);
	assert_eq!(graph.live_nodes(), 1);
	osc_to_destination(&mut graph, 1_000.0);
	let out = graph.render_all();
	assert!(peak(&out[0]) > 0.5);
}

#[test]
fn a_retired_node_does_not_disturb_the_others_that_play_on() {
	let mut graph = RenderGraph::new(RATE, 1, 9_600);
	osc_to_destination(&mut graph, 1_000.0);
	graph.begin_scope();
	osc_to_destination(&mut graph, 1_500.0);
	let scope = graph.end_scope();
	let mut block = vec![0.0_f32; 4_800];
	assert_eq!(graph.render_block(&mut [block.as_mut_slice()]), 4_800);
	graph.retire_scope(scope);
	assert_eq!(graph.render_block(&mut [block.as_mut_slice()]), 4_800);
	// The 1 kHz sine alone has an RMS of 1/sqrt(2).
	assert!((rms(&block) - core::f64::consts::FRAC_1_SQRT_2).abs() < 1e-2);
}

#[test]
fn retiring_a_scope_removes_the_edges_that_shared_nodes_had_to_its_nodes() {
	let mut graph = RenderGraph::new(RATE, 1, 4_800);
	// A shared oscillator feeds a gain that belongs to a scope.
	graph.begin_shared();
	let shared = graph.create_node(NodeKind::Oscillator);
	let frequency = graph.param(shared, ParamKind::Frequency);
	graph.set_value_at_time(frequency, 1_000.0, 0.0);
	graph.start(shared, 0.0);
	graph.end_shared();
	graph.begin_scope();
	let scoped = graph.create_node(NodeKind::Gain);
	graph.connect_node(shared, scoped);
	graph.connect_node(scoped, graph.destination());
	let scope = graph.end_scope();
	graph.retire_scope(scope);

	// The next gain takes the retired number, but nothing connects the shared oscillator to it.
	let again = graph.create_node(NodeKind::Gain);
	assert_eq!(again.index(), scoped.index());
	graph.connect_node(again, graph.destination());
	let out = graph.render_all();
	assert_eq!(peak(&out[0]), 0.0, "a dangling edge fed the new node");
}

#[test]
fn retiring_a_scope_removes_the_parameter_edges_shared_nodes_had_to_its_nodes() {
	let mut graph = RenderGraph::new(RATE, 1, 4_800);
	graph.begin_shared();
	let shared = graph.create_node(NodeKind::Oscillator);
	graph.start(shared, 0.0);
	graph.end_shared();
	graph.begin_scope();
	let scoped = graph.create_node(NodeKind::Gain);
	let gain = graph.param(scoped, ParamKind::Gain);
	graph.connect(shared, Target::Param(gain), 0, 0);
	let scope = graph.end_scope();
	graph.retire_scope(scope);

	let again = graph.create_node(NodeKind::Gain);
	assert_eq!(again.index(), scoped.index());
	let carrier = graph.create_node(NodeKind::Oscillator);
	graph.start(carrier, 0.0);
	graph.connect_node(carrier, again);
	graph.connect_node(again, graph.destination());
	graph.set_value_at_time(graph.param(again, ParamKind::Gain), 0.0, 0.0);
	let out = graph.render_all();
	assert_eq!(
		peak(&out[0]),
		0.0,
		"a dangling parameter edge modulated the new node"
	);
}

#[test]
fn retiring_a_stale_scope_twice_does_not_retire_a_newer_scope_that_reused_its_number() {
	let mut graph = RenderGraph::new(RATE, 1, 4_800);
	graph.begin_scope();
	osc_to_destination(&mut graph, 440.0);
	let old = graph.end_scope();
	graph.retire_scope(old);
	graph.begin_scope();
	osc_to_destination(&mut graph, 660.0);
	let newer = graph.end_scope();
	assert_ne!(old, newer, "a reused slot carries a new generation");
	let before = graph.live_nodes();
	graph.retire_scope(old);
	assert_eq!(
		graph.live_nodes(),
		before,
		"the stale scope retired a newer one"
	);
	graph.retire_scope(newer);
	assert_eq!(graph.live_nodes(), before - 1);
}
