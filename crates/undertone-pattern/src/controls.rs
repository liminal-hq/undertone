// The controls table, ControlInput, and the control methods of Pattern<ControlMap>, all generated from one list
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Every control of 0.4.0 (`gain`, `lpf`, `pan`, `autopan`, `panpath`, and the rest), listed once.
//!
//! The list is the `controls!` invocation near the bottom of this file. It produces three things at once, so they cannot drift apart:
//!
//! - [`CONTROLS`], the table as data: each row is a [`ControlSpec`] with the JavaScript name, the Rust name, the `VoiceParams` fields it writes, whether a pattern is accepted, the range and the clamping the reference applies, and a one-line description. The JavaScript bridge reads the same table, and the name-map test checks its JavaScript names against the TypeScript's exported methods.
//! - [`Control`], an enum with one variant per row. It is what the pattern tree stores in a [`Node::WithControl`], and [`Control::spec`] gives the row.
//! - The methods on [`Pattern<ControlMap>`](ControlMap) for the rows whose argument is a number, a mini-notation string, or a pattern (`gain`, `lpf`, `pan`, and thirty-six more), each taking `impl Into<ControlInput>`. The controls that need a different argument (a list, a name, an integer) are written by hand under the same table: `pan_slide`, `pan_path`, `pitch_steps`, `channels`, `surround`, `orbit`, `cut`, `pan_law`, `fm_env`, `fm_wave`, `autopan_shape`, `sound`, `s`, and `bank`.
//!
//! # Giving a control its value
//!
//! A [`ControlInput`] is built from what is at hand: a number (`0.5`), a mini-notation string (`"0.2 0.8"` or `"<.25 .72>"`), or a pattern (`sine.range(300.0, 3000.0)`, an `f64` or a [`Value`] pattern). The conversion never fails; the *call* checks it, so a bad literal is an error at the call, with the TypeScript's message, and not at play time.
//!
//! ```
//! use undertone_pattern::control::note;
//! use undertone_pattern::signal::periodic;
//! use undertone_pattern::signal::Shape;
//! use undertone_pattern::{Fraction, Span, Value};
//!
//! let melody = note("c3 e3 g3 e3")?
//!     .gain(0.5)?                                  // a number
//!     .lpf("400 800")?                             // a mini-notation string, read per event
//!     .pan(periodic::<f64>(Shape::Sine, true))?;   // a signal, read at each onset
//! let haps = melody.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
//! assert_eq!(haps[0].value.get("gainLevel"), Some(&Value::Num(0.5)));
//! assert_eq!(haps[2].value.get("filterCutoff"), Some(&Value::Num(800.0)));
//!
//! // A bad literal is an error at the call, with the TypeScript's message.
//! let err = note("c3")?.pan(3.0).unwrap_err();
//! assert_eq!(err.message(), "pan() position must be between -1 and 1, got 3");
//! # Ok::<(), undertone_pattern::Error>(())
//! ```
//!
//! What a pattern may give a control is made safe and never fails: a rest leaves the field unset, a value that is not a finite number leaves it unset, a bounded control clamps (`pan`, `autopandepth`, `autopanphase`, `panslide`), and an open bound leaves the field unset (a negative time, a rate that is not above zero). The reference also prints a warning once per control and kind of problem; that stays with the host, so the Rust crate does not print.
//!
//! # The controls that refuse a pattern
//!
//! `fmenv`, `fmwave`, `autopanshape`, `cut`, `orbit`, `panlaw`, `channels`, `surround`, `panpath`, `pitchsteps`, and the `seconds` of `panslide` are plain values: they cannot change from event to event. In Rust their methods take plain types, so a pattern does not compile. Through [`Pattern::control`] (the dynamic path the bridge uses), a pattern is refused with [`plain_value_error`], the TypeScript's message.

// The reference's checks are written as `!(v > 0)` so that NaN fails them; the negated form is the behaviour.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use crate::control::plain_value_error;
use crate::error::{Error, Result};
use crate::fraction::Fraction;
use crate::hap::{Hap, Span};
use crate::pattern::{Node, Pattern};
use crate::value::{Datum, MapFn, Value};
use crate::{js, math, mini};
use alloc::string::String;
use alloc::vec::Vec;

/// The value type of a voice-parameter pattern: a map of field names to values, the reference's `ControlPatch`. Every method in this module lives on `Pattern<ControlMap>`.
pub type ControlMap = Value;

/// The most speakers a [`Pattern::channels`] placement can address: FL, FR, C, LFE, SL, SR, RL, RR (7.1).
pub const MAX_CHANNELS: usize = 8;

/// The default frame rate of `pitchsteps` and `panpath` in frames per second: the rate of classic AdLib effects.
pub const DEFAULT_STEP_RATE: f64 = 140.0;

// ---------------------------------------------------------------------------------------------
// The table's row type
// ---------------------------------------------------------------------------------------------

/// What argument a control takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ArgKind {
	/// A number, a mini-notation string of numbers, or a pattern: the control can change from event to event.
	Patternable,
	/// As [`Patternable`](Self::Patternable) for the first argument, plus a plain number of seconds (`panslide`).
	PatternableWithTime,
	/// A plain non-negative integer (`orbit`, `cut`).
	Integer,
	/// A plain number (`panlaw`, `surround`).
	Number,
	/// One of a fixed list of words (`fmenv`, `fmwave`, `autopanshape`); the words are the row's `choices`.
	Choice,
	/// A name, not validated (`sound`, `s`, `bank`).
	Text,
	/// A plain list of numbers, with an optional frame rate (`pitchsteps`) or without one (`channels`).
	NumberList,
	/// A list of pans, or of `{ time, pan }` points, with an optional frame rate (`panpath`).
	Path,
}

/// The build-time check of a number or a literal in a mini-notation string. A literal that fails is an error at the call: the row's `error` text, then `, got ` and the number.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Check {
	/// Anything goes.
	Any,
	/// Fails below zero (`v < 0`).
	NotNegative,
	/// Fails unless above zero (`!(v > 0)`).
	Positive,
	/// Fails unless above zero and finite (`autopan`).
	PositiveFinite,
	/// Fails outside the range (`v < lo || v > hi`).
	OutsideRange(f64, f64),
	/// Fails unless within the range (`!(v >= lo && v <= hi)`).
	NotInRange(f64, f64),
}

impl Check {
	/// Whether `v` fails the check.
	pub fn fails(self, v: f64) -> bool {
		match self {
			Check::Any => false,
			Check::NotNegative => v < 0.0,
			Check::Positive => !(v > 0.0),
			Check::PositiveFinite => !(v > 0.0) || !v.is_finite(),
			Check::OutsideRange(lo, hi) => v < lo || v > hi,
			Check::NotInRange(lo, hi) => !(v >= lo && v <= hi),
		}
	}
}

/// What a *pattern* may give a control: the value is made safe, never an error.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Bound {
	/// Any finite number.
	Open,
	/// A value outside the range is clamped into it.
	Clamp(f64, f64),
	/// A negative value leaves the field unset (a time in seconds).
	UnsetIfNegative,
	/// A value that is not above zero leaves the field unset.
	UnsetIfNotPositive,
}

/// One control, as the table lists it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ControlSpec {
	/// The method's name in JavaScript, all lower case (`delayfeedback`). The bridge's name.
	pub js_name: &'static str,
	/// The method's name in Rust (`delay_feedback`).
	pub rust_name: &'static str,
	/// The `VoiceParams` fields (JSON names) the control writes, the first one being the field a patterned control sets.
	pub fields: &'static [&'static str],
	/// What argument it takes.
	pub arg: ArgKind,
	/// The build-time check of a number or string literal.
	pub check: Check,
	/// The message of a failed `check`, up to `, got `.
	pub error: &'static str,
	/// What a pattern's value may be.
	pub bound: Bound,
	/// Whether the value is negated on the way in (`early`).
	pub negate: bool,
	/// The name the reference's messages use, when it differs from the JavaScript name (`fmi` is `fm`).
	pub message_name: &'static str,
	/// For [`ArgKind::Choice`], the words allowed.
	pub choices: &'static [&'static str],
	/// The range in words (`"0 to 1"`), for the documentation.
	pub range: &'static str,
	/// A sentence on what the control does.
	pub summary: &'static str,
}

