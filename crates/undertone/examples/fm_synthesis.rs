// FM synthesis: modulation index, harmonicity, the modulator envelope, and shaped waves
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/fm-synthesis.md`. Run it with `cargo run --example fm_synthesis`.

mod common;

use common::{Outcome, quick, render_and_save};
use undertone::prelude::*;

fn main() -> Outcome {
	// A glassy bell: an inharmonic ratio, a strong index, and a long ring-out. `.play()` is a one-shot, so the
	// notes are not gated.
	let bell = note("e5 b5 g5 d6")?
		.fm(1.4)?
		.fmh(3.5)?
		.attack(0.002)?
		.decay(0.6)?
		.release(0.8)?
		.gain(0.3)?;
	render_and_save("fm-bell", &bell, &quick().bpm(240).gated(false).tail(0.5))?;

	// The modulator envelope: a pluck that is bright at the start, then mellows to a soft tone.
	let pluck = note("a2 ~ a2 e2")?
		.sound("sine")
		.fm(4)?
		.fmh(1)?
		.fm_decay(0.15)?
		.fm_sustain(0.15)?
		.sustain(0.5)?
		.release(0.2)?;
	render_and_save("fm-pluck", &pluck, &quick().bpm(240))?;

	// `fmenv` and `fmwave` are chosen once for the pattern, and say so when given a bad name.
	let linear = note("a2")?.fm(3)?.fm_env("lin")?.fm_wave("triangle")?;
	render_and_save("fm-linear", &linear, &quick().bpm(480))?;
	println!("{}", note("a2")?.fm_env("slow").unwrap_err());

	// Pitch curves reach the modulator too: a laser zap with an FM edge.
	let zap = note("a3")?
		.fm(3)?
		.fmh(2)?
		.penv(-12)?
		.pdecay(0.25)?
		.decay(0.3)?;
	render_and_save("fm-zap", &zap, &quick().bpm(240).gated(false))?;

	// Shaped waveforms work as a voice's sound and as the modulator.
	let shaped = note("c3 e3 g3 e3")?
		.sound("abssine")
		.fm(1.5)?
		.fmh(2)?
		.fm_wave("halfsine")?;
	render_and_save("fm-shaped", &shaped, &quick().bpm(240))?;

	// The names are exported: the list of the three, and a test for a string.
	assert_eq!(SHAPED_WAVE_TYPES, ["halfsine", "abssine", "pulsesine"]);
	assert!(is_shaped_wave("halfsine") && !is_shaped_wave("square"));
	let first = note("c3 e3")?.sound(SHAPED_WAVE_TYPES[0]).sustain(0.3)?;
	render_and_save("fm-first-shaped", &first, &quick().bpm(240))?;

	// FM controls are validated when the pattern is built.
	println!("{}", note("a2")?.fm(-1).unwrap_err());
	Ok(())
}
