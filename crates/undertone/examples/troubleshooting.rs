// Tips, gotchas, and troubleshooting: each tip of the guide, shown
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/troubleshooting.md`. Run it with `cargo run --example troubleshooting`.
//!
//! The browser-only tips (the first sound must follow a user gesture; a sample still decoding) have no Rust form:
//! there is no autoplay policy, and decoded PCM is handed over whole. The rest are demonstrated.

mod common;

use common::{Outcome, RATE, quick, render_and_save, save};
use undertone::prelude::*;

fn main() -> Outcome {
	// A sample layer is silent until its name is registered. An unregistered name is skipped, never an error, and
	// the engine gives one warning per name (`Engine::warnings`).
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE))?;
	player.play(&s("xyz")?, &PlayOptions::default())?;
	let silent = player.render_seconds(0.3)?;
	assert_eq!(silent.peak(), 0.0);
	let warnings: Vec<&str> = player
		.engine()?
		.warnings()
		.iter()
		.map(|warning| warning.message.as_str())
		.collect();
	println!("warnings: {warnings:?}");
	assert_eq!(warnings.len(), 1);
	save("troubleshooting-unregistered-sample", &silent)?;
	player.shutdown();

	// Notes in a loop are all short blips: the default envelope is percussive (`sustain` is 0), so there is nothing
	// to hold through the note length. Add `.sustain(0.3)` to hear event lengths at all.
	let blips = note("c3 ~ ~ ~")?.sound("sine");
	let held = blips.sustain(0.3)?;
	let short = render(&blips, &quick().bpm(240))?;
	let long = render(&held, &quick().bpm(240))?;
	let energy = |audio: &RenderedAudio| -> f64 {
		audio.channels()[0]
			.iter()
			.map(|s| f64::from(*s).powi(2))
			.sum()
	};
	assert!(energy(&long) > 2.0 * energy(&short));
	save("troubleshooting-sustain", &long)?;

	// A sample one-shot cuts off after a fraction of a second: only a loop gates envelopes by note length, a
	// one-shot releases right after the decay. Give a one-shot sample an explicit `.decay()` about as long as the
	// recording.
	let mut options = quick().bpm(240).gated(false);
	let pad = SampleData::new(
		RATE,
		vec![
			(0..(RATE * 0.5) as usize)
				.map(|i| ((i as f64) * 0.05).sin() as f32 * 0.5)
				.collect(),
		],
	);
	options.register_sample("pad", pad, None)?;
	let cut_off = render(&s("pad")?, &options)?;
	let whole = render(&s("pad")?.decay(0.5)?, &options)?;
	assert!(energy(&whole) > energy(&cut_off));

	// `.sound()` after `.s()` replaces the sample, deliberately: the two never both apply to one voice.
	let swapped = s("bd")?.sound("square");
	let haps = swapped.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	assert_eq!(
		haps[0].value.get("soundType"),
		Some(&Value::Str("square".into()))
	);
	assert_eq!(haps[0].value.get("sampleName"), None);

	// Two layers fight over reverb and delay character: `roomsize`, `delaytime`, and `delayfeedback` configure the
	// shared orbit bus, last writer wins. Distinct rooms need distinct `.orbit(n)` numbers.
	let fighting = stack(vec![
		note("c4")?.sound("sine").room(0.4)?.room_size(2)?,
		note("e4")?.sound("sine").room(0.4)?.room_size(9)?,
	]);
	let apart = stack(vec![
		note("c4")?
			.sound("sine")
			.room(0.4)?
			.room_size(2)?
			.orbit(1.0)?,
		note("e4")?
			.sound("sine")
			.room(0.4)?
			.room_size(9)?
			.orbit(2.0)?,
	]);
	render_and_save("troubleshooting-shared-room", &fighting, &quick().bpm(240))?;
	render_and_save("troubleshooting-separate-rooms", &apart, &quick().bpm(240))?;

	// A `~` in a patterned control is not zero: `.gain("1 ~")` leaves the second event's gain at its default.
	let rested = note("c3 e3")?.gain("1 ~")?;
	let haps = rested.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	assert_eq!(haps[0].value.get("gainLevel"), Some(&Value::Num(1.0)));
	assert_eq!(haps[1].value.get("gainLevel"), None);
	let resolved = resolve_params(&haps[1].value);
	assert_eq!(resolved.gain_level, 0.8, "the default, not silence");

	// Tempo maths: `bpm` counts four beats per cycle, so 120 bpm is a 2 second cycle. A cycle in cycles per
	// minute is the same thing: 30 is `bpm: 120`. An explicit `bpm` always wins over the default.
	let mut tempo = Tempo::new();
	assert_eq!(tempo.cycle_seconds(Some(120.0), None)?, 2.0);
	tempo.set_cpm(30.0)?;
	assert_eq!(tempo.cycle_seconds(None, None)?, 2.0);
	assert_eq!(tempo.cycle_seconds(Some(240.0), None)?, 1.0);

	// `stop` is not a hard mute: it stops scheduling, and voices already handed to the clock ring out. `Cut`
	// fades them out now.
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE))?;
	let sustained = note("c3")?.sound("sine").sustain(0.9)?;
	let loop_options = LoopOptions {
		bpm: Some(120.0),
		..LoopOptions::default()
	};
	let handle = player.play_loop(&sustained, &loop_options)?;
	player.render_seconds(0.3)?;
	player.stop_loop(handle, &LoopStop::default())?;
	let rings = player.render_seconds(0.5)?;
	assert!(rings.peak() > 0.05, "the booked note rings out");
	player.shutdown();
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE))?;
	let handle = player.play_loop(&sustained, &loop_options)?;
	player.render_seconds(0.3)?;
	player.stop_loop(
		handle,
		&LoopStop {
			voices: LoopVoices::Cut,
			fade: None,
		},
	)?;
	let cut = player.render_seconds(0.5)?;
	assert!(
		cut.channels()[0][(RATE * 0.2) as usize..]
			.iter()
			.all(|s| s.abs() < 1e-3)
	);
	player.shutdown();

	// Errors surface early by design: bad note names, chord symbols, scale specs, out-of-range pans, and
	// malformed numbers all fail when the pattern is built, and a bad base note fails at registration.
	for message in [
		note("h9").unwrap_err().to_string(),
		chord("Cmin").unwrap_err().to_string(),
		n("0 2")?.scale("x:minor").unwrap_err().to_string(),
		note("c3")?.pan(3).unwrap_err().to_string(),
		note("c3")?.gain("a").unwrap_err().to_string(),
		Samples::new()
			.register_sample(
				"x",
				SampleData::new(RATE, vec![vec![0.0; 4]]),
				Some(Pitch::Name("h9".into())),
			)
			.unwrap_err()
			.to_string(),
	] {
		println!("{message}");
	}

	// Patterns are immutable: `pat.fast(2)` returns a new pattern and leaves `pat` untouched.
	let original = note("c4 e4")?;
	let doubled = original.fast(2.0)?;
	let span = Span::new(Fraction::from_int(0), Fraction::from_int(1));
	assert_eq!(original.query(span).len(), 2);
	assert_eq!(doubled.query(span).len(), 4);
	Ok(())
}