impl ControlSpec {
	const fn new(
		js_name: &'static str,
		arg: ArgKind,
		range: &'static str,
		summary: &'static str,
	) -> ControlSpec {
		ControlSpec {
			js_name,
			rust_name: "",
			fields: &[],
			arg,
			check: Check::Any,
			error: "",
			bound: Bound::Open,
			negate: false,
			message_name: js_name,
			choices: &[],
			range,
			summary,
		}
	}
	const fn patternable(js: &'static str, range: &'static str, summary: &'static str) -> Self {
		Self::new(js, ArgKind::Patternable, range, summary)
	}
	const fn pan_slide_like(js: &'static str, range: &'static str, summary: &'static str) -> Self {
		Self::new(js, ArgKind::PatternableWithTime, range, summary)
	}
	const fn integer(js: &'static str, range: &'static str, summary: &'static str) -> Self {
		Self::new(js, ArgKind::Integer, range, summary)
	}
	const fn number(js: &'static str, range: &'static str, summary: &'static str) -> Self {
		Self::new(js, ArgKind::Number, range, summary)
	}
	const fn choice(js: &'static str, range: &'static str, summary: &'static str) -> Self {
		Self::new(js, ArgKind::Choice, range, summary)
	}
	const fn text(js: &'static str, range: &'static str, summary: &'static str) -> Self {
		Self::new(js, ArgKind::Text, range, summary)
	}
	const fn list(js: &'static str, range: &'static str, summary: &'static str) -> Self {
		Self::new(js, ArgKind::NumberList, range, summary)
	}
	const fn path(js: &'static str, range: &'static str, summary: &'static str) -> Self {
		Self::new(js, ArgKind::Path, range, summary)
	}
	const fn rust(mut self, name: &'static str) -> Self {
		self.rust_name = name;
		self
	}
	const fn fields(mut self, fields: &'static [&'static str]) -> Self {
		self.fields = fields;
		self
	}
	const fn check(mut self, check: Check) -> Self {
		self.check = check;
		self
	}
	const fn error(mut self, error: &'static str) -> Self {
		self.error = error;
		self
	}
	const fn bound(mut self, bound: Bound) -> Self {
		self.bound = bound;
		self
	}
	const fn negate(mut self, negate: bool) -> Self {
		self.negate = negate;
		self
	}
	const fn message_name(mut self, name: &'static str) -> Self {
		self.message_name = name;
		self
	}
	const fn choices(mut self, choices: &'static [&'static str]) -> Self {
		self.choices = choices;
		self
	}

	/// Whether the control (or its first argument) can be a pattern.
	pub fn is_patternable(&self) -> bool {
		matches!(
			self.arg,
			ArgKind::Patternable | ArgKind::PatternableWithTime
		)
	}

	/// Whether the control refuses a pattern with [`plain_value_error`]: a plain value that cannot change from event to event. Names and words (`sound`, `s`, `bank`) are not in this set, because the reference does not check them.
	pub fn is_scalar_only(&self) -> bool {
		!self.is_patternable() && self.arg != ArgKind::Text
	}

	/// The field a patterned control sets, the first of `fields`.
	pub fn key(&self) -> &'static str {
		self.fields[0]
	}

	/// What a pattern's value means for this control, never failing: `None` leaves the field unset.
	fn sanitise(&self, raw: Option<f64>) -> Option<f64> {
		let raw = raw.filter(|v| v.is_finite())?;
		let bounded = match self.bound {
			Bound::Open => raw,
			Bound::Clamp(lo, hi) => hi.min(lo.max(raw)),
			Bound::UnsetIfNegative if raw < 0.0 => return None,
			Bound::UnsetIfNotPositive if !(raw > 0.0) => return None,
			Bound::UnsetIfNegative | Bound::UnsetIfNotPositive => raw,
		};
		Some(self.transform(bounded))
	}

	/// The value after the control's own change (negated for `early`).
	fn transform(&self, v: f64) -> f64 {
		if self.negate { -v } else { v }
	}

	/// The error of a literal that fails the check, with the number written as JavaScript writes it.
	fn literal_error(&self, v: f64) -> Error {
		Error::new(alloc::format!(
			"{}, got {}",
			self.error,
			js::number_to_string(v)
		))
	}
}

// ---------------------------------------------------------------------------------------------
// ControlInput
// ---------------------------------------------------------------------------------------------

/// A value for a control: a number, a mini-notation string, or a pattern. The TypeScript's `ControlInput`.
///
/// Build one with `.into()` (the methods do it for you): `0.5`, `1` (an `i32`), `"0.2 0.8"`, a `String`, a `Pattern<f64>` such as a signal, or a `Pattern<ControlMap>`. Nothing is parsed or checked until the control method runs, so a bad string is an error at that call.
#[derive(Clone, Debug)]
pub enum ControlInput {
	/// A number, applied to every event.
	Number(f64),
	/// A mini-notation string of numbers (`".1 .2"`, `"<.25 .72>"`; `~` is a rest), sampled per event.
	Text(String),
	/// A pattern of numbers: a signal is read at each onset, anything else by the covering step.
	Pattern(Pattern<Value>),
}

impl From<f64> for ControlInput {
	fn from(n: f64) -> Self {
		ControlInput::Number(n)
	}
}
impl From<i32> for ControlInput {
	fn from(n: i32) -> Self {
		ControlInput::Number(f64::from(n))
	}
}
impl From<&str> for ControlInput {
	fn from(text: &str) -> Self {
		ControlInput::Text(text.into())
	}
}
impl From<String> for ControlInput {
	fn from(text: String) -> Self {
		ControlInput::Text(text)
	}
}
impl From<Pattern<Value>> for ControlInput {
	fn from(pattern: Pattern<Value>) -> Self {
		ControlInput::Pattern(pattern)
	}
}
impl From<&Pattern<Value>> for ControlInput {
	fn from(pattern: &Pattern<Value>) -> Self {
		ControlInput::Pattern(pattern.clone())
	}
}
impl From<Pattern<f64>> for ControlInput {
	/// A pattern of plain numbers (a signal such as `sine`) as a control source. It keeps its point sampler, so a signal is still read at each onset.
	fn from(pattern: Pattern<f64>) -> Self {
		ControlInput::Pattern(pattern.fmap_with(|n: &f64| Value::Num(*n)))
	}
}
impl From<&Pattern<f64>> for ControlInput {
	fn from(pattern: &Pattern<f64>) -> Self {
		ControlInput::from(pattern.clone())
	}
}

/// Where a `WithControl` node reads its values: a literal checked at build time, or a pattern read at each onset and made safe.
#[derive(Clone)]
pub enum ControlSource<T> {
	/// A number or string literal, as a pattern of numbers: the covering step supplies the value, and a rest leaves the field unset.
	Literal(Pattern<T>),
	/// A pattern given by the caller: a signal is read at each onset, anything else by the covering step, and values are sanitised.
	Pattern(Pattern<T>),
}

impl<T: Datum> ControlSource<T> {
	/// Whether reading the control can fail at query time.
	pub(crate) fn can_fail(&self) -> bool {
		match self {
			ControlSource::Literal(p) | ControlSource::Pattern(p) => p.can_fail(),
		}
	}
}

/// `^-?(\d+(\.\d+)?|\.\d+)$`
fn parse_number_word(word: &str) -> core::result::Result<f64, String> {
	let body = word.strip_prefix('-').unwrap_or(word);
	let ok = match body.strip_prefix('.') {
		Some(frac) => !frac.is_empty() && frac.bytes().all(|b| b.is_ascii_digit()),
		None => crate::control::is_unsigned_decimal(body),
	};
	if !ok {
		return Err(alloc::format!("Invalid number in pattern: \"{word}\""));
	}
	Ok(js::string_to_number(word))
}

// ---------------------------------------------------------------------------------------------
// Reading a control at each onset (withControlPattern)
// ---------------------------------------------------------------------------------------------

/// The haps of `child` over `span`, each with the control's value at the hap's onset: `withControlPattern`.
///
/// A signal is read exactly at each onset. Otherwise one query of the control covers every onset (from the first to the last plus a cycle), and each hap takes the value of the step that covers its onset; a rest or a missing step leaves the hap as it is.
pub(crate) fn query_with_control<T: Datum>(
	child: &Pattern<T>,
	control: Control,
	input: &ControlSource<T>,
	span: Span,
	out: &mut Vec<Hap<T>>,
	err: &mut Option<Error>,
) {
	let mut haps = Vec::new();
	child.run(span, &mut haps, err);
	if haps.is_empty() {
		return;
	}
	let spec = control.spec();
	let (source, literal) = match input {
		ControlSource::Literal(p) => (p, true),
		ControlSource::Pattern(p) => (p, false),
	};
	let apply = |hap: Hap<T>, value: Option<f64>| -> Hap<T> {
		match value {
			Some(v) => Hap {
				value: hap.value.with_number(spec.key(), v),
				whole: hap.whole,
				part: hap.part,
			},
			None => hap,
		}
	};
	if !literal && source.has_sampler() {
		out.extend(haps.into_iter().map(|hap| {
			let raw = source.sample_at(hap.onset()).and_then(|v| v.as_number());
			let value = spec.sanitise(raw);
			apply(hap, value)
		}));
		return;
	}
	let onsets: Vec<Fraction> = haps.iter().map(Hap::onset).collect();
	let min_t = onsets.iter().copied().fold(onsets[0], Fraction::min);
	let max_t = onsets.iter().copied().fold(onsets[0], Fraction::max);
	let mut control_haps = Vec::new();
	source.run(
		Span::new(min_t, max_t + Fraction::from_int(1)),
		&mut control_haps,
		err,
	);
	out.extend(haps.into_iter().map(|hap| {
		let t = hap.onset();
		let covering = control_haps
			.iter()
			.find(|c| c.part.begin <= t && t < c.part.end);
		match covering {
			None => hap,
			Some(c) => {
				let raw = c.value.as_number();
				let value = if literal {
					raw.map(|v| spec.transform(v))
				} else {
					spec.sanitise(raw)
				};
				apply(hap, value)
			}
		}
	}));
}

