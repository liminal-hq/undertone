// Melody and harmony: scale degrees, chord symbols, and the pitch helpers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/melody-and-harmony.md`. Run it with `cargo run --example melody_and_harmony`.

mod common;

use common::{Outcome, quick, render_and_save};
use undertone::prelude::*;

fn main() -> Outcome {
	// Scale degrees. `n('0 2 4 <7 -3>').scale('d5:minor')`: degrees past the scale's length wrap up an octave and
	// negative degrees descend.
	let run = n("0 2 4 <7 -3>")?
		.scale("d5:minor")?
		.sound("triangle")
		.sustain(0.3)?;
	render_and_save("melody-scale-degrees", &run, &quick().cycles(2).bpm(240))?;

	// Chord symbols. `.voicing()` expands each one into simultaneous pitched notes, anchored around middle C by
	// default; `VoicingOptions::anchor_name("g4")` moves the anchor.
	let progression = chord("<Dm9 BbM7 Gm9 A7sus>")?
		.voicing(VoicingOptions::default())
		.sound("sine")
		.sustain(0.8)?
		.gain(0.35)?;
	let bass = note("<d2 bb1 g1 a1>(3,8)")?
		.sound("square")
		.sustain(0.2)?
		.lpf(500)?
		.gain(0.5)?;
	let melody = n("<0 2 4 5 4 2 1 0>*2 ~")?
		.scale("d5:minor")?
		.sound("triangle")
		.sustain(0.25)?
		.gain(0.3)?;

	// A progression, a bassline, and a melody are three patterns stacked. At 480 bpm a cycle is half a second, so
	// four cycles (the whole progression) take two seconds.
	let song = stack(vec![progression.clone(), bass, melody]);
	render_and_save("melody-and-harmony", &song, &quick().cycles(4).bpm(480))?;

	// Chords are just notes: the first cycle of the progression, read as pitches.
	let first = progression.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	let pitches: Vec<String> = first
		.iter()
		.filter_map(|hap| hap.value.get("pitch"))
		.map(|pitch| format!("{pitch:?}"))
		.collect();
	println!(
		"Dm9 voices into {} notes: {}",
		first.len(),
		pitches.join(" ")
	);

	// Note names, MIDI numbers, and frequencies: three small helpers.
	let root = note_to_midi("a2")?; // 45
	assert_eq!(root, 45.0);
	let cutoff = midi_to_frequency(root + 24.0); // two octaves above the root, in hertz
	assert_eq!(note_to_frequency("a4")?, 440.0);

	// A bass line whose filter sits at the pitch of a4 rather than a magic number.
	let filtered = note("a2 a2 c3 e3")?
		.sound("sawtooth")
		.sustain(0.3)?
		.lpf(note_to_frequency("a4")?)?;
	render_and_save("melody-pitch-helpers", &filtered, &quick().bpm(240))?;
	let one = note("a4")?.sound("sine").lpf(cutoff)?;
	render_and_save("melody-pitch-cutoff", &one, &quick().bpm(480).gated(false))?;
	Ok(())
}
