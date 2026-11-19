// Signals: continuous patterns, read at the onset of each event
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/signals.md`. Run it with `cargo run --example signals`.
//!
//! A signal is a pattern with no rhythm of its own. You read it by giving it a rhythm (`segment(n)`), or by
//! handing it to a control, which reads it at each event's onset. In Rust each named signal is a function
//! (`sine()`, `saw2()`, `rand()`), because a pattern is built by a call.

mod common;

use common::{Outcome, quick, render_and_save};
use undertone::prelude::*;

/// The values of a pattern's haps over cycle 0, in time order.
fn values(pattern: &Pattern<Value>) -> Vec<f64> {
	let mut haps = pattern.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	haps.sort_by_key(|hap| hap.part.begin);
	haps.iter()
		.filter_map(|hap| hap.value.as_number())
		.map(|value| (value * 1e6).round() / 1e6)
		.collect()
}

fn main() -> Outcome {
	// Reading a signal at an onset: four events a cycle, read at 0, 1/4, 1/2, and 3/4.
	assert_eq!(values(&sine().segment(4.0)?), [0.5, 1.0, 0.5, 0.0]);
	assert_eq!(
		values(&saw().range(0.0, 8.0).segment(8.0)?),
		[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
	);

	// To hear a segmented signal, give it to `n()`: eight notes a cycle climbing the scale, degrees 0 to 7.
	let climb = n_pattern(&saw().range(0.0, 8.0).segment(8.0)?)?
		.scale("C4:major")?
		.sound("triangle");
	render_and_save("signals-climb", &climb, &quick().bpm(240))?;

	// Signals as control values. Eight hats a cycle, each one place further along a slow sweep of the stereo
	// field, with the filter opening and closing once a cycle.
	let hats = sound("white*8")?
		.attack(0.001)?
		.decay(0.03)?
		.pan(sine2().slow(4.0)?)?
		.lpf(sine().range(2000.0, 9000.0))?
		.gain(0.4)?;
	render_and_save("signals-hats", &hats, &quick().bpm(240))?;

	// `pan(0.5)` and `pan(pure(0.5))` are the same events and the same sound.
	let span = Span::new(Fraction::from_int(0), Fraction::from_int(1));
	let number = sound("white*4")?.pan(0.5)?;
	let pattern = sound("white*4")?.pan(pure(Value::Num(0.5)))?;
	assert_eq!(number.query(span), pattern.query(span));

	// A signal inside a `jux` transform: the right-hand copy has a filter that opens and closes once a cycle; the
	// left-hand copy has none.
	let shimmer = note("c3 e3 g3 b3 g3 e3")?
		.sound("sawtooth")
		.gain(0.3)?
		.jux(|pattern| {
			pattern
				.lpf(sine().range(300.0, 3000.0))
				.expect("a signal is always a valid control")
		})?;
	render_and_save("signals-jux", &shimmer, &quick().bpm(240))?;

	// Ranges and arithmetic. `rangex` is the exponential curve for frequencies; it needs positive bounds.
	assert_eq!(
		saw().rangex(0.0, 2000.0).unwrap_err().message(),
		"rangex() bounds must be positive, got 0 and 2000"
	);
	assert_eq!(
		values(&(saw().segment(4.0)? * 4.0 + 1.0)),
		[1.0, 2.0, 3.0, 4.0]
	);
	assert_eq!(
		values(&(&sine().segment(4.0)? + &saw())),
		[0.5, 1.25, 1.0, 0.75]
	);

	// Combinators move a signal in time the way they move events: `rev` mirrors each cycle.
	assert_eq!(values(&sine().rev().segment(4.0)?), [0.5, 0.0, 0.5, 1.0]);
	// A custom signal receives the cycle time as a number, so `t % 1` is `saw`.
	assert_eq!(
		values(&signal(|t| t % 1.0).segment(4.0)?),
		[0.0, 0.25, 0.5, 0.75]
	);

	// Randomness is deterministic: each value is a pure function of the seed, the kind, and the exact time.
	let seven = rand().seed(Seed::Num(7.0))?;
	let again = rand().seed(Seed::Num(7.0))?;
	let at = Fraction::new(1, 3);
	assert_eq!(seven.sample_at(at), again.sample_at(at));
	assert_ne!(seven.sample_at(at), rand().sample_at(at));
	// The seed goes directly on the random signal, before anything else is chained.
	println!(
		"{}",
		rand()
			.range(200.0, 2000.0)
			.seed(Seed::Num(7.0))
			.unwrap_err()
	);
	let wander = note("c3 e3 g3 b3")?
		.sound("triangle")
		.lpf(rand().seed(Seed::Num(7.0))?.rangex(200.0, 2000.0)?)?;
	render_and_save("signals-random", &wander, &quick().bpm(240))?;

	// A signal can give a value a control cannot use. Reading it never fails: a pan past 1 is clamped.
	let wild = note("c3")?.pan(sine().range(0.0, 2.0))?;
	let pans = wild.query(span);
	println!(
		"a pan from a signal that went past 1: {:?}",
		pans[0].value.get("pan")
	);
	Ok(())
}