// ---------------------------------------------------------------------------------------------
// The table, the Control enum, and the generated methods
// ---------------------------------------------------------------------------------------------

/// Writes the table, the [`Control`] enum, and the methods of the rows in the `patternable` group from one list. A row is
///
/// `rust_name: Variant = kind("javascript", "range", "what it does") { builder: argument, ... };`
///
/// where `kind` and the builders are the `const fn`s of [`ControlSpec`]. The order of the rows is the order of the enum, so `Control as usize` is the row's index in [`CONTROLS`].
macro_rules! controls {
	(
		patternable {
			$( $name:ident : $Variant:ident = $kind:ident($js:literal, $range:literal, $doc:literal)
				$({ $($key:ident : $val:expr),* $(,)? })? ; )*
		}
		plain {
			$( $pname:ident : $PVariant:ident = $pkind:ident($pjs:literal, $prange:literal, $pdoc:literal)
				$({ $($pkey:ident : $pval:expr),* $(,)? })? ; )*
		}
	) => {
		/// Every control of 0.4.0, one row each, in the order of the [`Control`] enum. The JavaScript bridge reads this table, and the name-map test checks its JavaScript names against the TypeScript.
		pub const CONTROLS: &[ControlSpec] = &[
			$( ControlSpec::$kind($js, $range, $doc).rust(stringify!($name) ) $($(.$key($val))*)? , )*
			$( ControlSpec::$pkind($pjs, $prange, $pdoc).rust(stringify!($pname)) $($(.$pkey($pval))*)? , )*
		];

		/// A control: the variant is the row of [`CONTROLS`] with the same position. [`Control::spec`] gives the row.
		#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
		#[repr(u8)]
		pub enum Control {
			$( #[doc = concat!("`", $js, "`: ", $doc)] $Variant, )*
			$( #[doc = concat!("`", $pjs, "`: ", $pdoc)] $PVariant, )*
		}

		impl Control {
			/// Every control, in table order.
			pub const ALL: &'static [Control] = &[ $( Control::$Variant, )* $( Control::$PVariant, )* ];
		}

		impl Pattern<ControlMap> {
			$(
				#[doc = concat!($doc, "\n\n**Range:** ", $range, ". **JavaScript name:** `", $js, "`.\n\nThe argument is a number, a mini-notation string, or a pattern (see [`ControlInput`]); a bad literal is an error here.")]
				pub fn $name(&self, input: impl Into<ControlInput>) -> Result<Pattern<ControlMap>> {
					self.control(Control::$Variant, input)
				}
			)*
		}
	};
}

controls! {
	patternable {
		attack: Attack = patternable("attack", "0 or more seconds", "Amplitude envelope attack time, in seconds.")
			{ fields: &["attack"], bound: Bound::UnsetIfNegative };
		decay: Decay = patternable("decay", "0 or more seconds", "Amplitude envelope decay time, in seconds.")
			{ fields: &["decay"], bound: Bound::UnsetIfNegative };
		sustain: Sustain = patternable("sustain", "0 to 1", "Fraction of the gain the decay stage settles to before release.")
			{ fields: &["sustain"] };
		release: Release = patternable("release", "0 or more seconds", "Amplitude envelope release time, in seconds.")
			{ fields: &["release"], bound: Bound::UnsetIfNegative };
		gain: Gain = patternable("gain", "0 to 1", "Peak amplitude of the voice.")
			{ fields: &["gainLevel"] };
		lpf: Lpf = patternable("lpf", "Hz, above 0", "Base lowpass cutoff in Hz. Creates a filter stage; leave it out to skip filtering.")
			{ fields: &["filterCutoff"] };
		lpenv: Lpenv = patternable("lpenv", "Hz", "Hz the filter envelope adds on top of the cutoff at its peak.")
			{ fields: &["filterEnvAmount"] };
		lpa: Lpa = patternable("lpa", "0 or more seconds", "Filter envelope attack time, in seconds.")
			{ fields: &["filterAttack"], bound: Bound::UnsetIfNegative };
		lpd: Lpd = patternable("lpd", "0 or more seconds", "Filter envelope decay time, in seconds.")
			{ fields: &["filterDecay"], bound: Bound::UnsetIfNegative };
		lps: Lps = patternable("lps", "0 to 1", "Fraction between the cutoff and its envelope peak that the filter decay settles to.")
			{ fields: &["filterSustain"] };
		lpr: Lpr = patternable("lpr", "0 or more seconds", "Filter envelope release time, in seconds.")
			{ fields: &["filterRelease"], bound: Bound::UnsetIfNegative };
		slide: Slide = patternable("slide", "0 or more seconds", "Pitch glide (portamento): each note starts an octave above its pitch and slides down over this many seconds.")
			{ fields: &["slideTime"], bound: Bound::UnsetIfNegative };
		fm: Fm = patternable("fm", "0 or more", "FM modulation index: the modulator swings the carrier's frequency by the index times the modulator's frequency. 0 turns it off. Synth voices only.")
			{ fields: &["fmIndex"], check: Check::NotNegative, error: "fm() must not be negative", bound: Bound::UnsetIfNegative };
		fmi: Fmi = patternable("fmi", "0 or more", "An alias of `fm` under another name.")
			{ fields: &["fmIndex"], check: Check::NotNegative, error: "fm() must not be negative", bound: Bound::UnsetIfNegative, message_name: "fm" };
		fmh: Fmh = patternable("fmh", "above 0", "FM harmonicity: the modulator's frequency as a multiple of the carrier's. Whole numbers give harmonic tones, fractions give bells and metal.")
			{ fields: &["fmHarmonicity"], check: Check::Positive, error: "fmh() must be positive", bound: Bound::UnsetIfNotPositive };
		fm_attack: FmAttack = patternable("fmattack", "0 or more seconds", "Seconds for the FM depth to reach the full index.")
			{ fields: &["fmAttack"], bound: Bound::UnsetIfNegative };
		fm_decay: FmDecay = patternable("fmdecay", "0 or more seconds", "Seconds for the FM depth to fall to the FM sustain level times the index.")
			{ fields: &["fmDecay"], bound: Bound::UnsetIfNegative };
		fm_sustain: FmSustain = patternable("fmsustain", "0 to 1", "Fraction of the index the FM depth settles to (1 by default, or 0 when only the FM decay is set).")
			{ fields: &["fmSustain"] };
		fm_release: FmRelease = patternable("fmrelease", "0 or more seconds", "Seconds for the FM depth to fall to 0 after the gate closes.")
			{ fields: &["fmRelease"], bound: Bound::UnsetIfNegative };
		penv: Penv = patternable("penv", "semitones", "Pitch envelope depth in semitones: each note starts that far from its pitch (negative is below) and returns over the pitch decay. Synth voices only.")
			{ fields: &["pitchEnvAmount"] };
		pattack: Pattack = patternable("pattack", "0 or more seconds", "Seconds the pitch envelope takes to reach its offset (0 starts there).")
			{ fields: &["pitchAttack"], bound: Bound::UnsetIfNegative };
		pdecay: Pdecay = patternable("pdecay", "0 or more seconds", "Seconds the pitch envelope takes to return to the note (0.1 by default).")
			{ fields: &["pitchDecay"], bound: Bound::UnsetIfNegative };
		duration: Duration = patternable("duration", "0 or more seconds", "Explicit gate length in seconds: the envelopes hold at their sustain level for this long, then release, whatever the event's length. Needs a sustain above 0 to hold.")
			{ fields: &["duration"], check: Check::NotNegative, error: "duration() must not be negative", bound: Bound::UnsetIfNegative };
		legato: Legato = patternable("legato", "0 or more", "Gate length as a fraction of each event's own length (1 holds all of it). Gates even in a one-shot, and an explicit duration wins.")
			{ fields: &["legato"], check: Check::NotNegative, error: "legato() must not be negative", bound: Bound::UnsetIfNegative };
		velocity: Velocity = patternable("velocity", "0 or more (0 to 1 usually)", "Note strength: multiplies the peak amplitude only, so one instrument keeps its timbre from a ghost note (0.3) to an accent (1).")
			{ fields: &["velocity"], check: Check::NotNegative, error: "velocity() must not be negative", bound: Bound::UnsetIfNegative };
		nudge: Nudge = patternable("nudge", "seconds, may be negative", "Start-time offset in seconds applied to every event when played.")
			{ fields: &["nudgeTime"] };
		late: Late = patternable("late", "seconds, may be negative", "Delays every event by this many seconds: an alias of `nudge`.")
			{ fields: &["nudgeTime"] };
		early: Early = patternable("early", "seconds, may be negative", "Moves every event this many seconds earlier: the negative of `late` and `nudge`.")
			{ fields: &["nudgeTime"], negate: true };
		pan: Pan = patternable("pan", "-1 (hard left) to 1 (hard right); a pattern's value is clamped", "Stereo position.")
			{ fields: &["pan"], check: Check::OutsideRange(-1.0, 1.0), error: "pan() position must be between -1 and 1", bound: Bound::Clamp(-1.0, 1.0) };
		autopan: Autopan = patternable("autopan", "Hz, above 0", "Autopan: a low-frequency oscillator at this rate swings each note's pan either side of its pan, its pan path, or its pan slide, from the onset through the release.")
			{ fields: &["autopan"], check: Check::PositiveFinite, error: "autopan() rate must be positive", bound: Bound::UnsetIfNotPositive };
		autopan_depth: AutopanDepth = patternable("autopandepth", "0 to 1 (default 1); a pattern's value is clamped", "How far the autopan swings either side of the pan.")
			{ fields: &["autopanDepth"], check: Check::NotInRange(0.0, 1.0), error: "autopandepth() must be between 0 and 1", bound: Bound::Clamp(0.0, 1.0) };
		autopan_phase: AutopanPhase = patternable("autopanphase", "0 to 1 of a cycle (default 0); a pattern's value is clamped", "Where in its cycle the autopan starts: 0 starts a sine or triangle at the pan moving right and a square on the right, 0.5 starts the other way.")
			{ fields: &["autopanPhase"], check: Check::NotInRange(0.0, 1.0), error: "autopanphase() must be between 0 and 1", bound: Bound::Clamp(0.0, 1.0) };
		hpf: Hpf = patternable("hpf", "Hz, above 0", "Static highpass cutoff in Hz, in series after the lowpass. Creates a filter stage; leave it out to skip it.")
			{ fields: &["hpfCutoff"] };
		phaser: Phaser = patternable("phaser", "Hz, above 0", "LFO rate in Hz driving a four-stage allpass phaser. Creates the phaser stage; leave it out to skip it.")
			{ fields: &["phaserRate"] };
		room: Room = patternable("room", "0 to 1", "Reverb send level to this voice's orbit bus. No send at all when left out.")
			{ fields: &["roomLevel"] };
		room_size: RoomSize = patternable("roomsize", "about 1 (short) to 10 (long)", "Reverb decay character for the orbit's shared bus.")
			{ fields: &["roomSize"] };
		delay: Delay = patternable("delay", "0 to 1", "Delay send level to this voice's orbit bus. No send at all when left out.")
			{ fields: &["delayLevel"] };
		delay_time: DelayTime = patternable("delaytime", "0 or more seconds", "Delay time in seconds for the orbit's shared delay bus.")
			{ fields: &["delayTime"], bound: Bound::UnsetIfNegative };
		delay_feedback: DelayFeedback = patternable("delayfeedback", "0 to 1", "Feedback for the orbit's shared delay bus.")
			{ fields: &["delayFeedback"] };
	}
	plain {
		pan_slide: PanSlide = pan_slide_like("panslide", "-1 to 1; a pattern's value is clamped", "Pan slide: each note starts at this pan and moves linearly to its own pan (the centre without one) over the given seconds, or over the note's attack when omitted. A pan path wins.")
			{ fields: &["panSlideFrom", "panSlideTime"], check: Check::OutsideRange(-1.0, 1.0), error: "panslide() start must be between -1 and 1", bound: Bound::Clamp(-1.0, 1.0) };
		fm_env: FmEnv = choice("fmenv", "'lin' or 'exp' (default 'exp')", "Ramp shape of the FM depth envelope.")
			{ fields: &["fmEnvCurve"], choices: &["lin", "exp"] };
		fm_wave: FmWave = choice("fmwave", "one of the seven modulator waves (default sine)", "The modulator's waveform: an oscillator or a shaped wave.")
			{ fields: &["fmWave"], choices: &["sine", "triangle", "square", "sawtooth", "halfsine", "abssine", "pulsesine"] };
		autopan_shape: AutopanShape = choice("autopanshape", "'sine' (default), 'triangle', or 'square'", "The autopan oscillator's wave.")
			{ fields: &["autopanShape"], choices: &["sine", "triangle", "square"] };
		pitch_steps: PitchSteps = list("pitchsteps", "a non-empty list of finite semitone offsets, and a rate above 0 (default 140 frames a second)", "A frame-stepped pitch curve: semitone offsets from each note, one per frame, holding the last. Overrides the pitch envelope and the slide.")
			{ fields: &["pitchSteps", "pitchStepRate"] };
		cut: Cut = integer("cut", "a non-negative integer", "Cut group: a new event in the same group stops the previous one with a very short fade, like a closed hi-hat choking an open one.")
			{ fields: &["cutGroup"] };
		pan_path: PanPath = path("panpath", "pans from -1 to 1; points in time order", "Pan automation inside each note: a list of pans stepped one per frame, or `{ time, pan }` points in seconds that ramp linearly. Replaces the pan.")
			{ fields: &["panPath"] };
		pan_law: PanLaw = number("panlaw", "-6 to 0 dB (default -3, the equal-power law)", "Pan law: each side's level at the centre in dB. 0 keeps the louder side full like a balance control, and -6 dips the centre further.")
			{ fields: &["panLaw"] };
		orbit: Orbit = integer("orbit", "a non-negative integer (default 0)", "Which shared effects bus this voice's room and delay sends target.")
			{ fields: &["orbit"] };
		channels: Channels = list("channels", "1 to 8 gains, each finite and 0 or more", "Multichannel (up to 7.1) placement: per-speaker output gains in the order FL, FR, C, LFE, SL, SR, RL, RR. Takes precedence over the pan.")
			{ fields: &["channelGains"] };
		surround: Surround = number("surround", "an angle in degrees, finite", "Places the voice at an angle on the 7.1 speaker ring (0 front-centre, 30 front-right, 90 right side, 150 rear-right, 180 behind), equal-power panned between the two nearest speakers.")
			{ fields: &["channelGains"] };
		sound: Sound = text("sound", "a sound type", "Sets the oscillator waveform or noise type, clearing any sample name.")
			{ fields: &["soundType", "sampleName"] };
		s: S = text("s", "a sound type or a sample name", "Sets the voice to a synth sound type or a registered sample name, clearing the other so they never both apply.")
			{ fields: &["soundType", "sampleName"] };
		bank: Bank = text("bank", "a bank name", "Bank prefix for sample lookup: tried as the bank, an underscore, and the sample name before falling back to the bare sample name.")
			{ fields: &["sampleBank"] };
	}
}

impl Control {
	/// The control's row in [`CONTROLS`].
	pub fn spec(self) -> &'static ControlSpec {
		&CONTROLS[self as usize]
	}

	/// The control's JavaScript name, as the reference's messages and the tree's printout write it.
	pub fn name(self) -> &'static str {
		self.spec().js_name
	}

	/// The voice-parameter field a patterned control sets.
	pub fn key(self) -> &'static str {
		self.spec().key()
	}

	/// A control by JavaScript name (`delayfeedback`).
	pub fn from_name(name: &str) -> Option<Control> {
		Control::ALL.iter().copied().find(|c| c.name() == name)
	}
}

