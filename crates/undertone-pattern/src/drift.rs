// Seeded humanisation: timing, level, pitch, and pan drift that varies each loop pass
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `drift(pattern, options)`: small per-note variation derived from a seed, written from the reference's `src/drift.ts`.
//!
//! Every value comes from the seed, the loop pass, the note's position within the pass, and its pitch, never from query order or a clock, so the same seed gives the same events on every device however the scheduler windows its queries. The key that seeds each note's generator is the text `"<seed>|<pass>|<n>/<d>|<pitch>"`, built with JavaScript's number printing (so a pitch of `1e21` is `1e+21`), because [`seeded_random`](crate::random::seeded_random) hashes the key's UTF-16 code units: change a character and every seeded song changes.
//!
//! Off unless a range is set. Keep it off menu and interface sounds.

use crate::error::{Error, Result};
use crate::fraction::Fraction;
use crate::hap::Span;
use crate::js;
use crate::pattern::Pattern;
use crate::pitch::note_to_frequency;
use crate::random::{Seed, SeededRandom};
use crate::value::{MapFn, Value};
use alloc::string::String;
use alloc::vec::Vec;

/// What [`drift`] takes. Build one with [`DriftOptions::new`] and set the ranges you want, with struct update syntax for the rest.
///
/// ```
/// use undertone_pattern::drift::DriftOptions;
/// let options = DriftOptions {
///     timing: 0.012,
///     level: 0.15,
///     ..DriftOptions::new(7.0)
/// };
/// assert_eq!(options.cycles_per_pass, 1.0);
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct DriftOptions {
	/// Makes the variation repeatable: the same seed always gives the same result.
	pub seed: Seed,
	/// The seed's text as UTF-16 code units, when it holds a lone surrogate half that a Rust string cannot (a JavaScript string can). It takes the place of a string `seed` in the key; `None` otherwise.
	pub seed_utf16: Option<Vec<u16>>,
	/// The largest timing offset in seconds, either way, per note, applied as a nudge. Default 0.
	pub timing: f64,
	/// The largest level change as a fraction either way (0.1 is plus or minus 10% of the note's velocity). Default 0.
	pub level: f64,
	/// The largest detune in cents, either way. Pitched voices only (not samples). Default 0.
	pub cents: f64,
	/// The largest pan offset either way, kept within -1 to 1. Default 0.
	pub pan: f64,
	/// A constant offset in seconds applied to every note: positive plays behind the beat, negative ahead of it. Default 0.
	pub push: f64,
	/// How many cycles make up one pass; the seed advances every pass, so pass N differs from pass N + 1 but is always the same for the same seed. A JavaScript number that must be a positive whole number. Default 1.
	pub cycles_per_pass: f64,
}

impl DriftOptions {
	/// Options with the given seed (a number or a string) and every range off.
	///
	/// ```
	/// use undertone_pattern::drift::DriftOptions;
	/// let a = DriftOptions::new(1.0);
	/// let b = DriftOptions::new("song");
	/// assert_ne!(a.seed, b.seed);
	/// ```
	pub fn new(seed: impl Into<Seed>) -> DriftOptions {
		DriftOptions {
			seed: seed.into(),
			seed_utf16: None,
			timing: 0.0,
			level: 0.0,
			cents: 0.0,
			pan: 0.0,
			push: 0.0,
			cycles_per_pass: 1.0,
		}
	}
}

/// The error for a range that is not zero or more (a negative number, or `NaN`).
pub fn negative_range_error(name: &str, got: &str) -> Error {
	Error::new(alloc::format!(
		"drift() {name} must not be negative, got {got}"
	))
}

/// The error for a `cyclesPerPass` that is not a positive whole number.
pub fn cycles_per_pass_error(got: &str) -> Error {
	Error::new(alloc::format!(
		"drift() cyclesPerPass must be a positive integer, got {got}"
	))
}

impl DriftOptions {
	/// Checks the options the way the reference does, in its order: `cycles_per_pass` first, then `timing`, `level`, `cents`, and `pan`. [`drift`] calls it, so a pattern is never built from bad options.
	///
	/// ```
	/// use undertone_pattern::drift::DriftOptions;
	/// assert!(DriftOptions::new(1.0).validate().is_ok());
	/// let bad = DriftOptions { cents: -1.0, ..DriftOptions::new(1.0) };
	/// assert_eq!(bad.validate().unwrap_err().message(), "drift() cents must not be negative, got -1");
	/// ```
	pub fn validate(&self) -> Result<()> {
		validate(self)
	}
}

