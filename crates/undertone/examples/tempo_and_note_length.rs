// Looping, note length, and tempo
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/tempo-and-note-length.md`. Run it with `cargo run --example tempo_and_note_length`.
//!
//! The tempo is explicit in Rust (decision D-29): there is no global `setcpm`. A `bpm` or `cps` on a call wins,
//! otherwise the `Player` (or the render options' `default_cpm`) holds the default.

mod common;

use common::{Outcome, RATE, quick, render_and_save, save};
use undertone::prelude::*;

fn main() -> Outcome {
	// A one-shot and a loop treat the envelope differently. In a one-shot the release starts as soon as the decay
	// lands (percussive, no hold). In a loop each event is gated by its length. A whole note and a sixteenth note
	// built from the same voice sound different in a loop; in a one-shot they would be identical blips.
	let held = note("c3 [e3 g3]")?.sound("sine").sustain(0.8)?;
	let one_shot = render_and_save("tempo-one-shot", &held, &quick().bpm(240).gated(false))?;
	let looped = render_and_save("tempo-gated", &held, &quick().bpm(240))?;
	let energy = |audio: &RenderedAudio| -> f64 {
		audio.channels()[0]
			.iter()
			.map(|s| f64::from(*s).powi(2))
			.sum()
	};
	assert!(
		energy(&looped) > 2.0 * energy(&one_shot),
		"a held note carries more sound than a blip"
	);

	// The practical consequence: a held sound in a loop needs a non-zero sustain. With the default sustain of 0
	// there is nothing to hold, so the voice is silent after its decay whatever its length.
	let blip = note("c3")?.sound("sine");
	let quiet_tail = render(&blip, &quick().bpm(240))?;
	assert!(
		quiet_tail.channels()[0][(RATE * 0.8) as usize..]
			.iter()
			.all(|s| s.abs() < 1e-3)
	);

	// A small piece of music: chords, a melody with `every` and `jux`, and a euclidean bass.
	let music = stack(vec![
		note("<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>")?
			.sound("sine")
			.sustain(0.8)?,
		note("c5 [e5 g5] <b5 a5> ~")?
			.sound("triangle")
			.every(2.0, |pattern| pattern.rev())?
			.jux(|pattern| pattern.rev())?
			.gain(0.4)?,
		note("c2(3,8)")?.sound("square").lpf(400)?,
	]);

	// A loop on a player: tempo is `bpm` (four beats a cycle, so 110 bpm is a 2.18 s cycle) on the call...
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE))?;
	let handle = player.play_loop(
		&music,
		&LoopOptions {
			bpm: Some(440.0), // a half-second cycle, so two seconds is four passes
			..LoopOptions::default()
		},
	)?;
	save("tempo-loop", &player.render_seconds(2.0)?)?;
	player.stop_loop(handle, &LoopStop::default())?;

	// ...or set once on the player in cycles per minute, as `setcpm` does: 120 cycles a minute is a half-second
	// cycle too (`setcpm(30)` is the same speed as `bpm: 120`). An explicit `bpm` on any call still wins, and
	// `reset_tempo` clears the override.
	player.set_cpm(120.0)?;
	let handle = player.play_loop(&music, &LoopOptions::default())?;
	save("tempo-loop-cpm", &player.render_seconds(2.0)?)?;
	player.stop_loop(handle, &LoopStop::default())?;
	player.reset_tempo();
	assert_eq!(player.tempo().default_cpm(), None);

	// `stop()` stops scheduling: voices already handed to the clock (about a third of a second of look-ahead)
	// finish their envelopes and ring out. A cut fades them now instead.
	let handle = player.play_loop(
		&held,
		&LoopOptions {
			bpm: Some(240.0),
			..LoopOptions::default()
		},
	)?;
	let before = player.render_seconds(0.5)?;
	player.stop_loop(handle, &LoopStop::default())?; // rings out
	let ringing = player.render_seconds(0.5)?;
	save("tempo-stop-rings-out", &ringing)?;
	assert!(before.peak() > 0.0);
	player.stop()?; // a hard stop of everything
	player.shutdown();

	// The same default tempo goes into a render through the options.
	let cpm = render(&held, &quick().default_cpm(120))?;
	let bpm = render(&held, &quick().bpm(480))?;
	assert_eq!(cpm, bpm, "`default_cpm: 120` is `bpm: 480`");

	// Pattern-level transforms only reveal themselves over multiple cycles: fast, slow, rev, every, euclid, jux.
	let transformed = note("c4 e4 g4 b4")?
		.sound("triangle")
		.fast(2.0)?
		.euclid(3.0, 4.0, 0.0)?;
	render_and_save("tempo-transforms", &transformed, &quick().bpm(240))?;

	// A tempo that is not positive fails with the reference's message.
	println!(
		"{}",
		Player::new(&PlayerOptions::new())?
			.set_cpm(0.0)
			.unwrap_err()
	);
	Ok(())
}
