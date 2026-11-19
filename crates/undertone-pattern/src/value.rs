// The dynamic hap value and the named maps a tree applies to values without closures
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Value`], the [`Datum`] trait, and [`MapFn`].
//!
//! A pattern's value type is generic, so the node tree can hold numbers, booleans, or the voice-parameter maps of `note(...)`. Operations that change a value (`fmap` with a named map, `range`, `scale`, a control merge) are data, [`MapFn`], and each value type says how to apply one through [`Datum::apply`]. That is what lets the tree stay free of closures.

use crate::chord::VoicingOptions;
use crate::drift::DriftOptions;
use crate::error::Result;
use crate::hap::Span;
use crate::{js, math};
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

/// The dynamic value of a hap: a number, a string, a boolean, or a map of named fields (the reference's `ControlPatch`).
///
/// Maps keep their keys sorted, as the corpus does, and a field the reference sets to `undefined` is simply absent.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
	/// A JavaScript number.
	Num(f64),
	/// A string, such as a mini-notation word.
	Str(String),
	/// A boolean.
	Bool(bool),
	/// Named fields, such as `{ pitch, gainLevel }`.
	Map(BTreeMap<String, Value>),
	/// A list, such as the semitone offsets of `pitchsteps` or the points of `panpath`.
	List(Vec<Value>),
	/// A field the reference set to `undefined` on purpose, which is not the same as a field it never set: `{ ...defaults, ...patch }` overwrites a default with it. `.s("bd")` leaves `soundType` this way so that a sample voice has no synth type.
	///
	/// A map holds it as a field; [`Value::get`] hides it (reading it is `undefined`, as in JavaScript), and [`Value::get_raw`] shows it. The corpus never records it, because `JSON.stringify` drops such fields.
	Undefined,
}

impl Value {
	/// A map value with one field.
	///
	/// ```
	/// use undertone_pattern::Value;
	/// let v = Value::field("pitch", Value::Str("c4".into()));
	/// assert_eq!(v.get("pitch"), Some(&Value::Str("c4".into())));
	/// ```
	pub fn field(key: &str, value: Value) -> Value {
		let mut map = BTreeMap::new();
		map.insert(key.into(), value);
		Value::Map(map)
	}

	/// The number this value holds, if it is one.
	pub fn as_number(&self) -> Option<f64> {
		match self {
			Value::Num(n) => Some(*n),
			_ => None,
		}
	}

	/// The field `key` of a map value; a field set to [`Value::Undefined`] reads as absent, as `undefined` does in JavaScript.
	pub fn get(&self, key: &str) -> Option<&Value> {
		match self.get_raw(key) {
			Some(Value::Undefined) => None,
			other => other,
		}
	}

	/// The field `key` of a map value, including a field deliberately set to [`Value::Undefined`] (which tells "set to `undefined`" from "never set").
	pub fn get_raw(&self, key: &str) -> Option<&Value> {
		match self {
			Value::Map(map) => map.get(key),
			_ => None,
		}
	}
}

/// A scale as the reference parses it: a root MIDI note and its semitone offsets.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ParsedScale {
	/// The root as a MIDI note number.
	pub root_midi: f64,
	/// The semitone offsets from the root, ascending, starting at 0.
	pub intervals: &'static [i32],
}

impl ParsedScale {
	/// Resolves a scale degree (0-based, negative or beyond the scale's length allowed) to a MIDI note number, carrying the octave.
	///
	/// ```
	/// use undertone_pattern::ParsedScale;
	/// let c_major = ParsedScale { root_midi: 60.0, intervals: &[0, 2, 4, 5, 7, 9, 11] };
	/// assert_eq!(c_major.degree_to_midi(0.0), 60.0);
	/// assert_eq!(c_major.degree_to_midi(7.0), 72.0);
	/// assert_eq!(c_major.degree_to_midi(-1.0), 59.0);
	/// ```
	pub fn degree_to_midi(&self, degree: f64) -> f64 {
		let len = self.intervals.len() as f64;
		let octave_shift = math::floor(degree / len);
		let index = ((degree % len) + len) % len;
		self.root_midi + octave_shift * 12.0 + f64::from(self.intervals[index as usize])
	}
}

