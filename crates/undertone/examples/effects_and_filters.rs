// Filters, reverb, delay, and orbits
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/effects.md`. Run it with `cargo run --example effects_and_filters`.
//!
//! Reverb and delay are sends to shared per-orbit buses, not inserts. `Engine::orbit_bus` is the Rust form of
//! `getOrbitBus`, and `build_impulse_response` makes a reverb's response from a seeded random source.

mod common;

use common::{Outcome, RATE, quick, render_and_save, save};
use undertone::prelude::*;

fn main() -> Outcome {
	// The lowpass and its envelope: a slow filter attack over a sawtooth is the classic rising sweep (the
	// playground's "Power On").
	let power_on = note("a3")?
		.sound("sawtooth")
		.attack(0.02)?
		.decay(0.14)?
		.sustain(0.4)?
		.release(0.1)?
		.gain(0.35)?
		.lpf(300)?
		.lpenv(2200)?
		.lpa(0.16)?
		.lpd(0.05)?
		.lps(0.6)?
		.lpr(0.1)?;
	render_and_save(
		"effects-power-on",
		&power_on,
		&quick().bpm(240).gated(false),
	)?;

	// Highpass and phaser: `.hpf` thins a voice out, `.phaser(rate_hz)` sweeps four allpass stages.
	let thin = note("a2 e3")?
		.sound("sawtooth")
		.sustain(0.5)?
		.hpf(400)?
		.phaser(1)?;
	render_and_save("effects-hpf-phaser", &thin, &quick().bpm(240))?;

	// Why orbits exist: reverb and delay live on shared buses, so `roomsize`, `delaytime`, and `delayfeedback`
	// are last-writer-wins across every voice on the orbit. Give each layer its own `.orbit(n)` for its own room.
	let pad = chord("<Dm9 Gm9>")?
		.voicing(VoicingOptions::default())
		.sound("sine")
		.sustain(0.8)?
		.gain(0.3)?
		.room(0.5)?
		.room_size(8)?
		.orbit(1.0)?;
	let pluck = n("0 4 2 7")?
		.scale("d4:minor")?
		.sound("triangle")
		.gain(0.4)?
		.delay(0.3)?
		.delay_time(0.25)?
		.delay_feedback(0.4)?
		.orbit(2.0)?;
	render_and_save(
		"effects-orbits",
		&stack(vec![pad, pluck]),
		&quick().cycles(2).bpm(240),
	)?;

	// `.orbit()` takes a plain non-negative integer: it selects a bus rather than shaping a value.
	println!("{}", note("c3")?.orbit(-1.0).unwrap_err());

	// Reaching the buses directly. A reverb's response is exponentially decaying noise: seeded, so the room is
	// repeatable. Build one on a recording graph and look at it.
	let mut graph = LogGraph::new(RATE, 2);
	let room = build_impulse_response(&mut graph, 1.0, &mut seeded_random(1.0))?;
	assert_eq!(graph.buffer_channel_mut(room, 0).len(), RATE as usize); // sampleRate frames

	// Tune orbit 2's bus by hand, then send a voice to it. The engine makes the bus the first time it is asked
	// for; voices that send to orbit 2 find the same one.
	let mut player = Player::new(&PlayerOptions::new().sample_rate(RATE).seed(1.0))?;
	let bus = {
		let engine = player.engine_mut()?;
		engine.set_orbit_room_size(2.0, None, 3.0)?;
		engine.set_orbit_delay(2.0, None, 0.25, 0.4);
		engine.orbit_bus(2.0, None)
	};
	println!(
		"orbit 2's bus takes the reverb at node {:?} and the delay at node {:?}",
		bus.reverb_input, bus.delay_input
	);
	player.play(
		&note("c4 e4 g4")?.sound("triangle").room(0.5)?.orbit(2.0)?,
		&PlayOptions {
			bpm: Some(240.0),
			..PlayOptions::default()
		},
	)?;
	let heard = player.render_seconds(1.5)?;
	save("effects-orbit-bus", &heard)?;
	player.shutdown();
	Ok(())
}
