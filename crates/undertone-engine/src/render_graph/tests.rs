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

#[test]
fn the_other_oscillator_types_have_their_waveform_levels() {
	let level = |kind: OscillatorType| {
		let mut graph = RenderGraph::new(RATE, 1, 48_000);
		let osc = osc_to_destination(&mut graph, 100.0);
		graph.set_oscillator_type(osc, kind);
		rms(&graph.render_all()[0])
	};
	// A square's RMS is 1 (a little under, band-limited), a triangle's 1 over root 3, a sawtooth's too.
	assert!((level(OscillatorType::Square) - 1.0).abs() < 0.02);
	assert!((level(OscillatorType::Triangle) - 1.0 / 3.0_f64.sqrt()).abs() < 0.01);
	assert!((level(OscillatorType::Sawtooth) - 1.0 / 3.0_f64.sqrt()).abs() < 0.01);
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
	let osc = osc_to_destination(&mut graph, 11_000.0);
	graph.set_oscillator_type(osc, OscillatorType::Sawtooth);
	let out = graph.render_all();
	// At 11 kHz only the fundamental fits below 24 kHz: the output is a plain sine of amplitude 2/pi.
	assert!((peak(&out[0]) - (2.0 / core::f32::consts::PI)).abs() < 5e-3);
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