fn validate(options: &DriftOptions) -> Result<()> {
	if !js::is_integer(options.cycles_per_pass) || options.cycles_per_pass < 1.0 {
		return Err(cycles_per_pass_error(&js::number_to_string(
			options.cycles_per_pass,
		)));
	}
	for (name, value) in [
		("timing", options.timing),
		("level", options.level),
		("cents", options.cents),
		("pan", options.pan),
	] {
		// `!(value >= 0)`, so NaN is refused too.
		if value.is_nan() || value < 0.0 {
			return Err(negative_range_error(name, &js::number_to_string(value)));
		}
	}
	Ok(())
}

/// Adds seeded humanisation to a pattern of voice parameters: small per-note timing, level, pitch, and pan variation, plus a constant push or pull. Off unless you set a range.
///
/// Each note with a whole is varied; a continuous event (no whole) passes through. The variation is a pure function of the seed, the loop pass, the note's position in the pass, and its pitch. Building fails, with the reference's message, when `cycles_per_pass` is not a positive whole number or a range is negative.
///
/// ```
/// use undertone_pattern::control::note;
/// use undertone_pattern::drift::{drift, DriftOptions};
/// use undertone_pattern::{Fraction, Span, Value};
/// let options = DriftOptions { timing: 0.01, ..DriftOptions::new(1.0) };
/// let p = drift(&note("c3 e3 g3 e3").unwrap(), options).unwrap();
/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
/// // The recorded value for seed 1: the first note is nudged by about 6.5 ms.
/// assert_eq!(haps[0].value.get("nudgeTime"), Some(&Value::Num(0.0064723130268976095)));
/// // Asking again, or in another window, gives the same numbers.
/// let again = p.query(Span::new(Fraction::new(0, 1), Fraction::new(1, 4)));
/// assert_eq!(again[0].value, haps[0].value);
/// // Bad options fail when the pattern is built.
/// let bad = DriftOptions { cycles_per_pass: 0.0, ..DriftOptions::new(1.0) };
/// assert_eq!(
///     drift(&note("c3").unwrap(), bad).unwrap_err().message(),
///     "drift() cyclesPerPass must be a positive integer, got 0"
/// );
/// ```
pub fn drift(pattern: &Pattern<Value>, options: DriftOptions) -> Result<Pattern<Value>> {
	validate(&options)?;
	Ok(pattern.fmap(MapFn::Drift(options)))
}

/// `(random() * 2 - 1) * range`.
fn offset(random: &mut SeededRandom, range: f64) -> f64 {
	(random.next_value() * 2.0 - 1.0) * range
}

/// `Math.min`, which is NaN when either side is.
fn js_min(a: f64, b: f64) -> f64 {
	if a.is_nan() || b.is_nan() {
		f64::NAN
	} else {
		a.min(b)
	}
}

/// `Math.max`, which is NaN when either side is.
fn js_max(a: f64, b: f64) -> f64 {
	if a.is_nan() || b.is_nan() {
		f64::NAN
	} else {
		a.max(b)
	}
}

/// What `${value}` gives for a value in the key.
fn key_text(value: Option<&Value>) -> String {
	match value {
		None | Some(Value::Undefined) => String::new(),
		Some(Value::Num(n)) => js::number_to_string(*n),
		Some(Value::Str(s)) => s.clone(),
		Some(Value::Bool(b)) => String::from(if *b { "true" } else { "false" }),
		Some(Value::Map(_) | Value::List(_)) => String::from("[object Object]"),
	}
}

/// The note's key: `<seed>|<pass>|<n>/<d>|<pitch>`, the text its random generator is seeded from, as UTF-16 code units, with the pass.
pub fn drift_key(
	options: &DriftOptions,
	whole: Span,
	pitch: Option<&Value>,
) -> Result<(Vec<u16>, f64)> {
	// The pass and the position inside it, from the note's whole.
	let pass = crate::math::floor(whole.begin.floor() as f64 / options.cycles_per_pass);
	let in_pass = whole.begin - Fraction::from_f64(pass * options.cycles_per_pass)?;
	let rest = alloc::format!(
		"|{}|{}/{}|{}",
		js::number_to_string(pass),
		in_pass.numerator(),
		in_pass.denominator(),
		key_text(pitch)
	);
	let mut key: Vec<u16> = match &options.seed_utf16 {
		Some(units) => units.clone(),
		None => options.seed.key_text().encode_utf16().collect(),
	};
	key.extend(rest.encode_utf16());
	Ok((key, pass))
}

