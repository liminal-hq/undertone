// Chord symbols and the stateless voicing that turns them into simultaneous notes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Chord symbols (`"Dm9"`, `"BbM7"`, `"A7sus"`) and voicing, written from the reference's `src/chord.ts`.
//!
//! [`chord`] starts a pattern of chord symbols (a mini-notation string), and [`Pattern::voicing`] expands each chord into simultaneous notes, one hap per tone sharing the chord's whole and part. The voicing is a pure function of the symbol and an optional anchor pitch (middle C by default): the root lands within a half octave of the anchor, and every other tone is stacked directly above it by its interval from [`CHORD_QUALITIES`]. It is not voice leading, and it does not read a voicing dictionary.
//!
//! The functions behind them, [`parse_chord`] and [`voicing_pitches`], are public too.

use crate::error::{Error, Result};
use crate::js;
use crate::mini;
use crate::pattern::Pattern;
use crate::pitch::{midi_to_frequency, note_to_midi};
use crate::value::{MapFn, Value};
use alloc::string::String;
use alloc::vec::Vec;

/// The chord qualities and their semitone intervals from the root, in the order JavaScript lists the reference's table.
///
/// That order matters because the unknown-quality error prints it: JavaScript puts the keys that look like whole numbers (`6`, `7`, `9`) first, in ascending order, and the rest in the order they were written, so the major quality (the empty string, shown as `(major)`) comes after `9`. Case matters: `M7` and `maj7` are a major seventh, `m7` a minor one. Ninths are written as 14 rather than 2, so they land an octave above the root when stacked directly.
pub const CHORD_QUALITIES: [(&str, &[i32]); 22] = [
	("6", &[0, 4, 7, 9]),
	("7", &[0, 4, 7, 10]),
	("9", &[0, 4, 7, 10, 14]),
	("", &[0, 4, 7]),
	("m", &[0, 3, 7]),
	("m6", &[0, 3, 7, 9]),
	("maj7", &[0, 4, 7, 11]),
	("M7", &[0, 4, 7, 11]),
	("m7", &[0, 3, 7, 10]),
	("maj9", &[0, 4, 7, 11, 14]),
	("M9", &[0, 4, 7, 11, 14]),
	("m9", &[0, 3, 7, 10, 14]),
	("add9", &[0, 4, 7, 14]),
	("madd9", &[0, 3, 7, 14]),
	("sus2", &[0, 2, 7]),
	("sus4", &[0, 5, 7]),
	("7sus", &[0, 5, 7, 10]),
	("7sus4", &[0, 5, 7, 10]),
	("dim", &[0, 3, 6]),
	("dim7", &[0, 3, 6, 9]),
	("aug", &[0, 4, 8]),
	("m7b5", &[0, 3, 6, 10]),
];

/// A parsed chord symbol: the root's pitch class (0 to 11, C is 0) and the semitone intervals from the root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParsedChord {
	/// The root as a pitch class, `0..12`.
	pub root_pitch_class: u8,
	/// The intervals from the root, ascending, starting at 0.
	pub intervals: &'static [i32],
}

fn invalid_symbol(symbol: &str) -> Error {
	Error::new(alloc::format!("Invalid chord symbol: \"{symbol}\"."))
}

