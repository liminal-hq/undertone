// Compile-time Send and Sync assertions, and a player shared across threads behind a mutex
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A host such as a Tauri plugin keeps an engine in managed state and calls it from async commands on any
//! thread (`docs/rust-migration/HANDOFFS.md`, TAU-01). That needs the engine, the player, and the pattern types
//! to be `Send` (and the patterns `Sync`, so one pattern is queried from several threads). The first tests are
//! compile-time assertions: they fail to build if a type stops being thread-safe. The rest hold one
//! [`Player`] in shared state and use it from several threads.

use std::sync::{Arc, Mutex};
use std::thread;
use undertone::prelude::*;

fn assert_send<T: Send>() {}
fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn the_engine_the_player_and_their_parts_are_send() {
	assert_send::<Engine<RenderGraph>>();
	assert_send::<Engine<LogGraph>>();
	assert_send::<Player>();
	assert_send::<Player<LogGraph, ManualClock>>();
	assert_send::<Transport<ManualClock>>();
	assert_send::<RenderGraph>();
	assert_send::<Samples>();
	assert_send::<LoopHandle>();
	assert_send::<PlaybackHandle>();
}

#[test]
fn the_pattern_types_are_send_and_sync() {
	assert_send_sync::<Pattern<ControlMap>>();
	assert_send_sync::<Pattern<f64>>();
	assert_send_sync::<Hap<Value>>();
	assert_send_sync::<Value>();
	assert_send_sync::<Fraction>();
	assert_send_sync::<Span>();
	assert_send_sync::<Score>();
	assert_send_sync::<RenderOptions>();
	assert_send_sync::<WavOptions>();
	assert_send_sync::<PlayerOptions>();
	assert_send_sync::<RenderedAudio>();
	assert_send_sync::<Error>();
	assert_send_sync::<ManualClock>();
}

#[test]
fn a_pattern_with_a_closure_in_it_is_still_send_and_sync() {
	let pattern = note("c4 e4")
		.unwrap()
		.fmap_with(|value: &Value| value.clone());
	assert_send_sync::<Pattern<Value>>();
	let shared = Arc::new(pattern);
	let handles: Vec<_> = (0..4)
		.map(|_| {
			let shared = Arc::clone(&shared);
			thread::spawn(move || {
				shared
					.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)))
					.len()
			})
		})
		.collect();
	for handle in handles {
		assert_eq!(handle.join().unwrap(), 2);
	}
}

fn shared_player() -> Arc<Mutex<Player>> {
	Arc::new(Mutex::new(
		Player::new(&PlayerOptions::new().sample_rate(8_000)).unwrap(),
	))
}

#[test]
fn a_player_in_shared_state_serves_several_threads() {
	let player = shared_player();
	let pitches = ["c4", "e4", "g4", "b4"];
	let handles: Vec<_> = pitches
		.into_iter()
		.map(|pitch| {
			let player = Arc::clone(&player);
			thread::spawn(move || {
				let mut guard = player.lock().unwrap();
				guard
					.play(
						&note(pitch).unwrap().sound("triangle"),
						&PlayOptions::default(),
					)
					.unwrap();
				guard.render_seconds(0.25).unwrap().frames()
			})
		})
		.collect();
	let frames: usize = handles.into_iter().map(|h| h.join().unwrap()).sum();
	assert_eq!(frames, 4 * 2_000);

	let mut guard = player.lock().unwrap();
	// Every thread's note went through the one engine, and the one clock moved on by what was rendered.
	assert_eq!(guard.stats().voices_booked, 4);
	assert_eq!(guard.clock().frames_played(), 8_000);
	guard.shutdown();
}

#[test]
fn a_loop_started_on_one_thread_is_ticked_and_stopped_from_others() {
	let player = shared_player();
	let handle = {
		let player = Arc::clone(&player);
		thread::spawn(move || {
			player
				.lock()
				.unwrap()
				.play_loop(
					&note("c3 e3 g3 b3").unwrap().sound("triangle"),
					&LoopOptions {
						bpm: Some(240.0),
						..LoopOptions::default()
					},
				)
				.unwrap()
		})
		.join()
		.unwrap()
	};
	let renderers: Vec<_> = (0..3)
		.map(|_| {
			let player = Arc::clone(&player);
			thread::spawn(move || player.lock().unwrap().render_seconds(1.0).unwrap().peak())
		})
		.collect();
	let peaks: Vec<f32> = renderers.into_iter().map(|h| h.join().unwrap()).collect();
	assert!(peaks.iter().all(|peak| *peak > 0.01), "{peaks:?}");

	let stopper = {
		let player = Arc::clone(&player);
		thread::spawn(move || {
			let mut guard = player.lock().unwrap();
			guard.stop_loop(handle, &LoopStop::default()).unwrap();
			guard.transport().unwrap().loop_count()
		})
	};
	assert_eq!(stopper.join().unwrap(), 0);
}

#[test]
fn shutdown_from_one_thread_closes_the_player_for_the_others() {
	let player = shared_player();
	{
		let mut guard = player.lock().unwrap();
		guard
			.play(&note("c4").unwrap(), &PlayOptions::default())
			.unwrap();
	}
	// Several threads race to shut down: the first stops everything, the rest find nothing to do.
	let closers: Vec<_> = (0..4)
		.map(|_| {
			let player = Arc::clone(&player);
			thread::spawn(move || {
				let mut guard = player.lock().unwrap();
				guard.shutdown();
				guard.is_shutdown()
			})
		})
		.collect();
	assert!(closers.into_iter().all(|h| h.join().unwrap()));

	let latecomer = {
		let player = Arc::clone(&player);
		thread::spawn(move || {
			let mut guard = player.lock().unwrap();
			guard
				.play(&note("c4").unwrap(), &PlayOptions::default())
				.unwrap_err()
				.kind()
		})
	};
	assert_eq!(latecomer.join().unwrap(), ErrorKind::Closed);
}

#[test]
fn a_player_can_be_moved_to_another_thread_and_back() {
	let mut player = Player::new(&PlayerOptions::new().sample_rate(8_000)).unwrap();
	player
		.play(&note("a3").unwrap(), &PlayOptions::default())
		.unwrap();
	let mut player = thread::spawn(move || {
		let heard = player.render_seconds(0.2).unwrap();
		assert!(heard.peak() > 0.01);
		player
	})
	.join()
	.unwrap();
	player.shutdown();
	player.shutdown();
}
