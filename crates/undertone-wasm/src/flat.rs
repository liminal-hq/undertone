// Voices as flat numbers: the plain data the main module hands the render module, encoded and decoded
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The voice list the main module collects from a pattern (start times and control maps) crosses to the render module
//! as one `Float64Array` and one array of strings (section 13 of `docs/rust-migration/results/M6-BOUNDARY.md`), so no
//! pattern, no handle, and no JavaScript object has to cross, and the same data could go to a worklet with a transfer.
//! The render module includes this file too (`#[path]`), so both sides read one definition.
//!
//! The numbers are `[count, (start, value)...]`, a value being written in prefix form: `0, x` a number (bit for bit);
//! `1, i` the string at index `i`; `2, b` a boolean; `3` undefined; `4, n, items...` a list; `5, n, (key index,
//! value)...` a map. Strings are interned: each distinct text is held once.

use std::collections::BTreeMap;

use undertone::pattern::Value;

/// The encoded voices: the numbers and the strings they index.
#[derive(Debug, Default, PartialEq)]
pub struct Flat {
	/// `[count, (start, value)...]`.
	pub numbers: Vec<f64>,
	/// The strings, each once.
	pub strings: Vec<String>,
}

struct Writer<'a> {
	out: Flat,
	index: BTreeMap<&'a str, usize>,
}

impl<'a> Writer<'a> {
	fn string(&mut self, text: &'a str) -> f64 {
		let next = self.out.strings.len();
		let index = *self.index.entry(text).or_insert(next);
		if index == next {
			self.out.strings.push(text.to_owned());
		}
		index as f64
	}

	fn value(&mut self, value: &'a Value) {
		match value {
			Value::Num(number) => self.out.numbers.extend([0.0, *number]),
			Value::Str(text) => {
				let index = self.string(text);
				self.out.numbers.extend([1.0, index]);
			}
			Value::Bool(flag) => self.out.numbers.extend([2.0, f64::from(u8::from(*flag))]),
			Value::Undefined => self.out.numbers.push(3.0),
			Value::List(items) => {
				self.out.numbers.extend([4.0, items.len() as f64]);
				for item in items {
					self.value(item);
				}
			}
			Value::Map(fields) => {
				self.out.numbers.extend([5.0, fields.len() as f64]);
				for (key, field) in fields {
					let index = self.string(key);
					self.out.numbers.push(index);
					self.value(field);
				}
			}
		}
	}
}

/// Encodes voices: each a start time and its control map.
pub fn encode(voices: &[(f64, Value)]) -> Flat {
	let mut writer = Writer {
		out: Flat::default(),
		index: BTreeMap::new(),
	};
	writer.out.numbers.push(voices.len() as f64);
	for (start, value) in voices {
		writer.out.numbers.push(*start);
		writer.value(value);
	}
	writer.out
}

struct Reader<'a> {
	numbers: &'a [f64],
	strings: &'a [String],
	at: usize,
	depth: usize,
}

const BAD: &str = "the voices are not in the flat voice encoding";

/// How deep a decoded value may nest.
const MAX_DEPTH: usize = 64;

impl Reader<'_> {
	fn next(&mut self) -> Result<f64, String> {
		let number = *self.numbers.get(self.at).ok_or(BAD)?;
		self.at += 1;
		Ok(number)
	}

	fn count(&mut self) -> Result<usize, String> {
		let number = self.next()?;
		// Every item takes at least one number, so a count above what is left is malformed (and never allocates).
		if number >= 0.0 && number.fract() == 0.0 && number <= (self.numbers.len() - self.at) as f64
		{
			Ok(number as usize)
		} else {
			Err(BAD.into())
		}
	}

	fn string(&mut self) -> Result<String, String> {
		let index = self.next()?;
		if index >= 0.0
			&& index.fract() == 0.0
			&& let Some(text) = self.strings.get(index as usize)
		{
			return Ok(text.clone());
		}
		Err(BAD.into())
	}

	fn value(&mut self) -> Result<Value, String> {
		if self.depth >= MAX_DEPTH {
			return Err(BAD.into());
		}
		self.depth += 1;
		let value = match self.next()? as u8 {
			0 => Value::Num(self.next()?),
			1 => Value::Str(self.string()?),
			2 => Value::Bool(self.next()? != 0.0),
			3 => Value::Undefined,
			4 => {
				let count = self.count()?;
				let mut items = Vec::with_capacity(count);
				for _ in 0..count {
					items.push(self.value()?);
				}
				Value::List(items)
			}
			5 => {
				let count = self.count()?;
				let mut fields = BTreeMap::new();
				for _ in 0..count {
					let key = self.string()?;
					fields.insert(key, self.value()?);
				}
				Value::Map(fields)
			}
			_ => return Err(BAD.into()),
		};
		self.depth -= 1;
		Ok(value)
	}
}

/// Decodes voices encoded by [`encode`]; a malformed list is an error, never a panic or an unbounded allocation.
pub fn decode(numbers: &[f64], strings: &[String]) -> Result<Vec<(f64, Value)>, String> {
	let mut reader = Reader {
		numbers,
		strings,
		at: 0,
		depth: 0,
	};
	let count = reader.count()?;
	let mut voices = Vec::with_capacity(count);
	for _ in 0..count {
		let start = reader.next()?;
		voices.push((start, reader.value()?));
	}
	if reader.at != numbers.len() {
		return Err(BAD.into());
	}
	Ok(voices)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn voices_round_trip_bit_for_bit_with_strings_once() {
		let mut map = BTreeMap::new();
		map.insert("note".to_string(), Value::Str("c4".into()));
		map.insert("gain".to_string(), Value::Num(-0.0));
		map.insert(
			"pan".to_string(),
			Value::List(vec![
				Value::Num(f64::NAN),
				Value::Undefined,
				Value::Bool(true),
			]),
		);
		map.insert("s".to_string(), Value::Str("c4".into()));
		let voices = vec![(0.5, Value::Map(map)), (1.0, Value::Str("note".into()))];
		let flat = encode(&voices);
		assert_eq!(flat.strings, ["gain", "note", "c4", "pan", "s"]);
		let back = decode(&flat.numbers, &flat.strings).unwrap();
		assert_eq!(back.len(), 2);
		let Value::Map(fields) = &back[0].1 else {
			panic!()
		};
		assert!(fields["gain"].as_number().unwrap().is_sign_negative());
		assert_eq!(fields["note"], Value::Str("c4".into()));
		assert_eq!(back[1], (1.0, Value::Str("note".into())));
	}

	#[test]
	fn malformed_numbers_are_errors() {
		let strings = vec!["a".to_string()];
		for numbers in [
			&[][..],
			&[1.0][..],
			&[1.0, 0.0, 9.0][..],
			&[1.0, 0.0, 1.0, 5.0][..],
			&[1.0e12, 0.0, 3.0][..],
			&[1.0, 0.0, 4.0, 1.0e12][..],
			&[0.0, 3.0][..],
		] {
			assert!(decode(numbers, &strings).is_err(), "{numbers:?}");
		}
		let deep: Vec<f64> = [1.0, 0.0]
			.into_iter()
			.chain(std::iter::repeat_n([4.0, 1.0], 100).flatten())
			.chain([3.0])
			.collect();
		assert!(decode(&deep, &strings).is_err());
	}
}
