// Arranging songs: sections of whole cycles, played back to back
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/arranging-songs.md`. Run it with `cargo run --example arranging_songs`.

mod common;

use common::{Outcome, quick, render_and_save};
use undertone::prelude::*;

fn main() -> Outcome {
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

	let intro = progression.clone();
	let verse = stack(vec![progression.clone(), bass.clone(), melody]);
	let outro = stack(vec![progression, bass]);
	let (intro_again, verse_again, outro_again) = (intro.clone(), verse.clone(), outro.clone());

	// A 4-cycle intro, an 8-cycle verse, and a 4-cycle outro: 16 cycles. The song loops once the total is reached.
	let song = arrange(vec![(4.0, intro), (8.0, verse), (4.0, outro)])?;

	// Each section experiences its own cycles from zero when its span begins: the verse's alternation opens on
	// Dm9 even though the verse starts at overall cycle 4.
	let chord_at = |cycle: i128| -> Value {
		let haps = song.query(Span::new(
			Fraction::from_int(cycle),
			Fraction::from_int(cycle + 1),
		));
		haps.iter()
			.find_map(|hap| hap.value.get("pitch").cloned())
			.expect("the song plays something every cycle")
	};
	assert_eq!(
		chord_at(0),
		chord_at(4),
		"the verse opens where the intro did"
	);
	assert_eq!(chord_at(0), chord_at(16), "and the arrangement loops");

	// 16 cycles is about 40 seconds at 96 bpm, too long for an example. The same three sections at one, two, and
	// one cycles, at 480 bpm (a half-second cycle), are two seconds that pass through every seam.
	let short = arrange(vec![
		(1.0, intro_again),
		(2.0, verse_again),
		(1.0, outro_again),
	])?;
	render_and_save("arranging-song", &short, &quick().cycles(4).bpm(480))?;

	// `arrange` returns an ordinary pattern, so everything composes: `.fast(2)` on a whole arrangement, or an
	// arrangement inside an arrangement.
	let nested = arrange(vec![
		(2.0, arrange(vec![(1.0, note("c4")?), (1.0, note("g4")?)])?),
		(2.0, note("e4")?),
	])?;
	render_and_save(
		"arranging-nested",
		&nested.fast(2.0)?,
		&quick().cycles(2).bpm(240),
	)?;

	// A section length must be a positive whole number of cycles.
	println!("{}", arrange(vec![(0.5, note("c4")?)]).unwrap_err());
	Ok(())
}