/// A pure change to a hap value, by name: what `fmap`, `range`, `scale`, and the voice-patch methods apply, in place of a closure.
#[derive(Clone, Debug, PartialEq)]
pub enum MapFn {
	/// `v + n`.
	Add(f64),
	/// `v - n`.
	Sub(f64),
	/// `v * n`.
	Mul(f64),
	/// `v / n`.
	Div(f64),
	/// `-v`.
	Neg,
	/// `Math.abs(v)`.
	Abs,
	/// `Math.round(v)`.
	Round,
	/// `Math.floor(v)`.
	Floor,
	/// `range(lo, hi)`: `lo + v * (hi - lo)`.
	Range {
		/// The value for an input of 0.
		lo: f64,
		/// The value for an input of 1.
		hi: f64,
	},
	/// `range2(lo, hi)`: `lo + ((v + 1) / 2) * (hi - lo)`.
	Range2 {
		/// The value for an input of -1.
		lo: f64,
		/// The value for an input of 1.
		hi: f64,
	},
	/// `rangex(lo, hi)`: `lo * (hi / lo) ** v`.
	Rangex {
		/// The value for an input of 0.
		lo: f64,
		/// The ratio `hi / lo`, computed once when the pattern is built.
		ratio: f64,
	},
	/// `scale(spec)` on a voice map: a `degree` field becomes a `pitch` in Hz.
	Scale(ParsedScale),
	/// A voice patch merged into a map: `Some` sets a field, `None` sets it to [`Value::Undefined`] (the reference's `undefined`, which overwrites a default when the voice is resolved).
	Merge(Vec<(String, Option<Value>)>),
	/// `voicing(options)`: a hap with a `chord` becomes one hap per tone of the chord, sharing its whole and part. This is the one named map that changes the number of haps, so the query handles it (see [`Datum::voice`]); and it can fail when queried.
	Voicing(VoicingOptions),
	/// `drift(pattern, options)`: seeded variation of each hap that has a whole. It reads the hap's time, so the query handles it (see [`Datum::drifted`]); and it can fail when queried. Validated when the pattern is built.
	Drift(DriftOptions),
}

impl MapFn {
	/// The result of this map on a number, for the numeric variants.
	pub fn apply_number(&self, v: f64) -> Option<f64> {
		Some(match self {
			MapFn::Add(n) => v + n,
			MapFn::Sub(n) => v - n,
			MapFn::Mul(n) => v * n,
			MapFn::Div(n) => v / n,
			MapFn::Neg => -v,
			MapFn::Abs => v.abs(),
			MapFn::Round => js::round(v),
			MapFn::Floor => math::floor(v),
			MapFn::Range { lo, hi } => lo + v * (hi - lo),
			MapFn::Range2 { lo, hi } => lo + ((v + 1.0) / 2.0) * (hi - lo),
			MapFn::Rangex { lo, ratio } => lo * js::pow(*ratio, v),
			MapFn::Scale(_) | MapFn::Merge(_) | MapFn::Voicing(_) | MapFn::Drift(_) => return None,
		})
	}

	/// Whether querying a pattern with this map can fail: `voicing` reads its anchor and `drift` reads pitches only when queried.
	pub fn can_fail(&self) -> bool {
		matches!(self, MapFn::Voicing(_) | MapFn::Drift(_))
	}
}