/// A control's row by JavaScript name.
///
/// ```
/// use undertone_pattern::controls::control_spec;
/// let spec = control_spec("delayfeedback").unwrap();
/// assert_eq!(spec.rust_name, "delay_feedback");
/// assert_eq!(spec.fields, &["delayFeedback"]);
/// ```
pub fn control_spec(js_name: &str) -> Option<&'static ControlSpec> {
	CONTROLS.iter().find(|spec| spec.js_name == js_name)
}

// ---------------------------------------------------------------------------------------------
// The methods
// ---------------------------------------------------------------------------------------------

fn number_text(v: f64) -> String {
	js::number_to_string(v)
}

fn in_pan_range(pan: f64) -> bool {
	(-1.0..=1.0).contains(&pan)
}

/// A frame-stepped pan as a pan path: each frame's pan holds until the next frame, then jumps.
fn stepped_pan_path(pans: &[f64], rate_hz: f64) -> Vec<(f64, f64)> {
	let mut points = alloc::vec![(0.0, pans[0])];
	for frame in 1..pans.len() {
		if pans[frame] == pans[frame - 1] {
			continue; // a held frame needs no point of its own
		}
		let time = frame as f64 / rate_hz;
		points.push((time, pans[frame - 1]));
		points.push((time, pans[frame]));
	}
	points
}

