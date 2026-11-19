// The mini-notation parser: rhythm strings like "c3 [e3 g3]*2 <a3 b3> x(3,8)" into pattern trees
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The mini-notation parser, [`parse`].
//!
//! Supported notation: whitespace sequences, `~` rests, `[a b]` subdivision, `<a b>` per-cycle alternation, `a*2` and `a/2` speed, `a!3` replication, `a@3` elongation, `[a,b]` parallel stacking, and `a(3,8,rot)` euclidean rhythms.
//!
//! The parser takes the **leaf rule**: what each word becomes. It is called once per word while parsing and is not stored, so the tree it builds holds plain values. Errors carry the reference's message, with the position counted in UTF-16 code units as JavaScript counts it.

use crate::error::{Error, Result};
use crate::js;
use crate::pattern::{Pattern, cat, pure, silence, stack, timecat};
use crate::value::Datum;
use alloc::string::String;
use alloc::vec::Vec;

#[derive(Clone)]
struct Token {
	symbol: bool,
	text: String,
	pos: usize,
}

struct Term<T> {
	pattern: Pattern<T>,
	weight: f64,
	replicate: usize,
}

fn is_symbol(unit: u16) -> bool {
	matches!(
		unit,
		0x5b | 0x5d | 0x3c | 0x3e | 0x28 | 0x29 | 0x2c | 0x2a | 0x2f | 0x21 | 0x40 | 0x7e
	)
}

/// `[a-zA-Z0-9#._-]`
fn is_word_char(unit: u16) -> bool {
	matches!(unit, 0x61..=0x7a | 0x41..=0x5a | 0x30..=0x39 | 0x23 | 0x2e | 0x5f | 0x2d)
}

fn error_at(source: &str, position: usize, message: &str) -> Error {
	Error::new(alloc::format!(
		"Mini-notation error at position {position} in \"{source}\": {message}"
	))
}

fn tokenize(source: &str) -> Result<Vec<Token>> {
	let units = js::utf16_units(source);
	let mut tokens = Vec::new();
	let mut pos = 0;
	while pos < units.len() {
		let unit = units[pos];
		if js::is_whitespace(unit) {
			pos += 1;
		} else if is_symbol(unit) {
			tokens.push(Token {
				symbol: true,
				text: String::from_utf16_lossy(&units[pos..=pos]),
				pos,
			});
			pos += 1;
		} else if is_word_char(unit) {
			let start = pos;
			while pos < units.len() && is_word_char(units[pos]) {
				pos += 1;
			}
			tokens.push(Token {
				symbol: false,
				text: String::from_utf16_lossy(&units[start..pos]),
				pos: start,
			});
		} else {
			let shown = String::from_utf16_lossy(&units[pos..=pos]);
			return Err(error_at(
				source,
				pos,
				&alloc::format!("unexpected \"{shown}\""),
			));
		}
	}
	Ok(tokens)
}

struct Parser<'a, T, L> {
	tokens: Vec<Token>,
	index: usize,
	source: &'a str,
	leaf: L,
	_marker: core::marker::PhantomData<T>,
}

