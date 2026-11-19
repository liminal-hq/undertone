// Voice-parameter patterns: note(), sound(), n().scale(), and the patterned controls, at the pattern level
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `note`, `sound`, `s`, `n`, `scale`, and the first four patterned controls (`gain`, `lpf`, `pan`, `attack`).
//!
//! This covers what a program needs at layer 1 (haps): the values are [`Value`] maps such as `{ pitch: "c4", gainLevel: 0.5 }`. Resolving them into full voice parameters is layer 2 and belongs to the engine work (RF-14), so nothing here knows about voices beyond the field names.

use crate::error::{Error, Result};
use crate::fraction::Fraction;
use crate::hap::{Hap, Span};
use crate::js;
use crate::mini;
use crate::pattern::{Node, Pattern, pure};
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

fn note_error(name: &str) -> Error {
	Error::new(alloc::format!(
		"Invalid note name: \"{name}\". Expected e.g. \"c2\", \"a4\", \"f#3\", \"bb3\"."
	))
}

/// A note name (`c2`, `a4`, `f#3`, `bb3`) as a MIDI note number, with C4 as 60.
///
/// ```
/// use undertone_pattern::control::note_to_midi;
/// assert_eq!(note_to_midi("c4").unwrap(), 60.0);
/// assert_eq!(note_to_midi("Bb2").unwrap(), 46.0);
/// assert!(note_to_midi("zz").is_err());
/// ```
pub fn note_to_midi(name: &str) -> Result<f64> {
	let trimmed = js::trim(name);
	let mut chars = trimmed.chars().peekable();
	let letter = chars.next().ok_or_else(|| note_error(name))?;
	let base = match letter.to_ascii_lowercase() {
		'c' if letter.is_ascii_alphabetic() => 0.0,
		'd' if letter.is_ascii_alphabetic() => 2.0,
		'e' if letter.is_ascii_alphabetic() => 4.0,
		'f' if letter.is_ascii_alphabetic() => 5.0,
		'g' if letter.is_ascii_alphabetic() => 7.0,
		'a' if letter.is_ascii_alphabetic() => 9.0,
		'b' if letter.is_ascii_alphabetic() => 11.0,
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
pub fn midi_to_frequency(midi: f64) -> f64 {
	440.0 * js::pow(2.0, (midi - 69.0) / 12.0)
}

/// A frequency in Hz must be a finite number above zero.
fn check_frequency(hz: f64) -> Result<f64> {
	if !hz.is_finite() || hz <= 0.0 {
		return Err(Error::new(alloc::format!(
			"Invalid frequency: {}",
			js::number_to_string(hz)
		)));
	}
	Ok(hz)
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
fn is_unsigned_decimal(word: &str) -> bool {
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

/// The controls that can be patterned, with their field, name, and rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Control {
	/// `gain`: the peak amplitude, field `gainLevel`.
	Gain,
	/// `lpf`: the lowpass cutoff in Hz, field `filterCutoff`.
	Lpf,
	/// `pan`: the stereo position from -1 to 1, field `pan`, clamped.
	Pan,
	/// `attack`: the envelope attack in seconds, field `attack`, never negative.
	Attack,
}

impl Control {
	/// The voice-parameter field the control writes.
	pub fn key(self) -> &'static str {
		match self {
			Control::Gain => "gainLevel",
			Control::Lpf => "filterCutoff",
			Control::Pan => "pan",
			Control::Attack => "attack",
		}
	}

	/// The method's name, as the reference's messages write it.
	pub fn name(self) -> &'static str {
		match self {
			Control::Gain => "gain",
			Control::Lpf => "lpf",
			Control::Pan => "pan",
			Control::Attack => "attack",
		}
	}

	/// A control by method name.
	pub fn from_name(name: &str) -> Option<Control> {
		[Control::Gain, Control::Lpf, Control::Pan, Control::Attack]
			.into_iter()
			.find(|c| c.name() == name)
	}

	/// The build-time check of a number or a literal in a string.
	fn validate(self, v: f64) -> core::result::Result<(), String> {
		match self {
			Control::Pan if v < -1.0 || v > 1.0 => Err(alloc::format!(
				"pan() position must be between -1 and 1, got {}",
				js::number_to_string(v)
			)),
			_ => Ok(()),
		}
	}

	/// What a pattern's value means for the control: made safe, never throwing. `None` leaves the field unset.
	fn sanitise(self, raw: Option<f64>) -> Option<f64> {
		let raw = raw.filter(|v| v.is_finite())?;
		match self {
			Control::Pan => Some((-1.0_f64).max(raw).min(1.0)),
			Control::Attack if raw < 0.0 => None,
			_ => Some(raw),
		}
	}
}

/// How a control is given: a literal (a number or a mini-notation string, checked at build time) or a pattern (read at each onset and made safe).
#[derive(Clone)]
pub enum ControlInput<T> {
	/// A number or string literal, as a pattern of numbers: the covering step supplies the value, and a rest leaves the field unset.
	Literal(Pattern<T>),
	/// A pattern given by the caller: a signal is read at each onset, anything else by the covering step, and values are sanitised.
	Pattern(Pattern<T>),
}

/// `^-?(\d+(\.\d+)?|\.\d+)$`
fn parse_number_word(word: &str) -> core::result::Result<f64, String> {
	let body = word.strip_prefix('-').unwrap_or(word);
	let ok = match body.strip_prefix('.') {
		Some(frac) => !frac.is_empty() && frac.bytes().all(|b| b.is_ascii_digit()),
		None => is_unsigned_decimal(body),
	};
	if !ok {
		return Err(alloc::format!("Invalid number in pattern: \"{word}\""));
	}
	Ok(js::string_to_number(word))
}

/// A value for a control: a plain number, a mini-notation string, or a pattern.
#[derive(Clone, Debug)]
pub enum ControlArg {
	/// A number, applied to every event.
	Number(f64),
	/// A mini-notation string of numbers, sampled per event.
	Text(String),
	/// A pattern of numbers (a signal is read at each onset).
	Pattern(Pattern<Value>),
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

	fn patch(&self, fields: Vec<(&str, Option<Value>)>) -> Pattern<Value> {
		self.fmap(MapFn::Merge(
			fields.into_iter().map(|(k, v)| (k.into(), v)).collect(),
		))
	}

	/// Sets the oscillator waveform or noise type, clearing any sample name.
	pub fn with_sound(&self, sound_type: &str) -> Pattern<Value> {
		self.patch(alloc::vec![
			("soundType", Some(Value::Str(sound_type.into()))),
			("sampleName", None),
		])
	}

	/// Sets a synth type (as `sound`) or a registered sample name, clearing the other.
	pub fn with_s(&self, name: &str) -> Pattern<Value> {
		if is_sound_type(name) {
			self.with_sound(name)
		} else {
			self.patch(alloc::vec![
				("sampleName", Some(Value::Str(name.into()))),
				("soundType", None),
			])
		}
	}

	/// Sets the bank prefix for sample lookup.
	pub fn with_bank(&self, name: &str) -> Pattern<Value> {
		self.patch(alloc::vec![("sampleBank", Some(Value::Str(name.into())))])
	}

	/// Sets the effects orbit, a non-negative integer. Scalar only.
	pub fn with_orbit(&self, n: f64) -> Result<Pattern<Value>> {
		if !js::is_integer(n) || n < 0.0 {
			return Err(Error::new(alloc::format!(
				"orbit() must be a non-negative integer, got {}",
				js::number_to_string(n)
			)));
		}
		Ok(self.patch(alloc::vec![("orbit", Some(Value::Num(n)))]))
	}

	/// Sets the cut group, a non-negative integer. Scalar only.
	pub fn with_cut(&self, group: f64) -> Result<Pattern<Value>> {
		if !js::is_integer(group) || group < 0.0 {
			return Err(Error::new(alloc::format!(
				"cut() must be a non-negative integer, got {}",
				js::number_to_string(group)
			)));
		}
		Ok(self.patch(alloc::vec![("cutGroup", Some(Value::Num(group)))]))
	}

	/// Sets the pan law in dB, from -6 to 0. Scalar only.
	pub fn with_panlaw(&self, db: f64) -> Result<Pattern<Value>> {
		if !db.is_finite() || !(-6.0..=0.0).contains(&db) {
			return Err(Error::new(alloc::format!(
				"panlaw() must be between -6 and 0 dB, got {}",
				js::number_to_string(db)
			)));
		}
		Ok(self.patch(alloc::vec![("panLaw", Some(Value::Num(db)))]))
	}

	/// Merges a patterned control into every event: structure comes from `self`, and the control is read at each event's own onset.
	///
	/// A number or a string is checked now (a bad literal fails here, like `pan(3)`); a pattern is read per event and made safe, never failing.
	///
	/// ```
	/// use undertone_pattern::control::{note, Control, ControlArg};
	/// use undertone_pattern::{Fraction, Span, Value};
	/// let p = note("c3 e3").unwrap().control(Control::Gain, ControlArg::Text("0.2 0.8".into())).unwrap();
	/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	/// assert_eq!(haps[1].value.get("gainLevel"), Some(&Value::Num(0.8)));
	/// let err = note("c3").unwrap().control(Control::Pan, ControlArg::Number(3.0)).unwrap_err();
	/// assert_eq!(err.message(), "pan() position must be between -1 and 1, got 3");
	/// ```
	pub fn control(&self, control: Control, arg: ControlArg) -> Result<Pattern<Value>> {
		let input = match arg {
			ControlArg::Number(v) => {
				control.validate(v).map_err(Error::new)?;
				ControlInput::Literal(pure(Value::Num(v)))
			}
			ControlArg::Text(text) => ControlInput::Literal(mini::parse(&text, |word| {
				let v = parse_number_word(word)?;
				control.validate(v)?;
				Ok(Value::Num(v))
			})?),
			ControlArg::Pattern(pattern) => ControlInput::Pattern(pattern),
		};
		Ok(Pattern::from_node(Node::WithControl {
			child: self.clone(),
			control,
			input,
		}))
	}

	/// Juxtaposes the pattern with a transformed copy of itself: the original plays hard left (`pan(-1)`), `transform(self)` plays hard right (`pan(1)`), as `pat.jux(rev)` does in the reference.
	///
	/// The transform is a function of the pattern that runs once, here, and the tree stores both patterns, the closure-at-construction rule of [`Pattern::every`].
	///
	/// ```
	/// use undertone_pattern::control::note;
	/// use undertone_pattern::{Fraction, Span, Value};
	/// let p = note("c3 e3").unwrap().jux(|p| p.rev()).unwrap();
	/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	/// let pans: Vec<_> = haps.iter().map(|h| h.value.get("pan").cloned()).collect();
	/// assert_eq!(pans.iter().filter(|p| **p == Some(Value::Num(-1.0))).count(), 2);
	/// assert_eq!(pans.iter().filter(|p| **p == Some(Value::Num(1.0))).count(), 2);
	/// ```
	pub fn jux(
		&self,
		transform: impl FnOnce(&Pattern<Value>) -> Pattern<Value>,
	) -> Result<Pattern<Value>> {
		let left = self.control(Control::Pan, ControlArg::Number(-1.0))?;
		let right = transform(self).control(Control::Pan, ControlArg::Number(1.0))?;
		Ok(crate::pattern::stack(alloc::vec![left, right]))
	}
}

/// The hap's onset time and the control's value there, for every hap of `child` over `span`.
pub(crate) fn query_with_control<T: Datum>(
	child: &Pattern<T>,
	control: Control,
	input: &ControlInput<T>,
	span: Span,
) -> Vec<Hap<T>> {
	let haps = child.query(span);
	if haps.is_empty() {
		return haps;
	}
	let (source, literal) = match input {
		ControlInput::Literal(p) => (p, true),
		ControlInput::Pattern(p) => (p, false),
	};
	let apply = |hap: Hap<T>, raw: Option<f64>| -> Hap<T> {
		match raw {
			Some(v) => Hap {
				value: hap.value.with_number(control.key(), v),
				whole: hap.whole,
				part: hap.part,
			},
			None => hap,
		}
	};
	// A signal is read exactly at each onset, so the value never depends on how the query was cut.
	if !literal && source.has_sampler() {
		return haps
			.into_iter()
			.map(|hap| {
				let raw = source.sample_at(hap.onset()).and_then(|v| v.as_number());
				let value = control.sanitise(raw);
				apply(hap, value)
			})
			.collect();
	}
	// One control query covering every onset, instead of one query per hap.
	let onsets: Vec<Fraction> = haps.iter().map(Hap::onset).collect();
	let min_t = onsets.iter().copied().fold(onsets[0], Fraction::min);
	let max_t = onsets.iter().copied().fold(onsets[0], Fraction::max);
	let control_haps = source.query(Span::new(min_t, max_t + Fraction::from_int(1)));
	haps.into_iter()
		.map(|hap| {
			let t = hap.onset();
			let covering = control_haps
				.iter()
				.find(|c| c.part.begin <= t && t < c.part.end);
			match covering {
				None => hap,
				Some(c) => {
					let raw = c.value.as_number();
					let value = if literal { raw } else { control.sanitise(raw) };
					apply(hap, value)
				}
			}
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Fraction, Span};

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

	#[test]
	fn a_signal_control_reads_each_onset_and_a_literal_covers_by_step() {
		let melody = note("c3 e3 g3 e3").unwrap();
		let by_signal = melody
			.control(
				Control::Gain,
				ControlArg::Pattern(crate::signal::periodic(crate::signal::Shape::Saw, false)),
			)
			.unwrap();
		let gains: Vec<f64> = first_cycle(&by_signal)
			.iter()
			.map(|h| h.value.get("gainLevel").and_then(Value::as_number).unwrap())
			.collect();
		assert_eq!(gains, [0.0, 0.25, 0.5, 0.75]);
		let rest = melody
			.control(Control::Lpf, ControlArg::Text("2000 ~".into()))
			.unwrap();
		let cutoffs: Vec<Option<f64>> = first_cycle(&rest)
			.iter()
			.map(|h| h.value.get("filterCutoff").and_then(Value::as_number))
			.collect();
		assert_eq!(cutoffs, [Some(2000.0), Some(2000.0), None, None]);
	}

	#[test]
	fn a_pattern_is_made_safe_before_it_sets_a_control() {
		let melody = note("c3").unwrap();
		let loud = crate::pure(Value::Num(3.0));
		let panned = melody
			.control(Control::Pan, ControlArg::Pattern(loud))
			.unwrap();
		assert_eq!(
			first_cycle(&panned)[0].value.get("pan"),
			Some(&Value::Num(1.0))
		);
		let negative = crate::pure(Value::Num(-1.0));
		let attack = melody
			.control(Control::Attack, ControlArg::Pattern(negative))
			.unwrap();
		assert_eq!(first_cycle(&attack)[0].value.get("attack"), None);
	}
}