/// Parses a chord symbol such as `"Dm9"`, `"BbM7"`, or `"A7sus"` into a root pitch class and an interval table.
///
/// The root is a letter `A` to `G` in either case, then an optional `#` or `b`, then the quality. Surrounding whitespace is ignored. A symbol that does not start with a root is an `Invalid chord symbol` error, and one whose quality is not in [`CHORD_QUALITIES`] lists every quality the reference knows.
///
/// ```
/// use undertone_pattern::chord::parse_chord;
/// let d_minor_ninth = parse_chord("Dm9").unwrap();
/// assert_eq!(d_minor_ninth.root_pitch_class, 2);
/// assert_eq!(d_minor_ninth.intervals, &[0, 3, 7, 10, 14]);
/// assert_eq!(parse_chord("Bb").unwrap().root_pitch_class, 10);
/// assert_eq!(
///     parse_chord("H7").unwrap_err().message(),
///     "Invalid chord symbol: \"H7\"."
/// );
/// assert!(parse_chord("Cmin").unwrap_err().message().starts_with("Unknown chord quality: \"min\" in \"Cmin\"."));
/// ```
pub fn parse_chord(symbol: &str) -> Result<ParsedChord> {
	let trimmed = js::trim(symbol);
	let mut chars = trimmed.chars();
	let letter = chars.next().ok_or_else(|| invalid_symbol(symbol))?;
	if !matches!(letter, 'A'..='G' | 'a'..='g') {
		return Err(invalid_symbol(symbol));
	}
	let rest = chars.as_str();
	// `([#b]?)(.*)$`: the accidental is taken when present, and `.` does not match a line terminator.
	let (accidental, quality) = match rest.chars().next() {
		Some(c @ ('#' | 'b')) => (Some(c), &rest[1..]),
		_ => (None, rest),
	};
	if quality
		.chars()
		.any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
	{
		return Err(invalid_symbol(symbol));
	}
	let Some((_, intervals)) = CHORD_QUALITIES.iter().find(|(name, _)| *name == quality) else {
		let names: Vec<&str> = CHORD_QUALITIES
			.iter()
			.map(|(name, _)| if name.is_empty() { "(major)" } else { name })
			.collect();
		return Err(Error::new(alloc::format!(
			"Unknown chord quality: \"{quality}\" in \"{symbol}\". Expected one of {}.",
			names.join(", ")
		)));
	};
	// `note_to_midi` needs an octave digit; the octave is irrelevant because only the pitch class survives the modulo.
	let mut name = String::new();
	name.push(letter);
	if let Some(accidental) = accidental {
		name.push(accidental);
	}
	name.push('4');
	let midi = note_to_midi(&name)?;
	let root_pitch_class = (((midi % 12.0) + 12.0) % 12.0) as u8;
	Ok(ParsedChord {
		root_pitch_class,
		intervals,
	})
}

/// The pitch a chord's root is placed near: a MIDI number or a note name (parsed when a chord is voiced, so a bad name fails then).
#[derive(Clone, Debug, PartialEq)]
pub enum Anchor {
	/// A MIDI note number, such as `60.0` for middle C. It need not be whole.
	Midi(f64),
	/// A note name such as `"c3"`, read with [`note_to_midi`] each time a chord is voiced.
	Name(String),
}

impl From<f64> for Anchor {
	fn from(midi: f64) -> Self {
		Anchor::Midi(midi)
	}
}

impl From<&str> for Anchor {
	fn from(name: &str) -> Self {
		Anchor::Name(name.into())
	}
}

/// What [`Pattern::voicing`] and [`voicing_pitches`] take: where to centre the chords.
///
/// The default anchors on middle C (MIDI 60), so every root lands from F#3 up to F4. Build one with [`VoicingOptions::default`], [`VoicingOptions::anchor_midi`], or [`VoicingOptions::anchor_name`].
///
/// ```
/// use undertone_pattern::chord::VoicingOptions;
/// let low = VoicingOptions::anchor_name("c3");
/// let lower = VoicingOptions::anchor_midi(36.0);
/// assert_ne!(low, lower);
/// assert_eq!(VoicingOptions::default().anchor, None);
/// ```
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VoicingOptions {
	/// The pitch the root lands within a half octave of; middle C when `None`.
	pub anchor: Option<Anchor>,
}

impl VoicingOptions {
	/// Anchors on a MIDI note number.
	pub fn anchor_midi(midi: f64) -> Self {
		VoicingOptions {
			anchor: Some(Anchor::Midi(midi)),
		}
	}

	/// Anchors on a note name. The name is not checked here: as in the reference, a bad one fails when the pattern is queried.
	pub fn anchor_name(name: &str) -> Self {
		VoicingOptions {
			anchor: Some(Anchor::Name(name.into())),
		}
	}
}

