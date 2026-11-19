// Renders sample voices through RenderGraph: playback rate from the base note, rate conversion, mono to stereo
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Sample voices rendered by `RenderGraph`: playback rate from the base note, rate conversion, and the mono to stereo up-mix.

use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::params::{Pitch, VoiceParams};
use undertone_engine::render_graph::RenderGraph;
use undertone_engine::samples::SampleData;

/// A ramp from 0 to 1 over 400 frames recorded at `rate` hertz.
fn ramp(rate: f64) -> SampleData {
	SampleData::new(rate, vec![(0..400).map(|i| i as f32 / 400.0).collect()])
}

/// Renders one held sample voice on a 1000 Hz stereo graph; the envelope is flat at 1 after 20 ms.
fn render(data: SampleData, base: Option<Pitch>, pitch: Option<Pitch>) -> Vec<Vec<f32>> {
	let mut engine =
		Engine::new(RenderGraph::new(1_000.0, 2, 400), OutputSetup::default()).unwrap();
	engine
		.samples_mut()
		.register_sample("ramp", data, base)
		.unwrap();
	let voice = VoiceParams {
		sample_name: Some("ramp".into()),
		pitch,
		gain_level: 1.0,
		attack: 0.01,
		decay: 0.01,
		sustain: 1.0,
		release: 0.05,
		duration: Some(0.5),
		..VoiceParams::empty()
	};
	engine.play(&voice, 0.0).unwrap();
	engine.into_graph().render_all()
}

#[test]
fn a_pitched_sample_plays_at_the_ratio_to_its_base_note() {
	// a3 over a base note of a2 is twice the speed.
	let out = render(
		ramp(1_000.0),
		Some(Pitch::Name("a2".into())),
		Some(Pitch::Name("a3".into())),
	);
	for frame in [40, 80, 150] {
		let want = 2.0 * frame as f32 / 400.0;
		assert!(
			(out[0][frame] - want).abs() < 1e-4,
			"{frame}: {}",
			out[0][frame]
		);
	}
	// The recording ends after 200 output frames.
	assert!(out[0][250..].iter().all(|s| s.abs() < 1e-6));
}

#[test]
fn a_mono_sample_is_copied_to_both_channels() {
	let out = render(ramp(1_000.0), None, None);
	assert_eq!(out[0], out[1]);
	assert!(out[0][100] > 0.2);
}

#[test]
fn a_recording_at_another_sample_rate_is_converted() {
	// Recorded at 500 Hz on a 1000 Hz graph: half speed, with no pitch given.
	let out = render(ramp(500.0), None, None);
	for frame in [40, 100, 300] {
		let want = 0.5 * frame as f32 / 400.0;
		assert!(
			(out[0][frame] - want).abs() < 1e-4,
			"{frame}: {}",
			out[0][frame]
		);
	}
}

#[test]
fn a_stereo_sample_keeps_its_channels() {
	let data = SampleData::new(1_000.0, vec![vec![0.25; 400], vec![-0.5; 400]]);
	let out = render(data, None, None);
	assert!((out[0][100] - 0.25).abs() < 1e-5);
	assert!((out[1][100] + 0.5).abs() < 1e-5);
}
