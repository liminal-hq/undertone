// Instruments as data, layering, scores with exact timing, repeatable variation, and a mono check
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/instruments-and-scores.md`. Run it with `cargo run --example instruments_and_scores`.

mod common;

use common::{Outcome, RATE, quick, render_and_save, save};
use undertone::prelude::*;

fn main() -> Outcome {
	// An FM instrument kept as plain data. `fm_voice` takes a Tone.js-shaped definition and gives a patch you can
	// apply with `.voice(&patch)`, save, and reload.
	let bell = fm_voice(&FmVoiceDefinition {
		harmonicity: Some(3.5),
		modulation_index: Some(5.0),
		envelope: EnvelopeDefinition {
			attack: Some(0.002),
			decay: Some(0.7),
			sustain: Some(0.0),
			release: Some(0.9),
		},
		modulation_envelope: EnvelopeDefinition {
			decay: Some(0.35),
			release: Some(0.2),
			..EnvelopeDefinition::default()
		},
		level: Some(0.3),
		..FmVoiceDefinition::default()
	})?;
	render_and_save(
		"instruments-bell",
		&note("e5 g5 b5 a5")?.voice(&bell),
		&quick().bpm(240),
	)?;

	// Or start from a preset and change one thing (`{ ...fmPresets.roundBass, gainLevel: 0.6 }`).
	let mut round_bass = fm_presets().round_bass;
	if let Value::Map(fields) = &mut round_bass {
		fields.insert("gainLevel".into(), Value::Num(0.6));
	}
	render_and_save(
		"instruments-round-bass",
		&note("e2 ~ e2 b1")?.voice(&round_bass),
		&quick().bpm(240),
	)?;
	assert_eq!(fm_presets().get("pluck"), Some(&fm_presets().pluck));

	// Layering: a pluck and a sustained partner on the same notes sound far fuller than either alone.
	let presets = fm_presets();
	let layered = layer(
		&note("e5 g5 b5 a5")?,
		&[presets.pluck.clone(), presets.soft_pad.clone()],
		&LayerOptions {
			stagger: Some(0.002),   // the second layer starts 2 ms later: width, not an echo
			levels: vec![1.0, 0.6], // the pluck leads, the pad fills in
			pans: vec![-0.3, 0.3],
		},
	)?;
	render_and_save("instruments-layered", &layered, &quick().bpm(240))?;

	// Scores with exact timing: events at whole ticks, any rate you choose. This is four seconds at 560 ticks a
	// second in the guide; here a one-second cue at 560 ticks, so the example stays quick.
	let cue = Score::new(&ScoreDefinition {
		ticks_per_second: 560.0,
		length_ticks: 560.0,
		events: vec![
			ScoreEvent {
				gate: Some(70.0),
				voice: Some(presets.lead.clone()),
				..ScoreEvent::note(0.0, ScoreNote::Name("e4".into()))
			},
			ScoreEvent {
				gate: Some(70.0),
				level: Some(0.7),
				voice: Some(presets.lead.clone()),
				..ScoreEvent::note(211.0, ScoreNote::Name("g4".into()))
			},
			ScoreEvent {
				gate: Some(140.0),
				pan: Some(-0.1),
				voice: Some(presets.round_bass.clone()),
				..ScoreEvent::midi(280.0, 52.0)
			},
		],
		..ScoreDefinition::default()
	})?;
	// The score's tempo is its own: `cps` is ticks per second over the length in ticks.
	assert_eq!(cue.cps(), 1.0);
	assert_eq!(cue.seconds(), 1.0);
	let audio = render_score(&cue, &quick().tail(0.5))?;
	save("instruments-score", &audio)?;

	// `cue.loop()` and `cue.play()` are a player's `loop_score` and `play_score`: each pass lands on the clock.
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE))?;
	let handle = player.loop_score(&cue)?;
	save("instruments-score-loop", &player.render_seconds(1.5)?)?;
	player.stop_loop(handle, &LoopStop::default())?;
	player.shutdown();

	// A score refuses an event it cannot place, with the reference's message.
	let bad = Score::new(&ScoreDefinition {
		events: vec![ScoreEvent::note(0.5, ScoreNote::Name("c4".into()))],
		..ScoreDefinition::default()
	});
	println!("{}", bad.unwrap_err());

	// Repeatable variation: `drift` adds small per-note differences in timing, level, pitch, and pan, all from a
	// seed. The same seed gives the same notes on every device.
	let groove = drift(
		&note("c2 ~ c2 g1")?,
		DriftOptions {
			timing: 0.006, // up to 6 ms either way
			level: 0.1,    // up to 10% either way
			cents: 6.0,
			..DriftOptions::new("level-1-bass")
		},
	)?;
	render_and_save("instruments-drift", &groove, &quick().bpm(240))?;

	// Checking a mix in mono. `create_mono_fold` makes a node that folds whatever plays into it down to one
	// channel; pass it as the `output` of a play.
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE))?;
	let fold = {
		let engine = player.engine_mut()?;
		let into = engine.output();
		create_mono_fold(engine.graph_mut(), into)
	};
	player.play(
		&note("c4 e4")?.sound("triangle").pan("-1 1")?,
		&PlayOptions {
			bpm: Some(240.0),
			output: Some(fold),
			..PlayOptions::default()
		},
	)?;
	let mono = player.render_seconds(1.0)?;
	assert_eq!(
		mono.channels()[0],
		mono.channels()[1],
		"a fold has one channel's worth of signal"
	);
	save("instruments-mono-check", &mono)?;
	player.shutdown();
	Ok(())
}
