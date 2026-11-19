// Note names, MIDI note numbers, and frequencies, as the reference converts them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Pitch conversion: a note name to a MIDI note number, a MIDI note number to Hz, and a pitch (a note name or raw Hz) to Hz.
//!
//! These are the reference's `noteToMidi`, `midiToFrequency`, and `noteToFrequency` (`src/pitch.ts`). They live in the pattern crate because the engine depends on it, not the other way round, and patterns need them: `note()` validates its words with them, `scale` and `voicing` turn MIDI numbers into Hz, and `drift` detunes in Hz.
//!
//! Numbers follow JavaScript: the power in `midi_to_frequency` goes through [`js::pow`], which copies JavaScriptCore's rule for an exponent of `-0.5`.

use crate::error::{Error, Result};
use crate::js;
use alloc::string::String;

fn note_error(name: &str) -> Error {
	Error::new(alloc::format!(
		"Invalid note name: \"{name}\". Expected e.g. \"c2\", \"a4\", \"f#3\", \"bb3\"."
	))
}

/// A note name (`c2`, `a4`, `f#3`, `bb3`) as a MIDI note number, with C4 as 60.
///
/// The letter may be in either case, an accidental is `#` or `b`, and the octave is a whole number that may be negative (`c-1` is 0). Surrounding whitespace is ignored. Anything else is an error carrying the reference's message.
///
/// ```
/// use undertone_pattern::pitch::note_to_midi;
/// assert_eq!(note_to_midi("c4").unwrap(), 60.0);
/// assert_eq!(note_to_midi("Bb2").unwrap(), 46.0);
/// assert_eq!(note_to_midi(" a4 ").unwrap(), 69.0);
/// assert_eq!(
///     note_to_midi("zz").unwrap_err().message(),
///     "Invalid note name: \"zz\". Expected e.g. \"c2\", \"a4\", \"f#3\", \"bb3\"."
/// );
/// ```
pub fn note_to_midi(name: &str) -> Result<f64> {
	let trimmed = js::trim(name);
	let mut chars = trimmed.chars().peekable();
	let letter = chars.next().ok_or_else(|| note_error(name))?;
	let base = match letter {
		'c' | 'C' => 0.0,
		'd' | 'D' => 2.0,
		'e' | 'E' => 4.0,
		'f' | 'F' => 5.0,
		'g' | 'G' => 7.0,
		'a' | 'A' => 9.0,
		'b' | 'B' => 11.0,
		_ => return Err(note_error(name)),
	};
	let accidental = match chars.peek() {
		Some('#') => {
			chars.next();
			1.0
		}
		Some('b') => {
			chars.next();
			-1.0
		}
		_ => 0.0,
	};
	let octave: String = chars.collect();
	let digits = octave.strip_prefix('-').unwrap_or(&octave);
	if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
		return Err(note_error(name));
	}
	let octave = js::string_to_number(&octave);
	Ok((octave + 1.0) * 12.0 + base + accidental)
}

/// A MIDI note number as Hz, with A4 (69) as 440.
///
/// The number need not be whole: 69.5 is a quarter tone above A4.
///
/// ```
/// use undertone_pattern::pitch::midi_to_frequency;
/// assert_eq!(midi_to_frequency(69.0), 440.0);
/// assert_eq!(midi_to_frequency(81.0), 880.0);
/// assert_eq!(midi_to_frequency(60.0), 261.6255653005986);
/// ```
pub fn midi_to_frequency(midi: f64) -> f64 {
	440.0 * js::pow(2.0, (midi - 69.0) / 12.0)
}

/// A pitch: a note name or a frequency in Hz, what [`note_to_frequency`] accepts.
///
/// `From<&str>` and `From<f64>` build one, so a call can pass either directly.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Pitch<'a> {
	/// A note name such as `"a4"`.
	Name(&'a str),
	/// A frequency in Hz, which passes through unchanged when it is a finite number above zero.
	Hz(f64),
}

impl<'a> From<&'a str> for Pitch<'a> {
	fn from(name: &'a str) -> Self {
		Pitch::Name(name)
	}
}

impl From<f64> for Pitch<'_> {
	fn from(hz: f64) -> Self {
		Pitch::Hz(hz)
	}
}

/// A frequency in Hz must be a finite number above zero.
pub(crate) fn check_frequency(hz: f64) -> Result<f64> {
	if !hz.is_finite() || hz <= 0.0 {
		return Err(Error::new(alloc::format!(
			"Invalid frequency: {}",
			js::number_to_string(hz)
		)));
	}
	Ok(hz)
}

/// A pitch as Hz: a note name goes through [`note_to_midi`] and [`midi_to_frequency`], and a number is raw Hz, which must be finite and above zero.
///
/// ```
/// use undertone_pattern::pitch::note_to_frequency;
/// assert_eq!(note_to_frequency("a4").unwrap(), 440.0);
/// assert_eq!(note_to_frequency(261.5).unwrap(), 261.5);
/// assert_eq!(
///     note_to_frequency(0.0).unwrap_err().message(),
///     "Invalid frequency: 0"
/// );
/// assert!(note_to_frequency("h2").is_err());
/// ```
pub fn note_to_frequency<'a>(pitch: impl Into<Pitch<'a>>) -> Result<f64> {
	match pitch.into() {
		Pitch::Hz(hz) => check_frequency(hz),
		Pitch::Name(name) => Ok(midi_to_frequency(note_to_midi(name)?)),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn note_names_become_midi() {
		assert_eq!(note_to_midi("a4").unwrap(), 69.0);
		assert_eq!(note_to_midi("f#3").unwrap(), 54.0);
		assert_eq!(note_to_midi("c-1").unwrap(), 0.0);
		assert_eq!(note_to_midi("G9").unwrap(), 127.0);
		assert_eq!(note_to_midi("cb4").unwrap(), 59.0);
		assert_eq!(note_to_midi("b#4").unwrap(), 72.0);
	}

	#[test]
	fn bad_names_fail_with_the_reference_message() {
		for bad in [
			"", "c", "c#", "4", "h4", "c+4", "c 4", "c4.5", "c--1", "c\u{663}",
		] {
			assert_eq!(
				note_to_midi(bad).unwrap_err().message(),
				alloc::format!(
					"Invalid note name: \"{bad}\". Expected e.g. \"c2\", \"a4\", \"f#3\", \"bb3\"."
				)
			);
		}
	}

	#[test]
	fn frequencies_are_finite_and_positive() {
		for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
			assert!(note_to_frequency(bad).is_err());
		}
		assert_eq!(
			note_to_frequency(f64::NEG_INFINITY).unwrap_err().message(),
			"Invalid frequency: -Infinity"
		);
	}
}
