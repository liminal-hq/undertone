// Placement: surround, pan movement inside a note, autopan, and the pan law
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/stereo-and-surround.md`. Run it with `cargo run --example stereo_and_surround`.
//!
//! The guide's `enableMultichannel(ctx)` widens the destination to the hardware's channel count. A render has no
//! hardware, so it asks for the channel count it wants (`channels(8)`), which does the same.

mod common;

use common::{Outcome, RATE, quick, render_and_save, save};
use std::collections::BTreeMap;
use undertone::prelude::*;

/// A map value from `(key, value)` pairs, for a score event's own voice controls.
fn voice(fields: &[(&str, Value)]) -> Value {
	Value::Map(
		fields
			.iter()
			.map(|(key, value)| (key.to_string(), value.clone()))
			.collect::<BTreeMap<_, _>>(),
	)
}

fn main() -> Outcome {
	// Surround: `.surround(angle)` places each note at an angle round the room, in eight channels. Render with
	// eight channels (a 7.1 file) and the placement is discrete; on stereo it folds down.
	let ring = note("c4(5,8)")?.sound("triangle").surround(135.0)?;
	//
	// The master bus is off for it. A render goes through the master bus by default, whose input is a gain node
	// of two channels, so a placement made for eight is folded to stereo before it arrives (the reference
	// does the same: its voices read the channel count of the node they play into). The bus skips its limiter
	// above two channels anyway, so for a surround render `MasterSetting::Off` is the faithful route.
	let eight = render_and_save(
		"stereo-surround-8ch",
		&ring,
		&quick().bpm(240).channels(8).master(MasterSetting::Off),
	)?;
	assert_eq!(eight.channel_count(), 8);
	// 135 degrees is the rear right: the loudest channel is the one the gains name.
	let energy = |channel: usize| -> f64 {
		eight.channels()[channel]
			.iter()
			.map(|s| f64::from(*s).powi(2))
			.sum()
	};
	let loudest = (0..8)
		.max_by(|a, b| energy(*a).total_cmp(&energy(*b)))
		.unwrap();
	let widest = (0..8)
		.max_by(|a, b| {
			surround_gains(135.0).unwrap()[*a].total_cmp(&surround_gains(135.0).unwrap()[*b])
		})
		.unwrap();
	println!(
		"loudest channel: {} (the gains put most in {})",
		CHANNEL_ORDER[loudest], CHANNEL_ORDER[widest]
	);
	assert_eq!(loudest, widest, "the render follows the gains");
	let folded = render_and_save("stereo-surround-folded", &ring, &quick().bpm(240))?;
	assert_eq!(folded.channel_count(), 2);

	// The gains behind a placement: eight channel gains in a fixed order.
	let gains = surround_gains(135.0)?;
	let names: Vec<String> = CHANNEL_ORDER
		.iter()
		.zip(gains)
		.map(|(name, gain)| format!("{name}={gain:.2}"))
		.collect();
	println!("{MAX_CHANNELS} channels: {}", names.join(" "));
	println!("folded to stereo: {:?}", fold_to_stereo(&gains));

	// Pan in the Strudel style. A value per event: each note one step further along a slow sweep of the field.
	let sweep = note("c4*8")?
		.sound("triangle")
		.decay(0.2)?
		.pan(sine2().slow(2.0)?)?;
	render_and_save("stereo-pan-sweep", &sweep, &quick().bpm(240))?;

	// Moving the pan inside a note. Stepped: a fast left-right flutter, 30 frames a second, settling in the
	// centre. Ramped: each note sweeps from right to left over half a second.
	let stepped = note("c4 e4")?
		.sound("square")
		.sustain(0.5)?
		.pan_path(&[-0.8, 0.8, -0.8, 0.8, -0.4, 0.4, 0.0], Some(30.0))?;
	let ramped = note("a2")?
		.sound("sawtooth")
		.sustain(0.6)?
		.pan_path_points(&[(0.0, 1.0), (0.5, -1.0)])?;
	render_and_save(
		"stereo-pan-paths",
		&cat(vec![stepped, ramped]),
		&quick().cycles(2).bpm(240),
	)?;
	println!("{}", note("c4")?.pan_path(&[2.0], None).unwrap_err());

	// In a score event the points are in whole ticks from the onset: a wobble, then a jump to the centre.
	let wobble = Score::new(&ScoreDefinition {
		ticks_per_second: 100.0,
		length_ticks: 200.0,
		events: vec![ScoreEvent {
			gate: Some(160.0),
			voice: Some(voice(&[
				("soundType", Value::Str("triangle".into())),
				("sustain", Value::Num(0.8)),
			])),
			pan_path: Some(
				[
					(0.0, -0.6),
					(40.0, 0.6),
					(80.0, -0.6),
					(120.0, 0.6),
					(160.0, 0.6),
					(160.0, 0.0),
				]
				.into_iter()
				.map(|(tick, pan)| ScorePanPoint { tick, pan })
				.collect(),
			),
			..ScoreEvent::note(0.0, ScoreNote::Name("e3".into()))
		}],
		..ScoreDefinition::default()
	})?;
	save("stereo-score-pan-path", &render_score(&wobble, &quick())?)?;

	// In plain voice data, as `playParams` takes it, the points are in seconds from the voice's start: a
	// one-second sweep from right to left. `Engine::play` books a `VoiceParams` directly.
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE))?;
	player.engine_mut()?.play(
		&VoiceParams {
			sound_type: Some(SoundType::Sawtooth),
			pitch: Some(Pitch::Name("a2".into())),
			sustain: 0.6,
			duration: Some(1.0),
			pan_path: Some(vec![
				PanPoint {
					time: 0.0,
					pan: 1.0,
				},
				PanPoint {
					time: 1.0,
					pan: -1.0,
				},
			]),
			..VoiceParams::empty()
		},
		0.0,
	)?;
	let sweep = player.render_seconds(1.2)?;
	save("stereo-voice-params-sweep", &sweep)?;
	// Right to left: more energy on the right in the first half, on the left in the second.
	let half = sweep.frames() / 3;
	let rms = |channel: &[f32]| channel.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
	assert!(rms(&sweep.channels()[1][..half]) > rms(&sweep.channels()[0][..half]));
	assert!(rms(&sweep.channels()[0][2 * half..]) > rms(&sweep.channels()[1][2 * half..]));
	player.shutdown();

	// Pan slide: each note starts at pan `from` and moves to its own pan over `seconds`. Every hit flies in from
	// the left to where it sits.
	let slide = note("c3*4")?
		.sound("square")
		.decay(0.3)?
		.pan(0.4)?
		.pan_slide(-1, Some(0.15))?;
	render_and_save("stereo-pan-slide", &slide, &quick().bpm(240))?;

	// Autopan: an LFO on the panner. A pad that drifts slowly from side to side around the centre.
	let drifting = note("<c3 a2>")?
		.sound("triangle")
		.sustain(0.8)?
		.autopan(0.25)?
		.autopan_depth(0.7)?
		.autopan_shape("triangle")?;
	render_and_save("stereo-autopan", &drifting, &quick().cycles(2).bpm(240))?;
	let cue = Score::new(&ScoreDefinition {
		ticks_per_second: 100.0,
		length_ticks: 200.0,
		events: vec![ScoreEvent {
			gate: Some(200.0),
			pan: Some(0.2),
			autopan: Some(ScoreAutopan {
				period_ticks: 50.0,
				depth: 0.5,
				shape: None,
				phase: None,
			}),
			..ScoreEvent::note(0.0, ScoreNote::Name("e3".into()))
		}],
		..ScoreDefinition::default()
	})?;
	save("stereo-score-autopan", &render_score(&cue, &quick())?)?;

	// Pan law: how loud a voice is on each side as it moves across. A balance-control feel: the centre stays full
	// on both sides.
	let balance = note("c3 e3 g3 b3")?
		.sound("triangle")
		.pan("-1 -0.5 0.5 1")?
		.pan_law(0.0)?;
	render_and_save("stereo-pan-law", &balance, &quick().bpm(240))?;
	println!("{}", note("c3")?.pan_law(-9.0).unwrap_err());
	Ok(())
}
