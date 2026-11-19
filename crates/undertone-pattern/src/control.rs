// Voice-parameter pattern constructors: note(), sound(), s(), n(), and scale(), at the pattern level
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `note`, `sound`, `s`, `n`, and `scale`: the constructors of voice-parameter patterns. The controls (`gain`, `lpf`, `pan`, and the rest) are in [`crate::controls`].
//!
//! This covers what a program needs at layer 1 (haps): the values are [`Value`] maps such as `{ pitch: "c4", gainLevel: 0.5 }`. Resolving them into full voice parameters is layer 2 and belongs to the engine work (RF-14), so nothing here knows about voices beyond the field names.

use crate::error::{Error, Result};
use crate::js;
use crate::mini;
use crate::pattern::{Node, Pattern, pure};
use crate::pitch::check_frequency;
pub use crate::pitch::{midi_to_frequency, note_to_midi};
use crate::value::{Datum, MapFn, ParsedScale, Value};
use alloc::string::String;
use alloc::vec::Vec;

/// The ten synth sound types, in the reference's order.
pub const SOUND_TYPES: [&str; 10] = [
	"sine",
	"triangle",
	"square",
	"sawtooth",
	"halfsine",
	"abssine",
	"pulsesine",
	"white",
	"pink",
	"brown",
];

/// Whether `word` is one of the [`SOUND_TYPES`].
pub fn is_sound_type(word: &str) -> bool {
	SOUND_TYPES.contains(&word)
}

const SCALES: [(&str, &[i32]); 14] = [
	("major", &[0, 2, 4, 5, 7, 9, 11]),
	("ionian", &[0, 2, 4, 5, 7, 9, 11]),
	("minor", &[0, 2, 3, 5, 7, 8, 10]),
	("aeolian", &[0, 2, 3, 5, 7, 8, 10]),
	("dorian", &[0, 2, 3, 5, 7, 9, 10]),
	("phrygian", &[0, 1, 3, 5, 7, 8, 10]),
	("lydian", &[0, 2, 4, 6, 7, 9, 11]),
	("mixolydian", &[0, 2, 4, 5, 7, 9, 10]),
	("locrian", &[0, 1, 3, 5, 6, 8, 10]),
	("harmonicminor", &[0, 2, 3, 5, 7, 8, 11]),
	("melodicminor", &[0, 2, 3, 5, 7, 9, 11]),
	("majorpentatonic", &[0, 2, 4, 7, 9]),
	("minorpentatonic", &[0, 3, 5, 7, 10]),
	("chromatic", &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
];

/// The interval table that equals `intervals`, as the `'static` slice a [`ParsedScale`] holds: how a scale is rebuilt from text.
pub(crate) fn scale_table(intervals: &[i32]) -> Option<&'static [i32]> {
	SCALES
		.iter()
		.map(|(_, table)| *table)
		.find(|table| *table == intervals)
}