/// The value after drift: the reference's body of `drift`, on one hap value with a whole.
pub(crate) fn drift_value(options: &DriftOptions, whole: Span, value: &Value) -> Result<Value> {
	let Value::Map(map) = value else {
		return Ok(value.clone());
	};
	let (key, _) = drift_key(options, whole, map.get("pitch"))?;
	let mut random = SeededRandom::from_utf16(&key);
	let mut out = map.clone();
	let number = |value: Option<&Value>, default: f64| match value {
		None => default,
		Some(Value::Num(n)) => *n,
		Some(_) => f64::NAN,
	};

	let existing = number(map.get("nudgeTime"), 0.0);
	let nudge = existing
		+ options.push
		+ if options.timing > 0.0 {
			offset(&mut random, options.timing)
		} else {
			0.0
		};
	if nudge != 0.0 {
		out.insert("nudgeTime".into(), Value::Num(nudge));
	}
	if options.level > 0.0 {
		let velocity =
			number(map.get("velocity"), 1.0) * (1.0 + offset(&mut random, options.level));
		out.insert("velocity".into(), Value::Num(velocity));
	}
	if options.cents > 0.0
		&& map.get("sampleName").is_none()
		&& let Some(pitch) = map.get("pitch")
	{
		{
			let hz = match pitch {
				Value::Num(hz) => note_to_frequency(*hz)?,
				Value::Str(name) => note_to_frequency(name.as_str())?,
				_ => {
					return Err(Error::new(
						"drift() cannot read a pitch that is not a note name or Hz",
					));
				}
			};
			let detuned = hz * js::pow(2.0, offset(&mut random, options.cents) / 1200.0);
			out.insert("pitch".into(), Value::Num(detuned));
		}
	}
	if options.pan > 0.0 {
		let pan = number(map.get("pan"), 0.0) + offset(&mut random, options.pan);
		out.insert("pan".into(), Value::Num(js_max(-1.0, js_min(1.0, pan))));
	}
	Ok(Value::Map(out))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::control::note;

	fn text(units: &[u16]) -> String {
		String::from_utf16(units).unwrap()
	}

	fn first(p: &Pattern<Value>) -> alloc::vec::Vec<crate::Hap<Value>> {
		p.query(Span::new(Fraction::from_int(0), Fraction::from_int(2)))
	}

	#[test]
	fn the_key_follows_javascript_number_printing() {
		let options = DriftOptions::new(1.0);
		let whole = Span::new(Fraction::new(1, 3), Fraction::new(2, 3));
		let (key, pass) = drift_key(&options, whole, Some(&Value::Num(1e21))).unwrap();
		assert_eq!(text(&key), "1|0|1/3|1e+21");
		assert_eq!(pass, 0.0);
		let (key, _) = drift_key(&options, whole, Some(&Value::Num(1e-7))).unwrap();
		assert_eq!(text(&key), "1|0|1/3|1e-7");
		let (key, _) = drift_key(&DriftOptions::new("a|b"), whole, None).unwrap();
		assert_eq!(text(&key), "a|b|0|1/3|");
	}

	#[test]
	fn the_pass_advances_with_cycles_per_pass() {
		let options = DriftOptions {
			cycles_per_pass: 2.0,
			..DriftOptions::new(1.0)
		};
		let at = |b: Fraction| Span::new(b, b + Fraction::new(1, 4));
		let key = |b| text(&drift_key(&options, at(b), None).unwrap().0);
		assert_eq!(key(Fraction::new(5, 2)), "1|1|1/2|");
		assert_eq!(key(Fraction::new(-1, 2)), "1|-1|3/2|");
	}

	#[test]
	fn every_range_is_off_by_default() {
		let p = note("c3 e3").unwrap();
		let drifted = drift(&p, DriftOptions::new(5.0)).unwrap();
		assert_eq!(first(&drifted), first(&p));
	}

	#[test]
	fn a_pitch_that_cannot_be_read_fails_when_queried() {
		let p = crate::Pattern::from_node(crate::Node::Pure(Value::field(
			"pitch",
			Value::Str("zz".into()),
		)));
		let options = DriftOptions {
			cents: 5.0,
			..DriftOptions::new(1.0)
		};
		let drifted = drift(&p, options).unwrap();
		let span = Span::new(Fraction::from_int(0), Fraction::from_int(1));
		assert!(drifted.try_query(span).is_err());
	}

	#[test]
	fn option_errors_come_in_the_references_order() {
		let both = DriftOptions {
			cycles_per_pass: 1.5,
			timing: -1.0,
			..DriftOptions::new(1.0)
		};
		assert_eq!(
			validate(&both).unwrap_err().message(),
			"drift() cyclesPerPass must be a positive integer, got 1.5"
		);
		let nan = DriftOptions {
			pan: f64::NAN,
			..DriftOptions::new(1.0)
		};
		assert_eq!(
			validate(&nan).unwrap_err().message(),
			"drift() pan must not be negative, got NaN"
		);
	}
}
