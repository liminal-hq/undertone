// What the output delivers: the player's own samples, in place, and a clean open and close, all with no device
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Drives [`Output`] with a [`ManualSink`] and a fake audio callback, so no sound card is needed.
//!
//! Nothing here listens to anything: the tests compare the stream against the same player rendered offline.

use undertone::prelude::*;
use undertone_native::{
	AudioCallback, ManualSink, NativeError, Output, OutputOptions, Sink, StreamFormat,
};

const RATE: u32 = 16_000;
const FORMAT: StreamFormat = StreamFormat::new(RATE, 2);

/// A player that loops four notes at 240 bpm (a one-second cycle). The same call twice gives the same audio.
fn looping_player() -> Player {
	let mut player = Player::new(&FORMAT.player_options()).unwrap();
	player
		.play_loop(
			&note("c3 e3 g3 c4").unwrap().sound("triangle"),
			&LoopOptions {
				bpm: Some(240.0),
				..LoopOptions::default()
			},
		)
		.unwrap();
	player
}

/// Pulls `frames` frames through the fake callback, in odd-sized buffers, waiting for the ring each time so the
/// pull never outruns the control thread.
fn pull(driver: &undertone_native::ManualDriver, frames: usize) -> Vec<f32> {
	let mut stream = Vec::with_capacity(frames * 2);
	let sizes = [480, 512, 333, 1024, 77];
	let mut turn = 0;
	while stream.len() < frames * 2 {
		let size = sizes[turn % sizes.len()].min(frames - stream.len() / 2);
		turn += 1;
		assert!(driver.wait_for_frames(size), "the control thread stalled");
		let mut buffer = vec![0.0_f32; size * 2];
		driver.fill(&mut buffer);
		stream.extend_from_slice(&buffer);
	}
	stream
}

fn first_sound(interleaved: &[f32]) -> usize {
	interleaved
		.chunks(2)
		.position(|frame| frame.iter().any(|sample| *sample != 0.0))
		.expect("the stream has sound")
}

#[test]
fn the_stream_is_the_players_own_samples_in_place() {
	let frames = RATE as usize * 3 / 2;
	let reference = {
		let mut player = looping_player();
		player.render_seconds(1.5).unwrap().interleaved()
	};
	let (sink, driver) = ManualSink::new(FORMAT);
	let mut output = Output::open(sink, looping_player(), &OutputOptions::default()).unwrap();
	let stream = pull(&driver, frames);
	let health = output.health();
	output.close();

	assert_eq!(health.underruns(), 0, "the pull waited for the ring");
	assert_eq!(health.frames_played(), frames as u64);
	assert_eq!(stream.len(), reference.len());
	let wrong = stream
		.iter()
		.zip(&reference)
		.filter(|(a, b)| a != b)
		.count();
	assert_eq!(wrong, 0, "samples that differ from the offline render");
}

#[test]
fn position_error_against_the_sample_clock_is_under_a_millisecond() {
	let reference = {
		let mut player = looping_player();
		player.render_seconds(1.0).unwrap().interleaved()
	};
	let (sink, driver) = ManualSink::new(FORMAT);
	let mut output = Output::open(sink, looping_player(), &OutputOptions::default()).unwrap();
	let stream = pull(&driver, RATE as usize);
	output.close();

	let expected = first_sound(&reference);
	let heard = first_sound(&stream);
	// The first onset is booked 0.1 s in (the scheduler's start latency); that is the position to hit.
	assert!(
		expected >= (RATE as usize) / 10 - 2,
		"the reference starts at 0.1 s"
	);
	let error_seconds = (heard as f64 - expected as f64).abs() / f64::from(RATE);
	assert!(
		error_seconds < 0.001,
		"first sound at frame {heard}, expected {expected}"
	);
}

#[test]
fn a_pattern_played_after_opening_is_heard() {
	let (sink, driver) = ManualSink::new(FORMAT);
	let player = Player::new(&FORMAT.player_options()).unwrap();
	let mut output = Output::open(sink, player, &OutputOptions::default()).unwrap();
	output.with_player(|player| {
		player
			.play(
				&note("c4").unwrap().sound("triangle"),
				&PlayOptions::default(),
			)
			.unwrap();
	});
	let stream = pull(&driver, RATE as usize);
	output.close();
	assert!(stream.iter().any(|sample| *sample != 0.0));
	assert!(output.take_error().is_none());
}

