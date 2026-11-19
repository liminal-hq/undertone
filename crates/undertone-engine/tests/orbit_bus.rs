// The orbit bus a host asks for by hand is the one the voices of that orbit find
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `Engine::orbit_bus`, `set_orbit_room_size`, and `set_orbit_delay` (the reference's `getOrbitBus`,
//! `setRoomSize`, and `setDelay`), asserted against the recorded node graph.

use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::LogGraph;
use undertone_engine::params::VoiceParams;

fn engine() -> Engine<LogGraph> {
	Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default()).unwrap()
}

fn kinds(engine: &Engine<LogGraph>, kind: &str) -> usize {
	engine
		.graph()
		.finish(None)
		.nodes
		.iter()
		.filter(|node| node.kind == kind)
		.count()
}

fn room_voice(orbit: f64) -> VoiceParams {
	VoiceParams {
		room_level: Some(0.5),
		orbit: Some(orbit),
		..VoiceParams::empty()
	}
}

#[test]
fn a_bus_made_by_hand_is_the_one_a_voice_finds() {
	let mut engine = engine();
	let bus = engine.orbit_bus(2.0, None);
	assert_eq!(kinds(&engine, "convolver"), 1);
	assert_eq!(kinds(&engine, "delay"), 1);
	// A second ask, and a voice that sends to the orbit, make no second bus.
	assert_eq!(engine.orbit_bus(2.0, None).reverb_input, bus.reverb_input);
	engine.play(&room_voice(2.0), 0.0).unwrap();
	assert_eq!(kinds(&engine, "convolver"), 1);
	// Another orbit is another bus.
	let other = engine.orbit_bus(3.0, None);
	assert_ne!(other.reverb_input, bus.reverb_input);
	assert_eq!(kinds(&engine, "convolver"), 2);
}

#[test]
fn a_voice_first_finds_the_bus_a_host_asks_for_later() {
	let mut engine = engine();
	engine.play(&room_voice(1.0), 0.0).unwrap();
	let made_by_the_voice = kinds(&engine, "convolver");
	engine.orbit_bus(1.0, None);
	assert_eq!((made_by_the_voice, kinds(&engine, "convolver")), (1, 1));
}

#[test]
fn the_room_size_is_set_once_and_regenerated_only_when_it_changes() {
	let mut engine = engine();
	engine.set_orbit_room_size(2.0, None, 3.0).unwrap();
	let buffers = |engine: &Engine<LogGraph>| {
		engine
			.graph()
			.finish(None)
			.buffers
			.iter()
			.filter(|buffer| buffer.sample_rate.is_some())
			.count()
	};
	assert_eq!(buffers(&engine), 1);
	engine.set_orbit_room_size(2.0, None, 3.0).unwrap();
	assert_eq!(buffers(&engine), 1, "the same size is not made again");
	engine.set_orbit_room_size(2.0, None, 6.0).unwrap();
	assert_eq!(buffers(&engine), 2);
	// A voice that asks for the size the bus has makes nothing either.
	engine
		.play(
			&VoiceParams {
				room_size: 6.0,
				..room_voice(2.0)
			},
			0.0,
		)
		.unwrap();
	assert_eq!(buffers(&engine), 2);
}

#[test]
fn the_response_is_the_one_a_voice_would_have_made() {
	let mut by_hand = engine();
	by_hand.set_orbit_room_size(2.0, None, 3.0).unwrap();
	let mut by_voice = engine();
	by_voice
		.play(
			&VoiceParams {
				room_size: 3.0,
				..room_voice(2.0)
			},
			0.0,
		)
		.unwrap();
	let summary = |engine: &Engine<LogGraph>| {
		engine
			.graph()
			.finish(None)
			.buffers
			.iter()
			.find(|buffer| buffer.sample_rate.is_some())
			.map(|buffer| (buffer.length, buffer.channels.clone()))
	};
	assert!(summary(&by_hand).is_some());
	assert_eq!(summary(&by_hand), summary(&by_voice));
}

#[test]
fn a_room_that_cannot_be_made_leaves_the_bus_as_it_was() {
	let mut engine = engine();
	let error = engine
		.set_orbit_room_size(0.0, None, f64::INFINITY)
		.unwrap_err();
	assert!(error.message().contains("room"), "{}", error.message());
	engine.set_orbit_room_size(0.0, None, 3.0).unwrap();
}

#[test]
fn the_delay_is_set_on_the_bus() {
	let mut engine = engine();
	engine.set_orbit_delay(2.0, None, 0.25, 0.4);
	let record = engine.graph().finish(None);
	let calls: Vec<&String> = record
		.nodes
		.iter()
		.flat_map(|node| node.params.iter())
		.flat_map(|(_, calls)| calls)
		.collect();
	assert!(
		calls.iter().any(|call| call.as_str() == "set 0.25 @0"),
		"{calls:?}"
	);
	assert!(
		calls.iter().any(|call| call.as_str() == "set 0.4 @0"),
		"{calls:?}"
	);
}
