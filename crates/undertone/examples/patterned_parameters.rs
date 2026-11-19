// Patterned parameters: a control can be a number, a mini-notation string, or a pattern
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/patterned-parameters.md`. Run it with `cargo run --example patterned_parameters`.
//!
//! The guide's hi-hat line plays the sample `hh`. Undertone bundles no samples, so the example makes its own
//! hat as PCM (a burst of decaying noise) and registers it, the way a host registers decoded recordings.

mod common;

use common::{Outcome, quick, render_and_save};
use undertone::prelude::*;

/// A closed hi-hat made of 40 ms of noise that falls away quickly, as PCM at `rate` hertz.
fn hat(rate: f64) -> SampleData {
	let frames = (rate * 0.04) as usize;
	let mut random = seeded_random("hat");
	let noise = (0..frames)
		.map(|i| {
			let fall = 1.0 - i as f64 / frames as f64;
			((random.next_value() * 2.0 - 1.0) * fall * fall) as f32
		})
		.collect();
	SampleData::new(rate, vec![noise])
}

fn main() -> Outcome {
	let mut options = quick().bpm(240);
	options.register_sample("hh", hat(common::RATE), None)?;

	// Before: a flat hi-hat line.
	let flat = s("hh*8")?.gain(0.4)?;
	render_and_save("patterned-flat", &flat, &options)?;

	// After: the same events, with gain and pan varying per step. The gain string is a four-step curve sped up
	// twice, one value per hat; the pan alternates left and right each cycle. Structure comes from the pattern
	// being controlled, never from the control string.
	let varied = s("hh*8")?.gain("[.5 .2 .35 .2]*2")?.pan("<-0.6 0.6>")?;
	let heard = render_and_save("patterned-varied", &varied, &options.clone().cycles(2))?;
	assert!(heard.peak() > 0.01);
	let haps = varied.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	assert_eq!(haps.len(), 8);
	assert_eq!(haps[0].value.get("gainLevel"), Some(&Value::Num(0.5)));
	assert_eq!(haps[1].value.get("gainLevel"), Some(&Value::Num(0.2)));

	// A rest in a control string leaves that event's value unset: the default applies, not zero.
	let rested = note("c3 e3 g3 b3")?.sound("triangle").lpf("400 ~ 1600 ~")?;
	let haps = rested.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	assert_eq!(haps[1].value.get("filterCutoff"), None);
	assert_eq!(haps[2].value.get("filterCutoff"), Some(&Value::Num(1600.0)));
	render_and_save("patterned-rests", &rested, &quick().bpm(240))?;

	// Patterns and signals as controls: a signal is read at each event's onset. Hats drifting across the stereo
	// field, a wandering filter, and a random accent on each.
	let drifting = sound("white*8")?
		.attack(0.001)?
		.decay(0.03)?
		.pan(sine2().slow(4.0)?)?
		.lpf(perlin().range(3000.0, 9000.0))?
		.velocity(rand().seed(Seed::Num(3.0))?.range(0.4, 1.0))?;
	render_and_save("patterned-signals", &drifting, &quick().bpm(240))?;

	// The same events and the same sound come from a number, a string, and a pattern.
	let a = note("c3 e3")?.gain(0.4)?;
	let b = note("c3 e3")?.gain("0.4")?;
	let c = note("c3 e3")?.gain(pure(Value::Num(0.4)))?;
	let span = Span::new(Fraction::from_int(0), Fraction::from_int(1));
	assert_eq!(a.query(span), b.query(span));
	assert_eq!(a.query(span), c.query(span));

	// A few controls only take plain values, and say so when given a pattern.
	let error = note("c3")?
		.control(Control::Cut, pure(Value::Num(1.0)))
		.unwrap_err();
	assert_eq!(
		error.message(),
		"cut() takes a plain value, not a pattern; it cannot change from event to event"
	);

	// Mistakes surface when the pattern is built, not in the middle of a song.
	println!("{}", note("c3")?.pan("<-.6 1.2>").unwrap_err());
	Ok(())
}