impl<T: Datum, L: Fn(&str) -> core::result::Result<T, String>> Parser<'_, T, L> {
	fn fail(&self, message: &str, pos: Option<usize>) -> Error {
		let at = pos
			.or_else(|| self.tokens.get(self.index).map(|t| t.pos))
			.unwrap_or_else(|| js::utf16_len(self.source));
		error_at(self.source, at, message)
	}

	fn peek(&self) -> Option<&Token> {
		self.tokens.get(self.index)
	}

	fn next(&mut self) -> Result<Token> {
		match self.tokens.get(self.index).cloned() {
			Some(token) => {
				self.index += 1;
				Ok(token)
			}
			None => Err(self.fail("unexpected end of pattern", None)),
		}
	}

	fn peek_symbol(&self, text: &str) -> bool {
		self.peek().is_some_and(|t| t.symbol && t.text == text)
	}

	fn expect_symbol(&mut self, text: &str) -> Result<()> {
		let token = self.next()?;
		if !token.symbol || token.text != text {
			return Err(self.fail(
				&alloc::format!("expected \"{text}\" but found \"{}\"", token.text),
				Some(token.pos),
			));
		}
		Ok(())
	}

	fn expect_end(&self) -> Result<()> {
		match self.peek() {
			Some(token) => Err(self.fail(
				&alloc::format!("unexpected \"{}\"", token.text),
				Some(token.pos),
			)),
			None => Ok(()),
		}
	}

	/// A comma-separated list of sequences played simultaneously (chords and layers).
	fn parse_stack(&mut self, closer: Option<&str>) -> Result<Pattern<T>> {
		let mut sequences = alloc::vec![self.parse_sequence(closer)?];
		while self.peek_symbol(",") {
			self.next()?;
			sequences.push(self.parse_sequence(closer)?);
		}
		Ok(if sequences.len() == 1 {
			sequences.remove(0)
		} else {
			stack(sequences)
		})
	}

	fn at_sequence_end(&self, closer: Option<&str>) -> bool {
		match self.peek() {
			None => true,
			Some(token) => {
				token.symbol && (token.text == "," || Some(token.text.as_str()) == closer)
			}
		}
	}

	fn parse_sequence(&mut self, closer: Option<&str>) -> Result<Pattern<T>> {
		let mut terms = Vec::new();
		while !self.at_sequence_end(closer) {
			terms.push(self.parse_term()?);
		}
		if terms.is_empty() {
			return Err(self.fail("expected at least one element", None));
		}
		let mut expanded: Vec<(f64, Pattern<T>)> = Vec::new();
		for term in terms {
			for _ in 0..term.replicate {
				expanded.push((term.weight, term.pattern.clone()));
			}
		}
		if expanded.len() == 1 {
			return Ok(expanded.remove(0).1);
		}
		timecat(expanded)
	}

	/// Runs a combinator, rewrapping its error with the modifier's source position.
	fn guarded(&self, pos: usize, result: Result<Pattern<T>>) -> Result<Pattern<T>> {
		result.map_err(|e| self.fail(e.message(), Some(pos)))
	}

	fn parse_term(&mut self) -> Result<Term<T>> {
		let mut pattern = self.parse_atom()?;
		let mut weight = 1.0;
		let mut replicate = 1;
		loop {
			if self.peek_symbol("*") {
				let symbol = self.next()?;
				let factor = self.parse_number("*", false)?;
				pattern = self.guarded(symbol.pos, pattern.fast(factor))?;
			} else if self.peek_symbol("/") {
				let symbol = self.next()?;
				let factor = self.parse_number("/", false)?;
				pattern = self.guarded(symbol.pos, pattern.slow(factor))?;
			} else if self.peek_symbol("!") {
				self.next()?;
				let count = self.parse_number("!", true)?;
				if count < 1.0 {
					return Err(self.fail("\"!\" count must be at least 1", None));
				}
				replicate = count as usize;
			} else if self.peek_symbol("@") {
				self.next()?;
				weight = self.parse_number("@", false)?;
				if weight <= 0.0 {
					return Err(self.fail("\"@\" weight must be positive", None));
				}
			} else if self.peek_symbol("(") {
				let symbol = self.next()?;
				let pulses = self.parse_number("euclid pulses", true)?;
				self.expect_symbol(",")?;
				let steps = self.parse_number("euclid steps", true)?;
				let mut rotation = 0.0;
				if self.peek_symbol(",") {
					self.next()?;
					rotation = self.parse_number("euclid rotation", true)?;
				}
				self.expect_symbol(")")?;
				pattern = self.guarded(symbol.pos, pattern.euclid(pulses, steps, rotation))?;
			} else {
				return Ok(Term {
					pattern,
					weight,
					replicate,
				});
			}
		}
	}

	fn parse_atom(&mut self) -> Result<Pattern<T>> {
		let token = self.next()?;
		if !token.symbol {
			return match (self.leaf)(&token.text) {
				Ok(value) => Ok(pure(value)),
				Err(message) => Err(self.fail(&message, Some(token.pos))),
			};
		}
		match token.text.as_str() {
			"~" => Ok(silence()),
			"[" => {
				let inner = self.parse_stack(Some("]"))?;
				self.expect_symbol("]")?;
				Ok(inner)
			}
			"<" => {
				let inner = self.parse_alternation()?;
				self.expect_symbol(">")?;
				Ok(inner)
			}
			other => Err(self.fail(&alloc::format!("unexpected \"{other}\""), Some(token.pos))),
		}
	}

	/// The children of `<...>`: one per cycle, in rotation.
	fn parse_alternation(&mut self) -> Result<Pattern<T>> {
		let mut terms = Vec::new();
		while !self.peek_symbol(">") && self.peek().is_some() {
			let term = self.parse_term()?;
			if term.weight != 1.0 {
				return Err(self.fail("\"@\" weights are not supported inside <>", None));
			}
			terms.push(term);
		}
		if terms.is_empty() {
			return Err(self.fail("expected at least one element inside <>", None));
		}
		let mut expanded = Vec::new();
		for term in terms {
			for _ in 0..term.replicate {
				expanded.push(term.pattern.clone());
			}
		}
		Ok(cat(expanded))
	}

	fn parse_number(&mut self, context: &str, integer: bool) -> Result<f64> {
		let token = self.next()?;
		// Strict decimal syntax only: Number() alone would accept "0x10" or "1e3".
		let value = if !token.symbol && is_plain_decimal(&token.text) {
			js::string_to_number(&token.text)
		} else {
			f64::NAN
		};
		if !value.is_finite() {
			return Err(self.fail(
				&alloc::format!(
					"expected a number after \"{context}\" but found \"{}\"",
					token.text
				),
				Some(token.pos),
			));
		}
		if integer && !js::is_integer(value) {
			return Err(self.fail(
				&alloc::format!(
					"expected an integer for \"{context}\" but found \"{}\"",
					token.text
				),
				Some(token.pos),
			));
		}
		Ok(value)
	}
}