const DEFAULT_ANCHOR_MIDI: f64 = 60.0;

/// The representative of `pitch_class` within `[anchor - 6, anchor + 6)`.
fn root_midi_near_anchor(pitch_class: f64, anchor_midi: f64) -> f64 {
	let low = anchor_midi - 6.0;
	low + ((((pitch_class - low) % 12.0) + 12.0) % 12.0)
}

/// Resolves a chord symbol to MIDI note numbers: the root within a half octave of the anchor and every other tone stacked above it, ascending, with duplicates removed.
///
/// It is a pure function of the symbol and the anchor, so two chords that share a root and overlap in tones (`Dm` then `Dm7`) land their common tones on the same notes. The errors are [`parse_chord`]'s, then the anchor's: a note name that does not parse gives the `Invalid note name` message.
///
/// ```
/// use undertone_pattern::chord::{voicing_pitches, VoicingOptions};
/// let default = VoicingOptions::default();
/// assert_eq!(voicing_pitches("C", &default).unwrap(), [60.0, 64.0, 67.0]);
/// // The ninth is stacked an octave up rather than folded back next to the root.
/// assert_eq!(voicing_pitches("Dm9", &default).unwrap(), [62.0, 65.0, 69.0, 72.0, 76.0]);
/// // A lower anchor moves the root, not the shape.
/// assert_eq!(
///     voicing_pitches("G7", &VoicingOptions::anchor_name("c3")).unwrap(),
///     [43.0, 47.0, 50.0, 53.0]
/// );
/// ```
pub fn voicing_pitches(symbol: &str, options: &VoicingOptions) -> Result<Vec<f64>> {
	let parsed = parse_chord(symbol)?;
	let anchor_midi = match &options.anchor {
		None => DEFAULT_ANCHOR_MIDI,
		Some(Anchor::Midi(midi)) => *midi,
		Some(Anchor::Name(name)) => note_to_midi(name)?,
	};
	let root = root_midi_near_anchor(f64::from(parsed.root_pitch_class), anchor_midi);
	let mut pitches: Vec<f64> = Vec::with_capacity(parsed.intervals.len());
	for interval in parsed.intervals {
		let pitch = root + f64::from(*interval);
		// `new Set(...)` keeps the first of equal numbers, and treats NaN as equal to NaN.
		if !pitches
			.iter()
			.any(|p| *p == pitch || (p.is_nan() && pitch.is_nan()))
		{
			pitches.push(pitch);
		}
	}
	pitches.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
	Ok(pitches)
}

/// Starts a pattern of chord symbols from a mini-notation string (`"<Dm9 BbM7 Gm9 A7sus>"`). Chain [`Pattern::voicing`] to expand each chord into simultaneous notes.
///
/// Every symbol is checked here, as `note()` checks its pitches, so a typo fails when the pattern is built, with the mini-notation position in the message. Each hap holds `{ chord: "<symbol>" }`.
///
/// ```
/// use undertone_pattern::chord::chord;
/// use undertone_pattern::{Fraction, Span, Value};
/// let p = chord("<Dm9 BbM7>").unwrap();
/// let haps = p.query(Span::new(Fraction::from_int(1), Fraction::from_int(2)));
/// assert_eq!(haps[0].value.get("chord"), Some(&Value::Str("BbM7".into())));
/// assert!(chord("Cmin").is_err());
/// ```
pub fn chord(input: &str) -> Result<Pattern<Value>> {
	mini::parse(input, |word| {
		parse_chord(word).map_err(|e| String::from(e.message()))?;
		Ok(Value::field("chord", Value::Str(word.into())))
	})
}