/// Parses a scale spec such as `"D5:minor"` into a root and its interval table.
///
/// Scale names ignore case, spaces, hyphens, and underscores, so `"Harmonic Minor"` works.
///
/// ```
/// use undertone_pattern::control::parse_scale;
/// let scale = parse_scale("D5:minor").unwrap();
/// assert_eq!(scale.root_midi, 74.0);
/// assert_eq!(scale.intervals, &[0, 2, 3, 5, 7, 8, 10]);
/// assert_eq!(
///     parse_scale("C4:bogus").unwrap_err().message(),
///     "Unknown scale name: \"bogus\". Expected one of major, ionian, minor, aeolian, dorian, phrygian, lydian, mixolydian, locrian, harmonicminor, melodicminor, majorpentatonic, minorpentatonic, chromatic."
/// );
/// ```
pub fn parse_scale(spec: &str) -> Result<ParsedScale> {
	let invalid = || {
		Error::new(alloc::format!(
			"Invalid scale spec: \"{spec}\". Expected e.g. \"D5:minor\", \"c4:majorPentatonic\"."
		))
	};
	let trimmed = js::trim(spec);
	let (root, scale_name) = trimmed.split_once(':').ok_or_else(invalid)?;
	// The root is a letter, an optional accidental, an optional minus, and digits; the name is one or more non-line-terminator characters.
	let is_root = {
		let mut chars = root.chars();
		chars
			.next()
			.is_some_and(|c| matches!(c, 'A'..='G' | 'a'..='g'))
			&& {
				let rest = &root[1..];
				let rest = rest.strip_prefix(['#', 'b']).unwrap_or(rest);
				let rest = rest.strip_prefix('-').unwrap_or(rest);
				!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
			}
	};
	if !is_root || scale_name.is_empty() || !scale_name.chars().all(js::is_dot) {
		return Err(invalid());
	}
	let wanted: String = scale_name
		.to_lowercase()
		.chars()
		.filter(|c| {
			!(c.len_utf16() == 1 && js::is_whitespace(*c as u32 as u16)) && *c != '_' && *c != '-'
		})
		.collect();
	let intervals = SCALES
		.iter()
		.find(|(name, _)| *name == wanted)
		.map(|(_, intervals)| *intervals)
		.ok_or_else(|| {
			let names: Vec<&str> = SCALES.iter().map(|(name, _)| *name).collect();
			Error::new(alloc::format!(
				"Unknown scale name: \"{scale_name}\". Expected one of {}.",
				names.join(", ")
			))
		})?;
	Ok(ParsedScale {
		root_midi: note_to_midi(root)?,
		intervals,
	})
}

fn pitch_value(pitch: Value) -> Value {
	Value::field("pitch", pitch)
}

/// `^\d+(\.\d+)?$`
pub(crate) fn is_unsigned_decimal(word: &str) -> bool {
	let (int, frac) = match word.split_once('.') {
		Some((int, frac)) => (int, Some(frac)),
		None => (word, None),
	};
	let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
	digits(int) && frac.is_none_or(digits)
}

/// Starts a pitched pattern from a mini-notation string of note names or Hz numbers (`"c3 [e3 g3] <a3 b3>"`). Bad pitches fail here, not at play time.
///
/// ```
/// use undertone_pattern::control::note;
/// use undertone_pattern::{Fraction, Span, Value};
/// let p = note("c4 e4").unwrap();
/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
/// assert_eq!(haps[0].value.get("pitch"), Some(&Value::Str("c4".into())));
/// ```
pub fn note(input: &str) -> Result<Pattern<Value>> {
	mini::parse(input, |word| {
		if is_unsigned_decimal(word) {
			let hz = check_frequency(js::string_to_number(word))
				.map_err(|e| String::from(e.message()))?;
			return Ok(pitch_value(Value::Num(hz)));
		}
		note_to_midi(word).map_err(|e| String::from(e.message()))?;
		Ok(pitch_value(Value::Str(word.into())))
	})
}

/// Starts a pitched pattern from a single frequency in Hz.
pub fn note_hz(hz: f64) -> Result<Pattern<Value>> {
	check_frequency(hz)?;
	Ok(pure(pitch_value(Value::Num(hz))))
}

/// Starts an unpitched pattern from a mini-notation string of sound types (`"white ~ pink(3,8)"`).
pub fn sound(input: &str) -> Result<Pattern<Value>> {
	mini::parse(input, |word| {
		if !is_sound_type(word) {
			return Err(alloc::format!(
				"Invalid sound type: \"{word}\". Expected one of {}.",
				SOUND_TYPES.join(", ")
			));
		}
		Ok(Value::field("soundType", Value::Str(word.into())))
	})
}

/// Starts a pattern of synth voices or registered samples: a synth type word behaves like [`sound`], any other word is a sample name.
pub fn s(input: &str) -> Result<Pattern<Value>> {
	mini::parse(input, |word| {
		Ok(if is_sound_type(word) {
			Value::field("soundType", Value::Str(word.into()))
		} else {
			Value::field("sampleName", Value::Str(word.into()))
		})
	})
}

