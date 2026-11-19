// Getting started: your first sound, a layered one-shot, and a look inside a pattern
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/getting-started.md`. Run it with `cargo run --example getting_started`.
//!
//! In the TypeScript a pattern ends in `.play()` (one cycle, once) or `.loop({ bpm })`. In Rust nothing makes
//! sound until you ask for samples: `render` turns a pattern into audio, and a `Player` plays one on a clock.
//! Both are shown. The pattern is the same object either way.

mod common;

use common::{Outcome, quick, render_and_save, save};
use undertone::prelude::*;

fn main() -> Outcome {
	// Your first sound. `note('c5').sound('triangle').decay(0.1).gain(0.5).play()`: a one-shot is percussive,
	// so render it with `gated(false)`. A cycle at 240 bpm lasts one second.
	let first = note("c5")?.sound("triangle").decay(0.1)?.gain(0.5)?;
	render_and_save(
		"getting-started-first-sound",
		&first,
		&quick().bpm(240).gated(false),
	)?;

	// A richer one-shot: layer voices with `stack`. A low thunk, a high sparkle, and a noise click, all starting
	// together (the playground's "Place Building").
	let place_building = stack(vec![
		note("c2")?
			.sound("triangle")
			.attack(0.001)?
			.decay(0.1)?
			.release(0.05)?
			.gain(0.9)?
			.lpf(220)?
			.slide(0.07)?,
		note("c6")?
			.sound("sine")
			.attack(0.001)?
			.decay(0.15)?
			.gain(0.3)?
			.lpf(2000)?
			.nudge(0.02)?,
		sound("white")?
			.attack(0)?
			.decay(0.02)?
			.release(0.01)?
			.gain(0.4)?
			.lpf(4000)?,
	]);
	render_and_save(
		"getting-started-place-building",
		&place_building,
		&quick().bpm(240).gated(false).tail(0.2),
	)?;

	// The same thing through a `Player`, which is the Rust `.play()`: one cycle, once, on a clock. Here the
	// clock is the offline one, so asking for half a second of audio plays half a second.
	let mut player = Player::new(&PlayerOptions::new().sample_rate(common::RATE))?;
	player.play(&first, &PlayOptions::default())?;
	let heard = player.render_seconds(0.5)?;
	save("getting-started-player", &heard)?;
	player.shutdown();

	// Looking inside a pattern. A pattern is a function from a span of time to events (haps), so you can ask it
	// what it holds without playing it. `hap.has_onset()` is the test the scheduler uses to start a voice.
	let pattern = note("c4 e4")?.sound("triangle");
	let first_half = pattern.query(Span::new(Fraction::from_int(0), Fraction::new(1, 2)));
	assert_eq!(
		first_half.iter().map(Hap::has_onset).collect::<Vec<_>>(),
		[true]
	);
	// Starting a quarter of the way in lands part-way through that event: no onset.
	let late = pattern.query(Span::new(Fraction::new(1, 4), Fraction::new(1, 2)));
	assert_eq!(late.iter().map(Hap::has_onset).collect::<Vec<_>>(), [false]);
	println!("a hap is {:?}", first_half[0].value);
	Ok(())
}