/// `^-?\d+(\.\d+)?$`
fn is_plain_decimal(text: &str) -> bool {
	let body = text.strip_prefix('-').unwrap_or(text);
	let (int, frac) = match body.split_once('.') {
		Some((int, frac)) => (int, Some(frac)),
		None => (body, None),
	};
	let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
	digits(int) && frac.is_none_or(digits)
}

/// Parses a mini-notation string into a [`Pattern`], turning each word into a value with `leaf`.
///
/// `leaf` returns the error message for a word it rejects; the parser wraps it with the word's position in the source, as the reference does. The leaf is called while parsing and is not kept, so the pattern holds only values.
///
/// ```
/// use undertone_pattern::{mini, Fraction, Span, Value};
/// let p = mini::parse("a [b c]", |word| Ok(Value::Str(word.into()))).unwrap();
/// let haps = p.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
/// assert_eq!(haps.len(), 3);
/// assert_eq!(haps[2].whole.unwrap().begin, Fraction::new(3, 4));
///
/// let err = mini::parse("a b(9,8)", |word| Ok(Value::Str(word.into()))).unwrap_err();
/// assert_eq!(
///     err.message(),
///     "Mini-notation error at position 3 in \"a b(9,8)\": Euclidean pulses must be between 0 and steps, got (9,8)"
/// );
/// ```
pub fn parse<T: Datum>(
	source: &str,
	leaf: impl Fn(&str) -> core::result::Result<T, String>,
) -> Result<Pattern<T>> {
	let tokens = tokenize(source)?;
	if tokens.is_empty() {
		return Err(Error::new(alloc::format!(
			"Empty mini-notation pattern: \"{source}\""
		)));
	}
	let mut parser = Parser {
		tokens,
		index: 0,
		source,
		leaf,
		_marker: core::marker::PhantomData,
	};
	let pattern = parser.parse_stack(None)?;
	parser.expect_end()?;
	Ok(pattern)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Fraction, Span, Value};

	fn words(source: &str) -> Result<Pattern<Value>> {
		parse(source, |word| Ok(Value::Str(word.into())))
	}

	fn texts(p: &Pattern<Value>, a: i128, b: i128) -> Vec<String> {
		p.query(Span::new(Fraction::from_int(a), Fraction::from_int(b)))
			.into_iter()
			.map(|h| match h.value {
				Value::Str(s) => alloc::format!("{s}@{}", h.part.begin),
				_ => String::new(),
			})
			.collect()
	}

	#[test]
	fn reads_the_whole_grammar() {
		assert_eq!(texts(&words("a ~ b").unwrap(), 0, 1), ["a@0", "b@2/3"]);
		assert_eq!(
			texts(&words("a!2 b").unwrap(), 0, 1),
			["a@0", "a@1/3", "b@2/3"]
		);
		assert_eq!(texts(&words("a@3 b").unwrap(), 0, 1), ["a@0", "b@3/4"]);
		assert_eq!(texts(&words("<a b>").unwrap(), 0, 2), ["a@0", "b@1"]);
		assert_eq!(texts(&words("a*2").unwrap(), 0, 1), ["a@0", "a@1/2"]);
		assert_eq!(
			texts(&words("a(3,8)").unwrap().fast(1.0).unwrap(), 0, 1).len(),
			3
		);
	}

	#[test]
	fn reports_errors_with_utf16_positions() {
		assert_eq!(
			words("a $").unwrap_err().message(),
			"Mini-notation error at position 2 in \"a $\": unexpected \"$\""
		);
		assert_eq!(
			words("a \u{1f3b5} b").unwrap_err().message(),
			"Mini-notation error at position 2 in \"a \u{1f3b5} b\": unexpected \"\u{fffd}\""
		);
		assert!(
			words("\u{1f3b5}")
				.unwrap_err()
				.message()
				.contains("position 0")
		);
		assert_eq!(
			words("[a b").unwrap_err().message(),
			"Mini-notation error at position 4 in \"[a b\": unexpected end of pattern"
		);
		assert_eq!(
			words("   ").unwrap_err().message(),
			"Empty mini-notation pattern: \"   \""
		);
		assert_eq!(
			words("a*x").unwrap_err().message(),
			"Mini-notation error at position 2 in \"a*x\": expected a number after \"*\" but found \"x\""
		);
		assert_eq!(
			words("a*0").unwrap_err().message(),
			"Mini-notation error at position 1 in \"a*0\": fast() factor must be positive, got 0"
		);
	}

	#[test]
	fn a_leaf_error_is_wrapped_with_the_words_position() {
		let err = parse::<Value>("a bad", |w| {
			if w == "bad" {
				Err("nope".into())
			} else {
				Ok(Value::Str(w.into()))
			}
		})
		.unwrap_err();
		assert_eq!(
			err.message(),
			"Mini-notation error at position 2 in \"a bad\": nope"
		);
	}
}