fn point_value(time: f64, pan: f64) -> Value {
	let mut map = alloc::collections::BTreeMap::new();
	map.insert("pan".into(), Value::Num(pan));
	map.insert("time".into(), Value::Num(time));
	Value::Map(map)
}

fn numbers_value(list: &[f64]) -> Value {
	Value::List(list.iter().map(|v| Value::Num(*v)).collect())
}

/// The seven speakers of the ring (LFE left out) as `(channel index, angle)`, sorted by angle.
const RING: [(usize, f64); 7] = [
	(6, -150.0),
	(4, -90.0),
	(0, -30.0),
	(2, 0.0),
	(1, 30.0),
	(5, 90.0),
	(7, 150.0),
];

/// The 7.1 channel gains (FL, FR, C, LFE, SL, SR, RL, RR) that place a sound at `angle_degrees` on the speaker ring, as `surroundGains` computes them: 0 degrees front-centre, 30 front-right, plus or minus 90 the sides, plus or minus 150 the rears, plus or minus 180 dead behind, equal-power panned between the two nearest speakers. The LFE is always 0.
///
/// ```
/// use undertone_pattern::controls::surround_gains;
/// assert_eq!(surround_gains(0.0).unwrap()[2], 1.0);
/// assert!(surround_gains(f64::NAN).is_err());
/// ```
pub fn surround_gains(angle_degrees: f64) -> Result<[f64; MAX_CHANNELS]> {
	if !angle_degrees.is_finite() {
		return Err(Error::new(alloc::format!(
			"surround() angle must be a finite number, got {}",
			number_text(angle_degrees)
		)));
	}
	let angle = ((angle_degrees % 360.0) + 540.0) % 360.0 - 180.0;
	let mut gains = [0.0; MAX_CHANNELS];
	let mut lower = RING[RING.len() - 1];
	let mut lower_angle = lower.1 - 360.0;
	for speaker in RING {
		if speaker.1 <= angle {
			lower = speaker;
			lower_angle = speaker.1;
		}
	}
	let mut upper = RING[0];
	let mut upper_angle = upper.1 + 360.0;
	for speaker in RING.iter().rev() {
		if speaker.1 >= angle {
			upper = *speaker;
			upper_angle = speaker.1;
		}
	}
	if lower.0 == upper.0 {
		gains[lower.0] = 1.0;
		return Ok(gains);
	}
	let t = (angle - lower_angle) / (upper_angle - lower_angle);
	gains[lower.0] = math::cos((t * core::f64::consts::PI) / 2.0);
	gains[upper.0] = math::sin((t * core::f64::consts::PI) / 2.0);
	Ok(gains)
}

impl Pattern<ControlMap> {
	/// A patch merged into every event: `Some` sets a field, `None` sets it to `undefined`.
	fn patch(&self, fields: Vec<(&str, Option<Value>)>) -> Pattern<ControlMap> {
		self.fmap(MapFn::Merge(
			fields.into_iter().map(|(k, v)| (k.into(), v)).collect(),
		))
	}

	/// Sets a control, given as a [`Control`] and a [`ControlInput`]: the dynamic form of every control method, which the bridge calls.
	///
	/// For a patternable control the value is read at each event's onset. A number or a string is checked now (a bad literal fails here, like `pan(3)`); a pattern is read per event and made safe, never failing. A scalar-only control given a pattern fails with [`plain_value_error`]. The controls that take lists (`channels`, `pitchsteps`, `panpath`) fail here: call their methods.
	///
	/// ```
	/// use undertone_pattern::control::note;
	/// use undertone_pattern::controls::Control;
	/// use undertone_pattern::{Fraction, Span, Value};
	/// let p = note("c3 e3")?.control(Control::Gain, "0.2 0.8")?;
	/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	/// assert_eq!(haps[1].value.get("gainLevel"), Some(&Value::Num(0.8)));
	/// # Ok::<(), undertone_pattern::Error>(())
	/// ```
	pub fn control(
		&self,
		control: Control,
		input: impl Into<ControlInput>,
	) -> Result<Pattern<ControlMap>> {
		let input = input.into();
		let spec = control.spec();
		if spec.is_patternable() {
			return self.with_control(control, input);
		}
		if matches!(input, ControlInput::Pattern(_)) && spec.is_scalar_only() {
			return Err(plain_value_error(spec.js_name));
		}
		// What JavaScript would see: a string is not a number, so a plain number control reports it as it was given.
		let given = |input: &ControlInput| match input {
			ControlInput::Number(n) => number_text(*n),
			ControlInput::Text(t) => t.clone(),
			ControlInput::Pattern(_) => String::new(),
		};
		match (control, &input) {
			(Control::Orbit, ControlInput::Number(n)) => self.orbit(*n),
			(Control::Cut, ControlInput::Number(n)) => self.cut(*n),
			(Control::PanLaw, ControlInput::Number(n)) => self.pan_law(*n),
			(Control::Surround, ControlInput::Number(n)) => self.surround(*n),
			(Control::FmEnv, ControlInput::Text(t)) => self.fm_env(t),
			(Control::FmWave, ControlInput::Text(t)) => self.fm_wave(t),
			(Control::AutopanShape, ControlInput::Text(t)) => self.autopan_shape(t),
			(Control::FmEnv, other) => self.fm_env(&given(other)),
			(Control::FmWave, other) => self.fm_wave(&given(other)),
			(Control::AutopanShape, other) => self.autopan_shape(&given(other)),
			(Control::Orbit | Control::Cut, other) => Err(Error::new(alloc::format!(
				"{}() must be a non-negative integer, got {}",
				spec.js_name,
				given(other)
			))),
			(Control::PanLaw, other) => Err(Error::new(alloc::format!(
				"panlaw() must be between -6 and 0 dB, got {}",
				given(other)
			))),
			(Control::Surround, other) => Err(Error::new(alloc::format!(
				"surround() angle must be a finite number, got {}",
				given(other)
			))),
			(Control::Sound, ControlInput::Text(t)) => Ok(self.sound(t)),
			(Control::S, ControlInput::Text(t)) => Ok(self.s(t)),
			(Control::Bank, ControlInput::Text(t)) => Ok(self.bank(t)),
			_ => Err(Error::new(alloc::format!(
				"{}() does not take this argument; call .{}() with its own argument type",
				spec.js_name,
				spec.rust_name
			))),
		}
	}

	/// Merges a patternable control into every event: structure comes from `self`, and the control is read at each event's own onset.
	fn with_control(&self, control: Control, input: ControlInput) -> Result<Pattern<ControlMap>> {
		let spec = control.spec();
		let check = |v: f64| -> core::result::Result<(), String> {
			if spec.check.fails(v) {
				return Err(spec.literal_error(v).message().into());
			}
			Ok(())
		};
		let source = match input {
			ControlInput::Number(v) => {
				check(v).map_err(Error::new)?;
				ControlSource::Literal(crate::pure(Value::Num(v)))
			}
			ControlInput::Text(text) => ControlSource::Literal(mini::parse(&text, |word| {
				let v = parse_number_word(word)?;
				check(v)?;
				Ok(Value::Num(v))
			})?),
			ControlInput::Pattern(pattern) => ControlSource::Pattern(pattern),
		};
		Ok(Pattern::from_node(Node::WithControl {
			child: self.clone(),
			control,
			input: source,
		}))
	}

	/// Pan slide: each note starts at pan `from` and moves linearly to its pan (the centre without one) over `seconds`, or over the note's attack when `seconds` is `None`. `from` is a number, a mini-notation string, or a pattern, clamped to -1 to 1 (a literal outside it is an error). A [`pan_path`](Self::pan_path) takes precedence.
	///
	/// **Range:** `from` from -1 to 1; `seconds` zero or more and finite. **JavaScript name:** `panslide`.
	pub fn pan_slide(
		&self,
		from: impl Into<ControlInput>,
		seconds: Option<f64>,
	) -> Result<Pattern<ControlMap>> {
		if let Some(seconds) = seconds
			&& !(seconds >= 0.0 && seconds.is_finite())
		{
			return Err(Error::new(alloc::format!(
				"panslide() time must be zero or more seconds, got {}",
				number_text(seconds)
			)));
		}
		let timed = match seconds {
			None => self.clone(),
			Some(seconds) => self.patch(alloc::vec![("panSlideTime", Some(Value::Num(seconds)))]),
		};
		timed.with_control(Control::PanSlide, from.into())
	}

	/// Ramp shape of the FM depth envelope: `"exp"` (the default, as in Strudel) or `"lin"`. Scalar only.
	///
	/// **JavaScript name:** `fmenv`.
	pub fn fm_env(&self, curve: &str) -> Result<Pattern<ControlMap>> {
		if !Control::FmEnv.spec().choices.contains(&curve) {
			return Err(Error::new(alloc::format!(
				"fmenv() must be 'lin' or 'exp', got \"{curve}\""
			)));
		}
		Ok(self.patch(alloc::vec![("fmEnvCurve", Some(Value::Str(curve.into())))]))
	}