/// A type a pattern's haps can hold: what the tree needs in order to lift numbers into it, read numbers back, and apply a [`MapFn`].
///
/// [`Value`] is the dynamic type the corpus uses. `f64` is the type of numeric signals, and `bool` is the type of the structure patterns inside `segment` and a signal's `euclid`.
pub trait Datum: Clone + core::fmt::Debug + PartialEq + Send + Sync + 'static {
	/// A value holding the number `n`.
	fn from_number(n: f64) -> Self;
	/// The number this value holds, if it is one.
	fn as_number(&self) -> Option<f64>;
	/// This value with `f` applied.
	fn apply(&self, f: &MapFn) -> Self;
	/// A value holding the scale degree `degree` (what `n(pattern)` makes of each number).
	fn from_degree(degree: f64) -> Self;
	/// This value with the numeric control `key` set to `n`.
	fn with_number(&self, key: &str, n: f64) -> Self;
	/// The values this value voices into for [`MapFn::Voicing`]: a chord becomes one value per tone, anything else itself. The default is the value itself, which is right for types that never hold a chord.
	fn voice(&self, _options: &VoicingOptions) -> Result<Vec<Self>> {
		Ok(alloc::vec![self.clone()])
	}
	/// This value after [`MapFn::Drift`], given the whole of its hap. The default is the value itself.
	fn drifted(&self, _options: &DriftOptions, _whole: Span) -> Result<Self> {
		Ok(self.clone())
	}
}

impl Datum for f64 {
	fn from_number(n: f64) -> Self {
		n
	}
	fn as_number(&self) -> Option<f64> {
		Some(*self)
	}
	fn apply(&self, f: &MapFn) -> Self {
		f.apply_number(*self).unwrap_or(*self)
	}
	fn from_degree(degree: f64) -> Self {
		degree
	}
	fn with_number(&self, _key: &str, _n: f64) -> Self {
		*self
	}
}

impl Datum for bool {
	fn from_number(n: f64) -> Self {
		n != 0.0
	}
	fn as_number(&self) -> Option<f64> {
		None
	}
	fn apply(&self, _f: &MapFn) -> Self {
		*self
	}
	fn from_degree(degree: f64) -> Self {
		degree != 0.0
	}
	fn with_number(&self, _key: &str, _n: f64) -> Self {
		*self
	}
}

impl Datum for Value {
	fn from_number(n: f64) -> Self {
		Value::Num(n)
	}
	fn as_number(&self) -> Option<f64> {
		match self {
			Value::Num(n) => Some(*n),
			_ => None,
		}
	}
	fn apply(&self, f: &MapFn) -> Self {
		match f {
			MapFn::Scale(scale) => match self {
				Value::Map(map) => match map.get("degree") {
					Some(Value::Num(degree)) => {
						let mut rest = map.clone();
						rest.remove("degree");
						let midi = scale.degree_to_midi(*degree);
						let hz = crate::pitch::midi_to_frequency(midi);
						rest.insert("pitch".into(), Value::Num(hz));
						Value::Map(rest)
					}
					_ => self.clone(),
				},
				_ => self.clone(),
			},
			// These change a hap, not a bare value (the query does the work), so a point sample passes through.
			MapFn::Voicing(_) | MapFn::Drift(_) => self.clone(),
			MapFn::Merge(patch) => match self {
				Value::Map(map) => {
					let mut merged = map.clone();
					for (key, value) in patch {
						merged.insert(key.clone(), value.clone().unwrap_or(Value::Undefined));
					}
					Value::Map(merged)
				}
				_ => self.clone(),
			},
			numeric => match self {
				Value::Num(n) => Value::Num(numeric.apply_number(*n).unwrap_or(*n)),
				_ => Value::Num(f64::NAN),
			},
		}
	}
	fn voice(&self, options: &VoicingOptions) -> Result<Vec<Self>> {
		crate::chord::voice_value(self, options)
	}
	fn drifted(&self, options: &DriftOptions, whole: Span) -> Result<Self> {
		crate::drift::drift_value(options, whole, self)
	}
	fn from_degree(degree: f64) -> Self {
		Value::field("degree", Value::Num(degree))
	}
	fn with_number(&self, key: &str, n: f64) -> Self {
		let mut map = match self {
			Value::Map(map) => map.clone(),
			_ => BTreeMap::new(),
		};
		map.insert(key.into(), Value::Num(n));
		Value::Map(map)
	}
}
