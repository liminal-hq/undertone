// Sample voices: the registry wired into the engine, with its warnings, its pending state, and its buffer cache
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Sample voices booked by the engine from a registry: warnings, the pending state, the buffer cache, and buffer summaries.

use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::LogGraph;
use undertone_engine::params::{Pitch, VoiceParams};
use undertone_engine::samples::{SampleData, Samples};

fn engine() -> Engine<LogGraph> {
	Engine::new(LogGraph::new(44_100.0, 2), OutputSetup::default()).unwrap()
}

fn hit(name: &str) -> VoiceParams {
	VoiceParams {
		sample_name: Some(name.into()),
		sustain: 1.0,
		..VoiceParams::empty()
	}
}

fn pcm(samples: &[f32]) -> SampleData {
	SampleData::new(44_100.0, vec![samples.to_vec()])
}

#[test]
fn an_unregistered_sample_warns_once_and_books_nothing() {
	let mut engine = engine();
	let first = engine.play(&hit("ghost"), 0.0).unwrap();
	engine.play(&hit("ghost"), 0.5).unwrap();
	assert_eq!(first.start_time, first.end_time);
	assert_eq!(engine.warnings().len(), 1);
	assert_eq!(
		engine.warnings()[0].message,
		"undertone: sample \"ghost\" is not registered \u{2014} voice skipped. Call registerSample() first."
	);
	assert_eq!(engine.graph().clone().finish(None).nodes.len(), 1);
}

#[test]
fn a_cleared_registry_warns_again() {
	let mut engine = engine();
	engine.play(&hit("ghost"), 0.0).unwrap();
	engine.samples_mut().clear_samples();
	engine.play(&hit("ghost"), 0.0).unwrap();
	assert_eq!(engine.warnings().len(), 2);
}

#[test]
fn a_pending_sample_is_skipped_silently_until_it_is_loaded() {
	let mut engine = engine();
	engine
		.samples_mut()
		.register_pending_sample("pad", None)
		.unwrap();
	assert!(engine.is_voice_skipped(&hit("pad")));
	engine.play(&hit("pad"), 0.0).unwrap();
	assert!(engine.warnings().is_empty());
	engine
		.samples_mut()
		.load_samples([("pad".to_string(), pcm(&[0.5, -0.5]))])
		.unwrap();
	assert!(!engine.is_voice_skipped(&hit("pad")));
	engine.play(&hit("pad"), 0.0).unwrap();
	let record = engine.into_graph().finish(None);
	assert_eq!(
		record
			.nodes
			.iter()
			.filter(|n| n.kind == "bufferSource")
			.count(),
		1
	);
}

#[test]
fn a_voice_naming_a_pending_sample_asks_the_host_for_that_sample_only() {
	let mut engine = engine();
	for name in ["pad", "kit_sd", "unused"] {
		engine
			.samples_mut()
			.register_pending_sample(name, None)
			.unwrap();
	}
	engine
		.samples_mut()
		.register_sample("bd", pcm(&[1.0]), None)
		.unwrap();
	assert!(engine.take_requested_samples().is_empty());
	// Asking whether a voice is skipped asks for nothing; only booking does, as only booking looks the buffer up.
	assert!(engine.is_voice_skipped(&hit("pad")));
	assert!(engine.take_requested_samples().is_empty());
	let mut banked = hit("sd");
	banked.sample_bank = Some("kit".into());
	engine.play(&hit("pad"), 0.0).unwrap();
	engine.play(&banked, 0.0).unwrap();
	engine.play(&hit("pad"), 0.5).unwrap();
	engine.play(&hit("bd"), 0.0).unwrap();
	engine.play(&hit("ghost"), 0.0).unwrap();
	// Each pending key once, in the order first named; a loaded sample and an unregistered name are not asked for.
	assert_eq!(engine.take_requested_samples(), ["pad", "kit_sd"]);
	assert!(engine.take_requested_samples().is_empty());
	engine.play(&hit("pad"), 1.0).unwrap();
	assert_eq!(engine.take_requested_samples(), ["pad"]);
	engine
		.samples_mut()
		.load_samples([("pad".to_string(), pcm(&[0.5]))])
		.unwrap();
	engine.play(&hit("pad"), 1.5).unwrap();
	assert!(engine.take_requested_samples().is_empty());
	assert_eq!(engine.warnings().len(), 1); // the unregistered name only
}

#[test]
fn a_played_sample_keeps_its_buffer_after_a_clear_and_the_default_base_note() {
	let mut engine = engine();
	engine
		.samples_mut()
		.register_sample("bd", pcm(&[1.0]), Some(Pitch::Name("a2".into())))
		.unwrap();
	let mut voice = hit("bd");
	voice.pitch = Some(Pitch::Name("a3".into()));
	engine.play(&voice, 0.0).unwrap();
	engine.samples_mut().clear_samples();
	assert!(!engine.is_voice_skipped(&voice));
	engine.play(&voice, 0.25).unwrap();
	let json = engine.into_graph().finish(None).to_json("");
	assert!(json.contains("set 2 @0"));
	// Registered nowhere now, so the base note is c4 and a3 is half its frequency.
	assert!(json.contains("set 0.840896415 @0.25"));
}

#[test]
fn the_buffer_summary_is_the_registered_pcm() {
	let mut engine = engine();
	engine
		.samples_mut()
		.register_sample("bd", pcm(&[0.5, -0.5, 0.25, 1.0, 0.0]), None)
		.unwrap();
	engine.play(&hit("bd"), 0.0).unwrap();
	let record = engine.into_graph().finish(None);
	let json = record.to_json("");
	// rms = sqrt((0.25 + 0.25 + 0.0625 + 1) / 5), peak 1, the first four samples.
	assert!(json.contains(r#""head":[0.5,-0.5,0.25,1]"#), "{json}");
	assert!(json.contains(r#""peak":1"#));
	assert!(json.contains(r#""rms":0.559016994"#));
	assert!(json.contains(r#""sampleRate":44100"#));
}

#[test]
fn a_bad_pitch_on_a_sample_voice_fails_with_the_pitch_message() {
	let mut engine = engine();
	engine
		.samples_mut()
		.register_sample("bd", pcm(&[1.0]), None)
		.unwrap();
	let mut voice = hit("bd");
	voice.pitch = Some(Pitch::Name("h2".into()));
	assert!(engine.play(&voice, 0.0).is_err());
}

#[test]
fn a_registry_can_be_handed_to_an_engine_whole() {
	let mut samples = Samples::new();
	samples
		.register_sample("bd", pcm(&[1.0, 0.0]), None)
		.unwrap();
	let mut engine = engine();
	*engine.samples_mut() = samples.clone();
	engine.play(&hit("bd"), 0.0).unwrap();
	assert!(engine.warnings().is_empty());
	assert!(samples.is_sample_registered("bd", None));
}