	/// The modulator's waveform: `sine` (the default), `triangle`, `square`, `sawtooth`, or a shaped wave (`halfsine`, `abssine`, `pulsesine`). Scalar only.
	///
	/// **JavaScript name:** `fmwave`.
	pub fn fm_wave(&self, wave: &str) -> Result<Pattern<ControlMap>> {
		let spec = Control::FmWave.spec();
		if !spec.choices.contains(&wave) {
			return Err(Error::new(alloc::format!(
				"fmwave() must be one of {}, got \"{wave}\"",
				spec.choices.join(", ")
			)));
		}
		Ok(self.patch(alloc::vec![("fmWave", Some(Value::Str(wave.into())))]))
	}

	/// The autopan oscillator's wave: `"sine"` (the default), `"triangle"`, or `"square"`. Scalar only.
	///
	/// **JavaScript name:** `autopanshape`.
	pub fn autopan_shape(&self, shape: &str) -> Result<Pattern<ControlMap>> {
		if !Control::AutopanShape.spec().choices.contains(&shape) {
			return Err(Error::new(alloc::format!(
				"autopanshape() must be sine, triangle or square, got {shape}"
			)));
		}
		Ok(self.patch(alloc::vec![(
			"autopanShape",
			Some(Value::Str(shape.into()))
		)]))
	}

	/// A frame-stepped pitch curve: semitone offsets from each note, one per frame at `rate_hz` (default 140, the frame rate of classic AdLib effects), holding the last offset. Overrides the pitch envelope and the slide. Scalar only.
	///
	/// **Range:** a non-empty list of finite offsets; a rate above 0. **JavaScript name:** `pitchsteps`.
	pub fn pitch_steps(
		&self,
		semitones: &[f64],
		rate_hz: Option<f64>,
	) -> Result<Pattern<ControlMap>> {
		if semitones.is_empty() || !semitones.iter().all(|v| v.is_finite()) {
			return Err(Error::new(
				"pitchsteps() needs a non-empty array of finite semitone offsets",
			));
		}
		if let Some(rate) = rate_hz
			&& !(rate > 0.0)
		{
			return Err(Error::new(alloc::format!(
				"pitchsteps() rate must be positive, got {}",
				number_text(rate)
			)));
		}
		let mut fields = alloc::vec![("pitchSteps", Some(numbers_value(semitones)))];
		if let Some(rate) = rate_hz {
			fields.push(("pitchStepRate", Some(Value::Num(rate))));
		}
		Ok(self.patch(fields))
	}

	/// Cut group: a new event in the same group stops the previous one with a very short fade. The same number on different patterns shares one group. Scalar only.
	///
	/// **Range:** a non-negative integer. **JavaScript name:** `cut`.
	pub fn cut(&self, group: f64) -> Result<Pattern<ControlMap>> {
		if !js::is_integer(group) || group < 0.0 {
			return Err(Error::new(alloc::format!(
				"cut() must be a non-negative integer, got {}",
				number_text(group)
			)));
		}
		Ok(self.patch(alloc::vec![("cutGroup", Some(Value::Num(group)))]))
	}

	/// Pan automation inside each note, from a list of pans (one per frame at `rate_hz`, default 140, jumping from frame to frame and holding the last). It becomes the voice's `panPath`, replacing the pan. Scalar only.
	///
	/// **Range:** a non-empty list of pans from -1 to 1; a finite rate above 0. **JavaScript name:** `panpath`. For `{ time, pan }` points see [`pan_path_points`](Self::pan_path_points).
	pub fn pan_path(&self, pans: &[f64], rate_hz: Option<f64>) -> Result<Pattern<ControlMap>> {
		if pans.is_empty() {
			return Err(Error::new(
				"panpath() needs a non-empty array of pans or { time, pan } points",
			));
		}
		if !pans.iter().all(|pan| in_pan_range(*pan)) {
			return Err(Error::new("panpath() needs pans between -1 and 1"));
		}
		if let Some(rate) = rate_hz
			&& !(rate > 0.0 && rate.is_finite())
		{
			return Err(Error::new(alloc::format!(
				"panpath() rate must be positive, got {}",
				number_text(rate)
			)));
		}
		let points = stepped_pan_path(pans, rate_hz.unwrap_or(DEFAULT_STEP_RATE));
		Ok(self.patch(alloc::vec![(
			"panPath",
			Some(Value::List(
				points.iter().map(|(t, p)| point_value(*t, *p)).collect()
			))
		)]))
	}

	/// Pan automation inside each note, from `(time, pan)` points in seconds from the onset, which ramp linearly (two points at one time make a jump). The points' rate form does not exist in Rust, so the reference's "takes a rate only with an array of pans" error cannot arise. Scalar only.
	///
	/// **Range:** a non-empty list, each time finite and not before the last, each pan from -1 to 1. **JavaScript name:** `panpath`.
	pub fn pan_path_points(&self, points: &[(f64, f64)]) -> Result<Pattern<ControlMap>> {
		if points.is_empty() {
			return Err(Error::new(
				"panpath() needs a non-empty array of pans or { time, pan } points",
			));
		}
		let mut previous = 0.0;
		for (time, pan) in points {
			if !time.is_finite() || !in_pan_range(*pan) {
				return Err(Error::new(
					"panpath() points need a finite time and a pan between -1 and 1",
				));
			}
			if *time < previous {
				return Err(Error::new(alloc::format!(
					"panpath() times must not go backwards, got {} after {}",
					number_text(*time),
					number_text(previous)
				)));
			}
			previous = *time;
		}
		Ok(self.patch(alloc::vec![(
			"panPath",
			Some(Value::List(
				points.iter().map(|(t, p)| point_value(*t, *p)).collect()
			))
		)]))
	}

	/// Pan law: each side's level at the centre in dB. The default, -3, is the stereo panner's equal-power law; 0 keeps the louder side full like a balance control, and -6 dips the centre further. Scalar only.
	///
	/// **Range:** -6 to 0, finite. **JavaScript name:** `panlaw`.
	pub fn pan_law(&self, db: f64) -> Result<Pattern<ControlMap>> {
		if !db.is_finite() || !(-6.0..=0.0).contains(&db) {
			return Err(Error::new(alloc::format!(
				"panlaw() must be between -6 and 0 dB, got {}",
				number_text(db)
			)));
		}
		Ok(self.patch(alloc::vec![("panLaw", Some(Value::Num(db)))]))
	}

	/// Which shared effects bus this voice's room and delay sends target. Every voice sending to the same orbit shares one reverb and one delay line. Scalar only.
	///
	/// **Range:** a non-negative integer (default 0). **JavaScript name:** `orbit`.
	pub fn orbit(&self, n: f64) -> Result<Pattern<ControlMap>> {
		if !js::is_integer(n) || n < 0.0 {
			return Err(Error::new(alloc::format!(
				"orbit() must be a non-negative integer, got {}",
				number_text(n)
			)));
		}
		Ok(self.patch(alloc::vec![("orbit", Some(Value::Num(n)))]))
	}

	/// Multichannel (up to 7.1) placement: per-speaker output gains in the order FL, FR, C, LFE, SL, SR, RL, RR. Takes precedence over the pan. Scalar only.
	///
	/// **Range:** 1 to 8 gains, each finite and 0 or more. **JavaScript name:** `channels`.
	pub fn channels(&self, gains: &[f64]) -> Result<Pattern<ControlMap>> {
		if gains.is_empty() || gains.len() > MAX_CHANNELS {
			return Err(Error::new(alloc::format!(
				"channels() takes 1-{MAX_CHANNELS} gains, got {}",
				gains.len()
			)));
		}
		for level in gains {
			if !level.is_finite() || *level < 0.0 {
				return Err(Error::new(alloc::format!(
					"channels() gains must be finite and >= 0, got {}",
					number_text(*level)
				)));
			}
		}
		Ok(self.patch(alloc::vec![("channelGains", Some(numbers_value(gains)))]))
	}

	/// Places the voice at an angle on the 7.1 speaker ring: sugar for `channels(surround_gains(angle))`. Scalar only.
	///
	/// **Range:** a finite angle in degrees. **JavaScript name:** `surround`.
	pub fn surround(&self, angle_degrees: f64) -> Result<Pattern<ControlMap>> {
		let gains = surround_gains(angle_degrees)?;
		Ok(self.patch(alloc::vec![("channelGains", Some(numbers_value(&gains)))]))
	}

	/// Sets the oscillator waveform or noise type across all events, clearing any sample name (the sample name otherwise wins over the sound type in the engine). The type is not checked here, as in the reference.
	///
	/// **JavaScript name:** `sound`.
	pub fn sound(&self, sound_type: &str) -> Pattern<ControlMap> {
		self.patch(alloc::vec![
			("soundType", Some(Value::Str(sound_type.into()))),
			("sampleName", None),
		])
	}

