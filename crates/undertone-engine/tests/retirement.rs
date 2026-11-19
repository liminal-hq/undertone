// A voice's nodes and buffers are given back once it is over, and the sound is the same
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Retiring finished voices on a [`RenderGraph`] (RF-22): a long run keeps a bounded number of nodes and
//! buffers, a retired node's number is reused, and what is rendered is exactly what booking everything up
//! front renders.

use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::{Graph, LogGraph};
use undertone_engine::master::MasterBusOptions;
use undertone_engine::params::{SoundType, VoiceParams};
use undertone_engine::render_graph::RenderGraph;

const RATE: f64 = 8_000.0;
const STEP: f64 = 0.05;

/// A short voice with the full chain: a filter, a pan, a reverb and a delay send, and (every third voice)
/// noise, which makes a buffer of its own. Every fifth voice is in a cut group.
fn voice(i: usize) -> VoiceParams {
	VoiceParams {
		sound_type: Some(if i.is_multiple_of(3) {
			SoundType::White
		} else {
			SoundType::Sawtooth
		}),
		duration: Some(0.04),
		sustain: 0.7,
		release: 0.02,
		filter_cutoff: Some(900.0),
		pan: Some(if i.is_multiple_of(2) { -0.5 } else { 0.5 }),
		room_level: Some(0.3),
		room_size: 1.0,
		delay_level: Some(0.2),
		delay_time: 0.03,
		cut_group: (i.is_multiple_of(5)).then_some(1.0),
		..VoiceParams::empty()
	}
}

fn setup() -> OutputSetup {
	OutputSetup {
		master: Some(MasterBusOptions::default()),
		..OutputSetup::default()
	}
}

fn onset(i: usize) -> f64 {
	0.1 + STEP * i as f64
}

/// Books every voice before rendering anything: the clock stays at zero, so nothing is retired.
fn render_up_front(count: usize, frames: u64) -> (Vec<Vec<f32>>, usize, usize) {
	let mut engine = Engine::new(RenderGraph::new(RATE, 2, frames), setup()).unwrap();
	for i in 0..count {
		engine.play(&voice(i), onset(i)).unwrap();
	}
	let (nodes, buffers) = (engine.graph().live_nodes(), engine.graph().live_buffers());
	(engine.into_graph().render_all(), nodes, buffers)
}

/// Books each voice a quantum or so before it sounds, rendering as it goes, so the graph's clock moves and
/// finished voices are retired. Returns the samples and the most nodes and buffers ever live.
fn render_as_it_goes(count: usize, frames: u64) -> (Vec<Vec<f32>>, usize, usize, usize) {
	let mut engine = Engine::new(RenderGraph::new(RATE, 2, frames), setup()).unwrap();
	let mut out = vec![Vec::new(), Vec::new()];
	let (mut most_nodes, mut most_buffers) = (0, 0);
	let block = (RATE * STEP) as usize;
	let mut booked = 0;
	while out[0].len() < frames as usize {
		// Book what starts within the next block (the look-ahead): all of it before the clock reaches it.
		let horizon = engine.graph().current_time() + 2.0 * STEP;
		while booked < count && onset(booked) < horizon {
			engine.play(&voice(booked), onset(booked)).unwrap();
			booked += 1;
		}
		most_nodes = most_nodes.max(engine.graph().live_nodes());
		most_buffers = most_buffers.max(engine.graph().live_buffers());
		let mut left = vec![0.0_f32; block];
		let mut right = vec![0.0_f32; block];
		let wrote = engine
			.graph_mut()
			.render_block(&mut [left.as_mut_slice(), right.as_mut_slice()]);
		out[0].extend_from_slice(&left[..wrote]);
		out[1].extend_from_slice(&right[..wrote]);
		if wrote == 0 {
			break;
		}
	}
	let slots = engine.graph().node_slots();
	(out, most_nodes, most_buffers, slots)
}

#[test]
fn retiring_finished_voices_does_not_change_the_sound() {
	let count = 120;
	let frames = (RATE * (onset(count) + 1.0)) as u64;
	let (whole, ..) = render_up_front(count, frames);
	let (live, ..) = render_as_it_goes(count, frames);
	assert_eq!(whole.len(), live.len());
	for (a, b) in whole.iter().zip(&live) {
		assert_eq!(a.len(), b.len());
		// A reused node number changes the order the mixer adds its inputs in, so the samples can differ in
		// the last bit of an `f32` (under 2e-7 here) and no more: the same sound, not the same rounding.
		let worst = a
			.iter()
			.zip(b)
			.fold(0.0_f32, |m, (x, y)| m.max((x - y).abs()));
		assert!(worst < 1e-6, "largest difference {worst}");
	}
	assert!(
		whole[0].iter().any(|s| s.abs() > 1e-3),
		"the render is not silent"
	);
}

#[test]
fn a_long_run_keeps_a_bounded_number_of_nodes_and_buffers() {
	let count = 400;
	let frames = (RATE * (onset(count) + 1.0)) as u64;
	let (_, nodes_up_front, buffers_up_front) = render_up_front(count, frames);
	let (_, most_nodes, most_buffers, slots) = render_as_it_goes(count, frames);
	// Up front, every voice's nodes are kept. As it goes, only the voices in flight and the shared bus are.
	assert!(nodes_up_front > 2_000, "{nodes_up_front}");
	assert!(most_nodes < 200, "{most_nodes} live nodes at most");
	assert!(slots < 250, "{slots} node numbers handed out");
	assert!(
		most_buffers < 20 && buffers_up_front > 100,
		"{most_buffers} / {buffers_up_front}"
	);
}

#[test]
fn a_graph_that_retires_nothing_keeps_the_engine_working() {
	// The recording graph keeps everything (the corpus depends on it) and the engine's retiring list stays empty.
	let mut engine = Engine::new(LogGraph::new(RATE, 2), OutputSetup::default()).unwrap();
	for i in 0..50 {
		engine.graph_mut().set_current_time(onset(i));
		engine.play(&voice(i), onset(i)).unwrap();
	}
	assert_eq!(engine.retiring_count(), 0);
}

#[test]
fn a_cut_group_holder_is_kept_until_it_is_replaced() {
	let mut engine = Engine::new(RenderGraph::new(RATE, 2, 80_000), setup()).unwrap();
	let grouped = VoiceParams {
		duration: Some(0.05),
		sustain: 1.0,
		cut_group: Some(2.0),
		..VoiceParams::empty()
	};
	engine.play(&grouped, 0.0).unwrap();
	let after_first = engine.graph().live_nodes();
	// Render two seconds: the holder ended long ago, but it is the group's current voice.
	let mut block = vec![0.0_f32; 16_000];
	let mut other = vec![0.0_f32; 16_000];
	engine
		.graph_mut()
		.render_block(&mut [block.as_mut_slice(), other.as_mut_slice()]);
	let short = VoiceParams {
		duration: Some(0.01),
		sustain: 1.0,
		..VoiceParams::empty()
	};
	engine.play(&short, 2.0).unwrap();
	assert!(
		engine.graph().live_nodes() > after_first,
		"the holder's nodes are still there"
	);
	// A voice in the group replaces the holder; the old one is now free to be retired on a later booking.
	engine.play(&grouped, 2.1).unwrap();
	engine.play(&short, 2.2).unwrap();
	engine
		.graph_mut()
		.render_block(&mut [block.as_mut_slice(), other.as_mut_slice()]);
	engine.play(&short, 4.5).unwrap();
	assert!(
		engine.graph().node_slots() < 40,
		"{}",
		engine.graph().node_slots()
	);
}
