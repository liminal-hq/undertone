// Samples: bring your own recordings, as decoded PCM
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/samples.md`. Run it with `cargo run --example samples`.
//!
//! Undertone bundles no samples and fetches nothing. In the browser the package fetches and decodes a URL; in
//! Rust the host hands over decoded PCM (decision D-30), which is the same registry minus the fetch. The
//! example makes its own drum kit and bass note as PCM so that it needs no files.

mod common;

use common::{Outcome, RATE, quick, render_and_save, save};
use undertone::prelude::*;

/// One recording of `seconds` made by `shape(t, fall)`, where `t` is the time in seconds and `fall` goes from 1
/// to 0 over the recording.
fn recording(seconds: f64, mut shape: impl FnMut(f64, f64) -> f64) -> SampleData {
	let frames = (RATE * seconds) as usize;
	let samples = (0..frames)
		.map(|i| shape(i as f64 / RATE, 1.0 - i as f64 / frames as f64) as f32)
		.collect();
	SampleData::new(RATE, vec![samples])
}

fn main() -> Outcome {
	let mut noise = seeded_random("kit");
	// A kick: a sine that falls in pitch. A snare: noise with a body. A hat: short, bright noise.
	let kick = recording(0.2, |t, fall| {
		(std::f64::consts::TAU * (50.0 + 90.0 * fall * fall) * t).sin() * fall
	});
	let snare = recording(0.15, |_, fall| (noise.next_value() * 2.0 - 1.0) * fall);
	let hat = recording(0.04, |_, fall| {
		(noise.next_value() * 2.0 - 1.0) * fall * fall * 0.6
	});
	// A pitched bass recording: a sine at E2 (82.41 Hz) with a slow fall, which sounds at e2.
	let bass = recording(0.4, |t, fall| {
		(std::f64::consts::TAU * 82.406_889 * t).sin() * fall
	});

	// Register names, then play them with `s()` exactly like synth voices. `register_sample(name, data,
	// base_note)`: the base note declares the pitch the recording actually sounds at (default c4), so one
	// recording covers a melody.
	let mut options = quick().bpm(240).seed("samples");
	options.register_sample("bd", kick.clone(), None)?;
	options.register_sample("sd", snare.clone(), None)?;
	options.register_sample("hh", hat.clone(), None)?;
	options.register_sample("bass", bass.clone(), Some(Pitch::Name("e2".into())))?;

	let kit = stack(vec![
		s("bd ~ [bd bd] sd")?,
		s("hh*8")?.gain(0.4)?,
		note("e2 ~ g2 a2")?.s("bass").sustain(0.5)?,
	]);
	let heard = render_and_save("samples-kit", &kit, &options)?;
	assert!(heard.peak() > 0.05);

	// `.bank(name)` is a lookup convention, not a loader: it tries `{bank}_{name}` before the bare name, so after
	// registering `TR707_bd`, `s("bd").bank("TR707")` finds it.
	let mut banked = quick().bpm(240);
	banked.register_sample("TR707_bd", kick, None)?;
	assert!(
		banked
			.sample_registry()
			.is_sample_registered("bd", Some("TR707"))
	);
	assert!(!banked.sample_registry().is_sample_registered("bd", None));
	render_and_save("samples-bank", &s("bd*2")?.bank("TR707"), &banked)?;

	// Checking the registry: whether a name is registered, its declared base note, and its decoded buffer.
	let registry = options.sample_registry();
	assert!(registry.is_sample_registered("bass", None));
	assert_eq!(
		registry.get_sample_base_note("bass", None),
		Some(&Pitch::Name("e2".into()))
	);
	assert_eq!(
		registry
			.get_sample_buffer("bass", None)
			.map(SampleData::frames),
		Some(bass.frames())
	);
	assert!(registry.get_sample_buffer("nope", None).is_none());

	// Registration validates what it is given, so a typo cannot lurk until the middle of a song.
	let mut samples = Samples::new();
	println!(
		"{}",
		samples
			.register_sample("typo", snare.clone(), Some(Pitch::Name("h9".into())))
			.unwrap_err()
	);
	println!(
		"{}",
		samples
			.register_sample("empty", SampleData::new(RATE, vec![]), None)
			.unwrap_err()
	);

	// Registering in bulk (`registerSamples`) and clearing (`clearSamples`).
	samples.register_samples([
		(
			"bd".to_string(),
			SampleSource {
				data: snare.clone(),
				base_note: None,
			},
		),
		(
			"hh".to_string(),
			SampleSource {
				data: hat.clone(),
				base_note: None,
			},
		),
	])?;
	assert!(samples.is_sample_registered("hh", None));
	samples.clear_samples();
	assert!(!samples.is_sample_registered("hh", None));

	// The two-step flow of the browser (register, then decode) is a pending name and a later load. A voice that
	// names a pending sample is skipped, without a warning, until the PCM arrives.
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE))?;
	player
		.samples_mut()?
		.register_pending_sample("late", Some(Pitch::Name("c4".into())))?;
	let hit = s("late")?;
	player.play(&hit, &PlayOptions::default())?;
	let before = player.render_seconds(0.3)?;
	assert_eq!(before.peak(), 0.0, "skipped until the PCM arrives");
	player
		.samples_mut()?
		.load_samples([("late".to_string(), snare)])?;
	player.play(&hit, &PlayOptions::default())?;
	let after = player.render_seconds(0.3)?;
	assert!(after.peak() > 0.05);
	save("samples-pending-then-loaded", &after)?;
	player.shutdown();
	Ok(())
}