	/// Sets the voice to a synth sound type (as [`sound`](Self::sound)) or to a registered sample name, clearing the other so the two never both apply.
	///
	/// **JavaScript name:** `s`.
	pub fn s(&self, name: &str) -> Pattern<ControlMap> {
		if crate::control::is_sound_type(name) {
			self.sound(name)
		} else {
			self.patch(alloc::vec![
				("sampleName", Some(Value::Str(name.into()))),
				("soundType", None),
			])
		}
	}

	/// Sets the bank prefix for sample lookup: tried as the bank, an underscore, and the sample name before falling back to the bare sample name.
	///
	/// **JavaScript name:** `bank`.
	pub fn bank(&self, name: &str) -> Pattern<ControlMap> {
		self.patch(alloc::vec![("sampleBank", Some(Value::Str(name.into())))])
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
		transform: impl FnOnce(&Pattern<ControlMap>) -> Pattern<ControlMap>,
	) -> Result<Pattern<ControlMap>> {
		let left = self.pan(-1.0)?;
		let right = transform(self).pan(1.0)?;
		Ok(crate::pattern::stack(alloc::vec![left, right]))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::control::note;

	fn first_cycle(p: &Pattern<ControlMap>) -> Vec<Hap<Value>> {
		p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)))
	}

	#[test]
	fn the_table_and_the_enum_agree() {
		assert_eq!(CONTROLS.len(), Control::ALL.len());
		assert_eq!(CONTROLS.len(), 53);
		for (i, control) in Control::ALL.iter().enumerate() {
			assert_eq!(*control as usize, i);
			assert_eq!(control.spec(), &CONTROLS[i]);
			assert_eq!(Control::from_name(control.name()), Some(*control));
			assert!(!control.spec().fields.is_empty(), "{}", control.name());
			assert!(!control.spec().rust_name.is_empty());
		}
		let mut names: Vec<&str> = CONTROLS.iter().map(|c| c.js_name).collect();
		names.sort_unstable();
		names.dedup();
		assert_eq!(
			names.len(),
			CONTROLS.len(),
			"a JavaScript name is listed twice"
		);
		let mut rust: Vec<&str> = CONTROLS.iter().map(|c| c.rust_name).collect();
		rust.sort_unstable();
		rust.dedup();
		assert_eq!(rust.len(), CONTROLS.len(), "a Rust name is listed twice");
	}

	#[test]
	fn the_scalar_only_controls_are_the_references_ten() {
		let mut scalar: Vec<&str> = CONTROLS
			.iter()
			.filter(|c| c.is_scalar_only())
			.map(|c| c.js_name)
			.collect();
		scalar.sort_unstable();
		let mut want = [
			"fmenv",
			"fmwave",
			"autopanshape",
			"cut",
			"orbit",
			"panlaw",
			"channels",
			"surround",
			"panpath",
			"pitchsteps",
		];
		want.sort_unstable();
		assert_eq!(scalar, want);
	}

	#[test]
	fn scalar_controls_refuse_a_pattern_with_the_references_message() {
		let p = note("c3 e3").unwrap();
		for name in [
			"fmenv",
			"fmwave",
			"autopanshape",
			"cut",
			"orbit",
			"panlaw",
			"channels",
			"surround",
			"panpath",
			"pitchsteps",
		] {
			let err = p
				.control(
					Control::from_name(name).unwrap(),
					crate::pure(Value::Num(1.0)),
				)
				.unwrap_err();
			assert_eq!(
				err.message(),
				alloc::format!(
					"{name}() takes a plain value, not a pattern; it cannot change from event to event"
				)
			);
		}
	}

	#[test]
	fn early_negates_a_literal_and_a_signal_after_it_is_made_safe() {
		let p = note("c3").unwrap();
		let early = p.early(0.25).unwrap();
		assert_eq!(
			first_cycle(&early)[0].value.get("nudgeTime"),
			Some(&Value::Num(-0.25))
		);
		let by_signal = p.early(crate::pure(Value::Num(0.5))).unwrap();
		assert_eq!(
			first_cycle(&by_signal)[0].value.get("nudgeTime"),
			Some(&Value::Num(-0.5))
		);
		let late = p.late("0.5").unwrap();
		assert_eq!(
			first_cycle(&late)[0].value.get("nudgeTime"),
			Some(&Value::Num(0.5))
		);
	}

	#[test]
	fn fmi_is_fm_with_fms_message() {
		let p = note("c3").unwrap();
		assert_eq!(
			p.fmi(-1.0).unwrap_err().message(),
			"fm() must not be negative, got -1"
		);
		assert_eq!(
			first_cycle(&p.fmi(2.0).unwrap())[0].value.get("fmIndex"),
			Some(&Value::Num(2.0))
		);
	}

	#[test]
	fn the_builders_check_literals_with_the_references_messages() {
		let p = note("c3").unwrap();
		let cases: [(Result<Pattern<Value>>, &str); 12] = [
			(p.fmh(0.0), "fmh() must be positive, got 0"),
			(
				p.duration(-0.5),
				"duration() must not be negative, got -0.5",
			),
			(
				p.legato("-1"),
				"Mini-notation error at position 0 in \"-1\": legato() must not be negative, got -1",
			),
			(p.velocity(-1.0), "velocity() must not be negative, got -1"),
			(p.autopan(0.0), "autopan() rate must be positive, got 0"),
			(
				p.autopan(f64::INFINITY),
				"autopan() rate must be positive, got Infinity",
			),
			(
				p.autopan_depth(2.0),
				"autopandepth() must be between 0 and 1, got 2",
			),
			(
				p.autopan_phase("1.5"),
				"Mini-notation error at position 0 in \"1.5\": autopanphase() must be between 0 and 1, got 1.5",
			),
			(
				p.pan_slide(-2.0, None),
				"panslide() start must be between -1 and 1, got -2",
			),
			(
				p.pan("0.5 3"),
				"Mini-notation error at position 4 in \"0.5 3\": pan() position must be between -1 and 1, got 3",
			),
			(
				p.gain("loud"),
				"Mini-notation error at position 0 in \"loud\": Invalid number in pattern: \"loud\"",
			),
			(
				p.pan_slide(0.5, Some(-1.0)),
				"panslide() time must be zero or more seconds, got -1",
			),
		];
		for (result, message) in cases {
			assert_eq!(result.unwrap_err().message(), message);
		}
		// Numbers a control does not check pass, as in the reference.
		assert!(p.attack(-1.0).is_ok());
		assert!(p.gain(7.0).is_ok());
	}

	#[test]
	fn a_pattern_is_made_safe_per_control() {
		let p = note("c3").unwrap();
		let value = |p: &Pattern<Value>, key: &str| first_cycle(p)[0].value.get(key).cloned();
		let giving = |n: f64| crate::pure(Value::Num(n));
		assert_eq!(
			value(&p.pan(giving(-3.0)).unwrap(), "pan"),
			Some(Value::Num(-1.0))
		);
		assert_eq!(value(&p.attack(giving(-1.0)).unwrap(), "attack"), None);
		assert_eq!(
			value(&p.attack(giving(0.0)).unwrap(), "attack"),
			Some(Value::Num(0.0))
		);
		assert_eq!(value(&p.fmh(giving(0.0)).unwrap(), "fmHarmonicity"), None);
		assert_eq!(value(&p.autopan(giving(0.0)).unwrap(), "autopan"), None);
		assert_eq!(
			value(&p.autopan_depth(giving(5.0)).unwrap(), "autopanDepth"),
			Some(Value::Num(1.0))
		);
		assert_eq!(
			value(&p.pan_slide(giving(-5.0), None).unwrap(), "panSlideFrom"),
			Some(Value::Num(-1.0))
		);
		assert_eq!(value(&p.gain(giving(f64::NAN)).unwrap(), "gainLevel"), None);
		assert_eq!(
			value(&p.gain(giving(f64::INFINITY)).unwrap(), "gainLevel"),
			None
		);
		// A pattern of f64 converts and stays a signal.
		let signal = crate::signal::periodic::<f64>(crate::signal::Shape::Saw, false);
		let by_signal = note("c3 e3 g3 b3").unwrap().gain(signal).unwrap();
		let gains: Vec<f64> = first_cycle(&by_signal)
			.iter()
			.map(|h| h.value.get("gainLevel").and_then(Value::as_number).unwrap())
			.collect();
		assert_eq!(gains, [0.0, 0.25, 0.5, 0.75]);
	}

	#[test]
	fn pan_slide_sets_both_fields() {
		let p = note("c3").unwrap().pan_slide("-1", Some(0.25)).unwrap();
		let value = &first_cycle(&p)[0].value;
		assert_eq!(value.get("panSlideFrom"), Some(&Value::Num(-1.0)));
		assert_eq!(value.get("panSlideTime"), Some(&Value::Num(0.25)));
	}

	#[test]
	fn lists_and_paths_are_validated_and_built_like_the_reference() {
		let p = note("c3").unwrap();
		let value = |p: &Pattern<Value>, key: &str| first_cycle(p)[0].value.get(key).cloned();
		let list = |items: &[f64]| Value::List(items.iter().map(|v| Value::Num(*v)).collect());
		assert_eq!(
			value(
				&p.pitch_steps(&[0.0, 12.0], Some(100.0)).unwrap(),
				"pitchSteps"
			),
			Some(list(&[0.0, 12.0]))
		);
		assert_eq!(
			value(
				&p.pitch_steps(&[0.0], Some(100.0)).unwrap(),
				"pitchStepRate"
			),
			Some(Value::Num(100.0))
		);
		assert_eq!(
			value(&p.pitch_steps(&[0.0], None).unwrap(), "pitchStepRate"),
			None
		);
		assert_eq!(
			p.pitch_steps(&[], None).unwrap_err().message(),
			"pitchsteps() needs a non-empty array of finite semitone offsets"
		);
		assert_eq!(
			p.pitch_steps(&[1.0], Some(0.0)).unwrap_err().message(),
			"pitchsteps() rate must be positive, got 0"
		);
		// A stepped pan path: held frames add no points, a change makes a jump.
		let path = value(
			&p.pan_path(&[-1.0, -1.0, 1.0], Some(2.0)).unwrap(),
			"panPath",
		)
		.unwrap();
		let want = Value::List(alloc::vec![
			point_value(0.0, -1.0),
			point_value(1.0, -1.0),
			point_value(1.0, 1.0),
		]);
		assert_eq!(path, want);
		assert_eq!(
			p.pan_path(&[2.0], None).unwrap_err().message(),
			"panpath() needs pans between -1 and 1"
		);
		assert_eq!(
			p.pan_path_points(&[(0.5, 0.0), (0.25, 1.0)])
				.unwrap_err()
				.message(),
			"panpath() times must not go backwards, got 0.25 after 0.5"
		);
		assert_eq!(
			value(
				&p.pan_path_points(&[(0.0, -1.0), (1.0, 1.0)]).unwrap(),
				"panPath"
			),
			Some(Value::List(alloc::vec![
				point_value(0.0, -1.0),
				point_value(1.0, 1.0)
			]))
		);
		assert_eq!(
			p.channels(&[1.0; 9]).unwrap_err().message(),
			"channels() takes 1-8 gains, got 9"
		);
		assert_eq!(
			p.channels(&[-1.0]).unwrap_err().message(),
			"channels() gains must be finite and >= 0, got -1"
		);
		assert_eq!(
			p.surround(f64::NAN).unwrap_err().message(),
			"surround() angle must be a finite number, got NaN"
		);
		assert_eq!(
			p.fm_env("flat").unwrap_err().message(),
			"fmenv() must be 'lin' or 'exp', got \"flat\""
		);
		assert_eq!(
			p.fm_wave("white").unwrap_err().message(),
			"fmwave() must be one of sine, triangle, square, sawtooth, halfsine, abssine, pulsesine, got \"white\""
		);
		assert_eq!(
			p.autopan_shape("saw").unwrap_err().message(),
			"autopanshape() must be sine, triangle or square, got saw"
		);
	}

	#[test]
	fn surround_places_the_voice_on_the_ring() {
		let gains = surround_gains(0.0).unwrap();
		assert_eq!(gains, [0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
		let at_15 = surround_gains(15.0).unwrap();
		assert!((at_15[2] - at_15[1]).abs() < 1e-12 && at_15[2] > 0.7);
		assert!(surround_gains(180.0).unwrap()[6] > 0.0);
		assert_eq!(
			surround_gains(-180.0).unwrap(),
			surround_gains(180.0).unwrap()
		);
	}

	/// Recorded by running the reference's `surroundGains` with `bun`, to the digits JavaScript printed.
	#[test]
	fn surround_gains_match_the_reference() {
		use core::f64::consts::FRAC_1_SQRT_2;
		let recorded: [(f64, [f64; 8]); 11] = [
			(0.0, [0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
			(
				15.0,
				[
					0.0,
					0.7071067811865475,
					FRAC_1_SQRT_2,
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
				],
			),
			(
				45.0,
				[
					0.0,
					0.9238795325112867,
					0.0,
					0.0,
					0.0,
					0.3826834323650898,
					0.0,
					0.0,
				],
			),
			(
				100.0,
				[
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.9659258262890683,
					0.0,
					0.25881904510252074,
				],
			),
			(150.0, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
			(
				170.0,
				[
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.49999999999999994,
					0.8660254037844387,
				],
			),
			(
				180.0,
				[
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.7071067811865475,
					FRAC_1_SQRT_2,
				],
			),
			(
				-180.0,
				[
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.7071067811865475,
					FRAC_1_SQRT_2,
				],
			),
			(
				200.0,
				[
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
					0.9659258262890683,
					0.25881904510252074,
				],
			),
			(
				-400.0,
				[
					0.9659258262890683,
					0.0,
					0.0,
					0.0,
					0.25881904510252074,
					0.0,
					0.0,
					0.0,
				],
			),
			(
				359.5,
				[
					0.02617694830787336,
					0.0,
					0.9996573249755573,
					0.0,
					0.0,
					0.0,
					0.0,
					0.0,
				],
			),
		];
		for (angle, want) in recorded {
			let got = surround_gains(angle).unwrap();
			for (g, w) in got.iter().zip(want) {
				assert!(
					(g - w).abs() <= 1e-14,
					"angle {angle}: {got:?} against {want:?}"
				);
			}
		}
	}

	#[test]
	fn sound_and_s_clear_each_other() {
		let p = note("c3").unwrap().s("bd");
		let value = &first_cycle(&p)[0].value;
		assert_eq!(value.get("sampleName"), Some(&Value::Str("bd".into())));
		assert_eq!(value.get("soundType"), None);
		assert_eq!(value.get_raw("soundType"), Some(&Value::Undefined));
		let back = p.sound("square");
		let value = &first_cycle(&back)[0].value;
		assert_eq!(value.get("sampleName"), None);
		assert_eq!(value.get("soundType"), Some(&Value::Str("square".into())));
		assert_eq!(
			first_cycle(&note("c3").unwrap().s("hh").bank("RolandTR909"))[0]
				.value
				.get("sampleBank"),
			Some(&Value::Str("RolandTR909".into()))
		);
	}

	#[test]
	fn a_scalar_control_through_the_dynamic_path() {
		let p = note("c3").unwrap();
		let orbit = p.control(Control::Orbit, 2.0).unwrap();
		assert_eq!(
			first_cycle(&orbit)[0].value.get("orbit"),
			Some(&Value::Num(2.0))
		);
		assert_eq!(
			p.control(Control::Cut, 1.5).unwrap_err().message(),
			"cut() must be a non-negative integer, got 1.5"
		);
		let lin = p.control(Control::FmEnv, "lin").unwrap();
		assert_eq!(
			first_cycle(&lin)[0].value.get("fmEnvCurve"),
			Some(&Value::Str("lin".into()))
		);
		assert_eq!(
			p.control(Control::Channels, 1.0).unwrap_err().message(),
			"channels() does not take this argument; call .channels() with its own argument type"
		);
	}

	#[test]
	fn every_method_the_table_names_exists() {
		// One call per hand-written method, so the table's Rust names are checked against the code. The
		// generated methods exist by construction.
		let p = note("c3").unwrap();
		let hand: [(&str, bool); 14] = [
			("pan_slide", p.pan_slide(0.0, None).is_ok()),
			("fm_env", p.fm_env("exp").is_ok()),
			("fm_wave", p.fm_wave("sine").is_ok()),
			("autopan_shape", p.autopan_shape("sine").is_ok()),
			("pitch_steps", p.pitch_steps(&[0.0], None).is_ok()),
			("cut", p.cut(0.0).is_ok()),
			("pan_path", p.pan_path(&[0.0], None).is_ok()),
			("pan_law", p.pan_law(-3.0).is_ok()),
			("orbit", p.orbit(0.0).is_ok()),
			("channels", p.channels(&[1.0]).is_ok()),
			("surround", p.surround(0.0).is_ok()),
			("sound", first_cycle(&p.sound("sine")).len() == 1),
			("s", first_cycle(&p.s("bd")).len() == 1),
			("bank", first_cycle(&p.bank("x")).len() == 1),
		];
		let mut listed: Vec<&str> = hand
			.iter()
			.map(|(name, ok)| {
				assert!(ok, "{name}");
				*name
			})
			.collect();
		listed.sort_unstable();
		let mut plain: Vec<&str> = CONTROLS
			.iter()
			.filter(|c| c.arg != ArgKind::Patternable)
			.map(|c| c.rust_name)
			.collect();
		plain.sort_unstable();
		assert_eq!(listed, plain);
	}
}