impl Pattern<Value> {
	/// Expands chord events from [`chord`] into simultaneous note events: one chord onset becomes one hap per tone, all sharing the chord's whole and part, each with the `pitch` in Hz and the chord's other fields. Events without a `chord` (already pitched by `note()` or `n()`) pass through unchanged.
	///
	/// The anchor is read when a chord is voiced, so an `anchor` name that is not a note fails when the pattern is queried (see [`Pattern::try_query`]), not here.
	///
	/// ```
	/// use undertone_pattern::chord::{chord, VoicingOptions};
	/// use undertone_pattern::{Fraction, Span, Value};
	/// let p = chord("C").unwrap().voicing(VoicingOptions::default());
	/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	/// let pitches: Vec<_> = haps.iter().map(|h| h.value.get("pitch").cloned().unwrap()).collect();
	/// assert_eq!(pitches, [
	///     Value::Num(261.6255653005986),
	///     Value::Num(329.6275569128699),
	///     Value::Num(391.99543598174927),
	/// ]);
	/// // The chord field is gone, and the three haps share one whole.
	/// assert!(haps.iter().all(|h| h.value.get("chord").is_none() && h.whole == haps[0].whole));
	/// ```
	pub fn voicing(&self, options: VoicingOptions) -> Pattern<Value> {
		self.fmap(MapFn::Voicing(options))
	}
}

/// Voices one hap value: the chord's tones as values (`rest` plus `pitch`), or the value itself when it holds no chord.
pub(crate) fn voice_value(value: &Value, options: &VoicingOptions) -> Result<Vec<Value>> {
	let Value::Map(map) = value else {
		return Ok(alloc::vec![value.clone()]);
	};
	let Some(Value::Str(symbol)) = map.get("chord") else {
		return Ok(alloc::vec![value.clone()]);
	};
	let pitches = voicing_pitches(symbol, options)?;
	Ok(pitches
		.into_iter()
		.map(|midi| {
			let mut rest = map.clone();
			rest.remove("chord");
			rest.insert("pitch".into(), Value::Num(midi_to_frequency(midi)));
			Value::Map(rest)
		})
		.collect())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_quality_list_is_in_javascript_property_order() {
		let err = parse_chord("Cx").unwrap_err();
		assert_eq!(
			err.message(),
			"Unknown chord quality: \"x\" in \"Cx\". Expected one of 6, 7, 9, (major), m, m6, maj7, M7, m7, maj9, M9, m9, add9, madd9, sus2, sus4, 7sus, 7sus4, dim, dim7, aug, m7b5."
		);
	}

	#[test]
	fn roots_wrap_into_a_pitch_class() {
		assert_eq!(parse_chord("Cb").unwrap().root_pitch_class, 11);
		assert_eq!(parse_chord("B#").unwrap().root_pitch_class, 0);
		assert_eq!(parse_chord("e").unwrap().root_pitch_class, 4);
		assert_eq!(parse_chord("  F#m7 ").unwrap().root_pitch_class, 6);
	}

	#[test]
	fn a_second_b_is_a_quality_not_a_flat() {
		assert!(
			parse_chord("Bbb")
				.unwrap_err()
				.message()
				.starts_with("Unknown chord quality: \"b\" in \"Bbb\".")
		);
	}

	#[test]
	fn a_line_break_inside_a_symbol_is_invalid() {
		assert_eq!(
			parse_chord("C\nm").unwrap_err().message(),
			"Invalid chord symbol: \"C\nm\"."
		);
	}

	#[test]
	fn huge_anchors_keep_the_set_semantics() {
		// 1e300 + 4 is 1e300 in doubles, so the tones collapse into one, as `new Set` does.
		let one = voicing_pitches("C", &VoicingOptions::anchor_midi(1e300)).unwrap();
		assert_eq!(one.len(), 1);
		let nan = voicing_pitches("C", &VoicingOptions::anchor_midi(f64::INFINITY)).unwrap();
		assert_eq!(nan.len(), 1);
		assert!(nan[0].is_nan());
	}

	#[test]
	fn a_pitched_event_passes_through_voicing() {
		let p = crate::control::note("c3").unwrap();
		let v = p.voicing(VoicingOptions::anchor_name("zz"));
		// No chord, so the bad anchor is never read.
		let span = crate::Span::new(crate::Fraction::from_int(0), crate::Fraction::from_int(1));
		assert_eq!(v.try_query(span).unwrap().len(), 1);
	}
}