fn degree_error_text(text: &str) -> String {
	alloc::format!("Invalid scale degree: {text}. Expected an integer.")
}

/// Starts a scale-degree pattern from a mini-notation string of integers; chain [`Pattern::scale`] to resolve it into pitches.
pub fn n(input: &str) -> Result<Pattern<Value>> {
	mini::parse(input, |word| {
		let body = word.strip_prefix('-').unwrap_or(word);
		if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) {
			return Err(degree_error_text(&alloc::format!("\"{word}\"")));
		}
		Ok(Value::field(
			"degree",
			Value::Num(js::string_to_number(word)),
		))
	})
}

/// Starts a scale-degree pattern from one integer.
pub fn n_degree(degree: f64) -> Result<Pattern<Value>> {
	if !js::is_integer(degree) {
		return Err(Error::new(degree_error_text(&js::number_to_string(degree))));
	}
	Ok(pure(Value::from_degree(degree)))
}

/// Starts a scale-degree pattern from a pattern of numbers that has events, each floored to a whole number; a value that is not a finite number is a rest.
///
/// A signal is refused: give it events with `segment` first.
pub fn n_pattern(input: &Pattern<Value>) -> Result<Pattern<Value>> {
	if input.has_sampler() {
		return Err(Error::new(
			"n() needs events: call .segment(n) on a signal first",
		));
	}
	Ok(Pattern::from_node(Node::Degrees(input.clone())))
}

/// An error for a scalar-only control given a pattern.
pub fn plain_value_error(name: &str) -> Error {
	Error::new(alloc::format!(
		"{name}() takes a plain value, not a pattern; it cannot change from event to event"
	))
}

impl Pattern<Value> {
	/// Resolves scale-degree events from [`n`] into pitches in Hz. Events without a degree pass through.
	///
	/// ```
	/// use undertone_pattern::control::n;
	/// use undertone_pattern::{Fraction, Span, Value};
	/// let p = n("0 2").unwrap().scale("C4:major").unwrap();
	/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	/// assert_eq!(haps[0].value.get("pitch"), Some(&Value::Num(261.6255653005986)));
	/// ```
	pub fn scale(&self, spec: &str) -> Result<Pattern<Value>> {
		let parsed = parse_scale(spec)?;
		Ok(self.fmap(MapFn::Scale(parsed)))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Fraction, Hap, Span};

	fn first_cycle(p: &Pattern<Value>) -> Vec<Hap<Value>> {
		p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)))
	}

	#[test]
	fn note_names_become_midi_and_hertz() {
		assert_eq!(note_to_midi("a4").unwrap(), 69.0);
		assert_eq!(note_to_midi("f#3").unwrap(), 54.0);
		assert_eq!(note_to_midi("c-1").unwrap(), 0.0);
		assert_eq!(midi_to_frequency(69.0), 440.0);
		assert_eq!(
			note_to_midi("h9").unwrap_err().message(),
			"Invalid note name: \"h9\". Expected e.g. \"c2\", \"a4\", \"f#3\", \"bb3\"."
		);
	}

	#[test]
	fn note_reads_hertz_words_and_rejects_zero() {
		let p = note("440 c4").unwrap();
		assert_eq!(
			first_cycle(&p)[0].value.get("pitch"),
			Some(&Value::Num(440.0))
		);
		assert_eq!(
			note("0").unwrap_err().message(),
			"Mini-notation error at position 0 in \"0\": Invalid frequency: 0"
		);
	}

	#[test]
	fn scale_specs_are_parsed_like_the_reference() {
		assert_eq!(
			parse_scale(" g4:Harmonic Minor ").unwrap().intervals,
			&[0, 2, 3, 5, 7, 8, 11]
		);
		assert_eq!(parse_scale("bb3:major").unwrap().root_midi, 58.0);
		assert!(parse_scale("C:major").is_err());
		assert!(parse_scale("C4:").is_err());
		assert!(parse_scale("C4:ma\njor").is_err());
	}
}
