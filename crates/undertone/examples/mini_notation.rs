// Mini-notation, one step at a time
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/mini-notation.md`. Run it with `cargo run --example mini_notation`.
//!
//! `note`, `sound`, `n`, `chord`, and `s` all take a mini-notation string. Each snippet of the guide's `.loop()`
//! examples becomes one short render here: a loop is a render whose notes are gated by their event's length,
//! which is what `render` does by default.

mod common;

use common::{Outcome, quick, render_and_save};
use undertone::prelude::*;

fn main() -> Outcome {
	// Two seconds of audio at 240 bpm: two one-second cycles, enough to hear an alternation change.
	let two_cycles = quick().cycles(2).bpm(240);

	// Sequence: space-separated steps divide the cycle equally.
	let sequence = note("c4 e4 g4 b4")?.sound("triangle");
	render_and_save("mini-sequence", &sequence, &two_cycles)?;

	// Rests: `~` is a step of silence.
	let rests = note("c4 ~ e4 ~")?.sound("triangle");
	render_and_save("mini-rests", &rests, &two_cycles)?;

	// Subdivision: square brackets nest a sequence inside one step.
	let subdivision = note("c4 [e4 g4] c4 [e4 g4 b4]")?.sound("triangle");
	render_and_save("mini-subdivision", &subdivision, &two_cycles)?;

	// Alternation: angle brackets play a different child each cycle. `.play()` plays cycle zero only, so an
	// alternation in a one-shot always plays its first option; a render of two cycles plays both.
	let alternation = note("c3 e3 g3 <b3 c4>")?.sound("triangle");
	let heard = render_and_save("mini-alternation", &alternation, &two_cycles)?;
	assert!(heard.peak() > 0.01);
	let cycle_pitches = |cycle: i128| -> Vec<Value> {
		alternation
			.query(Span::new(
				Fraction::from_int(cycle),
				Fraction::from_int(cycle + 1),
			))
			.iter()
			.filter_map(|hap| hap.value.get("pitch").cloned())
			.collect()
	};
	assert_eq!(cycle_pitches(0)[3], Value::Str("b3".into()));
	assert_eq!(cycle_pitches(1)[3], Value::Str("c4".into()));

	// Chords and layers: a comma means "at the same time".
	let chords = note("<[c3,e3,g3] [a2,c3,e3]>")?
		.sound("sine")
		.sustain(0.8)?;
	render_and_save("mini-chords", &chords, &two_cycles)?;
	let polyrhythm = note("[c4 e4 g4, c2 f2]")?.sound("triangle"); // 3 against 2
	render_and_save("mini-polyrhythm", &polyrhythm, &two_cycles)?;

	// Speed, replication, elongation: `a*2`, `a/2`, `a!3`, `a@3`.
	let elongation = note("c4@3 g4")?.sound("triangle"); // long c, short g
	render_and_save("mini-elongation", &elongation, &two_cycles)?;

	// Euclidean rhythms: `a(3,8)` spreads 3 onsets over 8 slots; a third argument rotates the result.
	let euclid = note("[c2(3,8), g2(5,8,2), c4(7,16,4)]")?
		.sound("square")
		.sustain(0.12)?
		.lpf(900)?;
	render_and_save("mini-euclid", &euclid, &two_cycles)?;

	// Everything composes: alternate, double, and rest in one string.
	let composed = note("<c5 e5 g5 b5 a5 g5>*2 ~")?.sound("triangle");
	render_and_save("mini-composed", &composed, &two_cycles)?;

	// A bad string fails when the pattern is built, with the position of the mistake.
	let error = note("c4 [e4").unwrap_err();
	println!("a bad string: {error}");
	Ok(())
}