#[test]
fn it_opens_and_closes_twice() {
	for round in 0..2 {
		let (sink, driver) = ManualSink::new(FORMAT);
		let mut output = Output::open(sink, looping_player(), &OutputOptions::default()).unwrap();
		assert!(output.is_open(), "round {round}");
		assert!(driver.wait_for_frames(256));
		output.close();
		output.close();
		assert!(!output.is_open());
		assert_eq!(driver.buffered_frames(), 0, "the sink dropped its callback");
		// The player is kept, and can be shut down by its owner.
		output.with_player(Player::shutdown);
	}
}

#[test]
fn dropping_the_output_closes_it() {
	let (sink, driver) = ManualSink::new(FORMAT);
	let output = Output::open(sink, looping_player(), &OutputOptions::default()).unwrap();
	assert!(driver.health().is_some());
	drop(output);
	assert!(driver.health().is_none());
}

#[test]
fn a_player_at_another_rate_is_refused() {
	let (sink, _driver) = ManualSink::new(FORMAT);
	let player = Player::new(&PlayerOptions::new().sample_rate(8_000)).unwrap();
	let error = Output::open(sink, player, &OutputOptions::default()).unwrap_err();
	assert!(matches!(error, NativeError::Format(_)), "{error}");
}

#[test]
fn a_shut_down_player_is_refused() {
	let (sink, _driver) = ManualSink::new(FORMAT);
	let mut player = Player::new(&FORMAT.player_options()).unwrap();
	player.shutdown();
	let error = Output::open(sink, player, &OutputOptions::default()).unwrap_err();
	assert!(matches!(error, NativeError::Player(_)), "{error}");
}

#[test]
fn bad_options_are_refused() {
	for options in [
		OutputOptions::new().block_frames(0),
		OutputOptions::new().buffer_seconds(0.0),
		OutputOptions::new().buffer_seconds(f64::NAN),
	] {
		let (sink, _driver) = ManualSink::new(FORMAT);
		let error = Output::open(sink, looping_player(), &options).unwrap_err();
		assert!(matches!(error, NativeError::Format(_)), "{error}");
	}
}

/// A sink that cannot start, to check the control thread is stopped and the error comes back.
struct Refusing;

impl Sink for Refusing {
	fn format(&self) -> StreamFormat {
		FORMAT
	}
	fn start(&mut self, _callback: AudioCallback) -> Result<(), NativeError> {
		Err(NativeError::Stream("refused".into()))
	}
	fn stop(&mut self) {}
}

#[test]
fn a_sink_that_fails_to_start_reports_it_and_leaves_no_thread_running() {
	let error = Output::open(Refusing, looping_player(), &OutputOptions::default()).unwrap_err();
	assert_eq!(error, NativeError::Stream("refused".into()));
}

#[test]
fn a_mono_player_fills_every_device_channel_and_extra_channels_are_silent() {
	// A mono player on a stereo device is copied to both channels.
	let format = StreamFormat::new(RATE, 2);
	let (sink, driver) = ManualSink::new(format);
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE).channels(1)).unwrap();
	player
		.play(
			&note("c4").unwrap().sound("triangle"),
			&PlayOptions::default(),
		)
		.unwrap();
	let mut output = Output::open(sink, player, &OutputOptions::default()).unwrap();
	let stream = pull(&driver, RATE as usize);
	output.close();
	assert!(stream.iter().any(|sample| *sample != 0.0));
	assert!(stream.chunks(2).all(|frame| frame[0] == frame[1]));

	// A stereo player on a four-channel device leaves channels 2 and 3 silent.
	let format = StreamFormat::new(RATE, 4);
	let (sink, driver) = ManualSink::new(format);
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE)).unwrap();
	player
		.play(
			&note("c4").unwrap().sound("triangle"),
			&PlayOptions::default(),
		)
		.unwrap();
	let mut output = Output::open(sink, player, &OutputOptions::default()).unwrap();
	let mut frames = Vec::new();
	for _ in 0..40 {
		assert!(driver.wait_for_frames(400));
		let mut buffer = vec![0.0_f32; 400 * 4];
		driver.fill(&mut buffer);
		frames.extend_from_slice(&buffer);
	}
	output.close();
	assert!(frames.chunks(4).any(|frame| frame[0] != 0.0));
	assert!(
		frames
			.chunks(4)
			.all(|frame| frame[2] == 0.0 && frame[3] == 0.0)
	);
}
