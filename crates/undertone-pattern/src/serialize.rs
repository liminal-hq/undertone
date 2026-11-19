// A compact text form of a pattern tree, to rebuild it on another thread
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Serialising a pattern tree and rebuilding it elsewhere.
//!
//! A tree of data nodes, signals, chords, `voicing`, and `drift` included, can be written as text with [`Pattern::serialize`] and rebuilt with [`Pattern::deserialize`]. The rebuilt tree queries exactly as the original does: the same haps in the same order, and the same `sample_at` values to the last bit. The point is the audio worklet (RF-29): the main thread builds the pattern, sends the text, and the worklet rebuilds the tree and queries it off the main thread. Nothing is shared between the two sides but a string.
//!
//! # What cannot cross
//!
//! Two nodes are not data and are **refused** with an [`Error`] that names them:
//!
//! - [`Node::Custom`], a [`Query`](crate::Query) written in Rust, which includes every closure given to [`Pattern::from_fn`] and [`Pattern::fmap_with`], and so also a `Pattern<f64>` handed to a control (it is mapped with a closure on the way in).
//! - [`Node::Foreign`], a callback that lives in the host, such as a JavaScript function behind the bridge (`signal(fn)` there). Its [`ForeignId`](crate::ForeignId) means something only to the host that registered it.
//!
//! A tree holding either one stays on the thread that built it. Everything else crosses: every signal, `seed`, `segment`, `range`, `range2`, `rangex`, `add`, `sub`, `mul`, `div`, `round`, `floor`, `fast`, `slow`, `rev`, `every` (the tree holds the transformed pattern it built, never the function), `cat`, `seq`, `timecat`, `stack`, `arrange`, `euclid`, `pure`, `n`, `scale`, `chord`, `voicing` (every option), `drift` (every option, a seed kept as UTF-16 units included), and every control with a number, a string, or a pattern of data nodes.
//!
//! # The format
//!
//! The text is deterministic: the same tree always gives the same string. It is a header, `ut1`, and then the tree in prefix order as tokens separated by single spaces. A number is Rust's shortest exact form with an exponent (`5e-1`, `NaN`, `inf`, `-0e0`), so every `f64` comes back with the same bits. A string is its length in bytes, a colon, and the bytes (`4:kick`), so it needs no escaping. A fraction is `n` or `n/d`. A typical signal pattern is short:
//!
//! ```
//! use undertone_pattern::signal::{periodic, Shape};
//! let lfo = periodic::<f64>(Shape::Sine, false).range(200.0, 2000.0).segment(4.0).unwrap();
//! assert_eq!(lfo.serialize().unwrap(), "ut1 sg 4 map range 2e2 2e3 sig per sine 1 n 0e0");
//! ```
//!
//! | Tag | Node | Fields |
//! | --- | --- | --- |
//! | `_` | silence | none |
//! | `p` | pure | a value |
//! | `st`, `ct` | stack, cat | a count, then the children |
//! | `cp` | compress | begin, end, child |
//! | `fa`, `sl` | fast, slow | a fraction, child |
//! | `rv` | rev | child |
//! | `ev` | every | `n`, the base, the transformed pattern |
//! | `ar` | arrange | a count, then a number of cycles and a child for each section |
//! | `wc` | a control | the control's name, `l` (literal) or `p` (pattern), the child, the source |
//! | `sig` | a signal | its kind, then its seed |
//! | `sa` | sample (a signal's `euclid`) | the source, the structure |
//! | `sg` | segment | a fraction, the source |
//! | `map` | a named map (`voicing` and `drift` too) | the map, the child |
//! | `ai` | arithmetic | `add`, `sub`, `mul` or `div`, the left, the right |
//! | `dg` | `n(pattern)` | child |
//!
//! A rebuilt tree is as fallible as the original: whether a query can fail ([`Pattern::can_fail`]) follows from the nodes, and [`Pattern::try_query`] returns the same haps or the same error on both sides.
//!
//! The text comes from a pattern the program built, so [`Pattern::deserialize`] checks what the tree needs to avoid a panic or a divide by zero (a factor above zero, a section of at least one cycle, a denominator that is not zero) and refuses anything it does not understand, but it is not a defence against hostile input: a tree can still be made large, or deep (the depth is limited to 128).

use crate::chord::{Anchor, VoicingOptions};
use crate::control;
use crate::controls::{Control, ControlSource};
use crate::drift::DriftOptions;
use crate::error::{Error, Result};
use crate::fraction::Fraction;
use crate::pattern::{ArithOp, Node, Pattern, pure};
use crate::random::Seed;
use crate::signal::{Shape, Signal, SignalKind};
use crate::value::{Datum, MapFn, ParsedScale, Value};
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

/// The format's header and version.
const HEADER: &str = "ut1";

/// The deepest tree [`Pattern::deserialize`] rebuilds.
const MAX_DEPTH: usize = 128;

/// The text being written: tokens added one by one, each after a single space.
pub struct Writer {
	out: String,
}

impl Writer {
	fn new() -> Writer {
		Writer { out: HEADER.into() }
	}

	/// A bare word.
	pub fn word(&mut self, word: &str) {
		self.out.push(' ');
		self.out.push_str(word);
	}

	/// A count or a whole number.
	pub fn int(&mut self, value: i128) {
		self.out.push(' ');
		push_display(&mut self.out, value);
	}

	/// A number, in the shortest form that parses back to the same bits.
	pub fn number(&mut self, value: f64) {
		self.out.push(' ');
		push_number(&mut self.out, value);
	}

	/// A fraction: `n` for a whole number, `n/d` otherwise.
	pub fn fraction(&mut self, value: Fraction) {
		self.out.push(' ');
		push_fraction(&mut self.out, value);
	}

	/// A string, as its length in bytes, a colon, and the bytes.
	pub fn text(&mut self, text: &str) {
		self.out.push(' ');
		push_text(&mut self.out, text);
	}
}

fn push_display(out: &mut String, value: impl core::fmt::Display) {
	use core::fmt::Write;
	// Writing to a `String` cannot fail.
	let _ = write!(out, "{value}");
}

fn push_number(out: &mut String, value: f64) {
	use core::fmt::Write;
	if value.is_finite() {
		let _ = write!(out, "{value:e}");
	} else if value.is_nan() {
		out.push_str("NaN");
	} else if value > 0.0 {
		out.push_str("inf");
	} else {
		out.push_str("-inf");
	}
}

fn push_fraction(out: &mut String, value: Fraction) {
	push_display(out, value.numerator());
	if value.denominator() != 1 {
		out.push('/');
		push_display(out, value.denominator());
	}
}

fn push_text(out: &mut String, text: &str) {
	push_display(out, text.len());
	out.push(':');
	out.push_str(text);
}

/// The text being read, with a position for error messages.
pub struct Reader<'a> {
	text: &'a str,
	pos: usize,
	depth: usize,
}

impl<'a> Reader<'a> {
	/// An error that says where in the text it happened.
	pub fn error(&self, what: impl core::fmt::Display) -> Error {
		Error::new(alloc::format!(
			"cannot rebuild the pattern: {what} at byte {}",
			self.pos
		))
	}

	/// Moves past the single space that starts a token.
	fn separator(&mut self) -> Result<()> {
		if self.pos >= self.text.len() {
			return Err(self.error("the text ends too soon"));
		}
		if self.text.as_bytes()[self.pos] != b' ' {
			return Err(self.error("expected a space"));
		}
		self.pos += 1;
		Ok(())
	}

	/// The next bare word.
	pub fn word(&mut self) -> Result<&'a str> {
		self.separator()?;
		let rest = &self.text[self.pos..];
		let end = rest.find(' ').unwrap_or(rest.len());
		if end == 0 {
			return Err(self.error("an empty token"));
		}
		self.pos += end;
		Ok(&rest[..end])
	}

	/// The next whole number.
	pub fn int(&mut self) -> Result<i128> {
		let word = self.word()?;
		word.parse()
			.map_err(|_| self.error(alloc::format!("`{word}` is not a whole number")))
	}

	/// The next count: a whole number that fits in memory.
	pub fn count(&mut self) -> Result<usize> {
		let n = self.int()?;
		usize::try_from(n)
			.ok()
			.filter(|n| *n <= self.text.len())
			.ok_or_else(|| self.error(alloc::format!("`{n}` is not a count")))
	}

	/// The next number.
	pub fn number(&mut self) -> Result<f64> {
		let word = self.word()?;
		word.parse()
			.map_err(|_| self.error(alloc::format!("`{word}` is not a number")))
	}

	/// The next fraction (`n` or `n/d`, the denominator above zero).
	pub fn fraction(&mut self) -> Result<Fraction> {
		let word = self.word()?;
		let (n, d) = word.split_once('/').unwrap_or((word, "1"));
		match (n.parse::<i128>(), d.parse::<i128>()) {
			(Ok(n), Ok(d)) if d > 0 => Ok(Fraction::new(n, d)),
			_ => Err(self.error(alloc::format!("`{word}` is not a fraction"))),
		}
	}

	/// A fraction above zero.
	fn positive(&mut self) -> Result<Fraction> {
		let value = self.fraction()?;
		if value.numerator() <= 0 {
			return Err(self.error("a factor must be above zero"));
		}
		Ok(value)
	}

	/// The next string.
	pub fn text(&mut self) -> Result<&'a str> {
		self.separator()?;
		let rest = &self.text[self.pos..];
		let colon = rest
			.find(':')
			.ok_or_else(|| self.error("a string has no length"))?;
		let len: usize = rest[..colon]
			.parse()
			.map_err(|_| self.error("a string has a bad length"))?;
		let start = colon + 1;
		let end = start.checked_add(len).filter(|e| *e <= rest.len());
		match end {
			Some(end) if rest.is_char_boundary(end) => {
				self.pos += end;
				Ok(&rest[start..end])
			}
			_ => Err(self.error("a string is cut short")),
		}
	}

	/// Enters a child, failing when the tree is too deep.
	fn descend(&mut self) -> Result<()> {
		self.depth += 1;
		if self.depth > MAX_DEPTH {
			return Err(self.error("the tree is too deep"));
		}
		Ok(())
	}
}

/// A value type that can be written to the text form and read back: [`f64`], [`bool`], and [`Value`].
pub trait Wire: Datum {
	/// Writes the value as tokens.
	fn write(&self, w: &mut Writer);
	/// Reads the value back.
	fn read(r: &mut Reader<'_>) -> Result<Self>;
}

impl Wire for f64 {
	fn write(&self, w: &mut Writer) {
		w.number(*self);
	}
	fn read(r: &mut Reader<'_>) -> Result<Self> {
		r.number()
	}
}

impl Wire for bool {
	fn write(&self, w: &mut Writer) {
		w.word(if *self { "1" } else { "0" });
	}
	fn read(r: &mut Reader<'_>) -> Result<Self> {
		match r.word()? {
			"1" => Ok(true),
			"0" => Ok(false),
			other => Err(r.error(alloc::format!("`{other}` is not a boolean"))),
		}
	}
}

impl Wire for Value {
	fn write(&self, w: &mut Writer) {
		match self {
			Value::Num(n) => {
				w.word("n");
				w.number(*n);
			}
			Value::Str(s) => {
				w.word("s");
				w.text(s);
			}
			Value::Bool(b) => {
				w.word(if *b { "t" } else { "f" });
			}
			Value::Map(map) => {
				w.word("m");
				w.int(map.len() as i128);
				for (key, value) in map {
					w.text(key);
					value.write(w);
				}
			}
			Value::List(items) => {
				w.word("l");
				w.int(items.len() as i128);
				for item in items {
					item.write(w);
				}
			}
			Value::Undefined => w.word("u"),
		}
	}

	fn read(r: &mut Reader<'_>) -> Result<Self> {
		r.descend()?;
		let value = match r.word()? {
			"n" => Value::Num(r.number()?),
			"s" => Value::Str(r.text()?.into()),
			"t" => Value::Bool(true),
			"f" => Value::Bool(false),
			"m" => {
				let count = r.count()?;
				let mut map = BTreeMap::new();
				for _ in 0..count {
					let key: String = r.text()?.into();
					map.insert(key, Value::read(r)?);
				}
				Value::Map(map)
			}
			"l" => {
				let count = r.count()?;
				let mut items = Vec::with_capacity(count);
				for _ in 0..count {
					items.push(Value::read(r)?);
				}
				Value::List(items)
			}
			"u" => Value::Undefined,
			other => return Err(r.error(alloc::format!("`{other}` is not a value"))),
		};
		r.depth -= 1;
		Ok(value)
	}
}

// ---------------------------------------------------------------------------------------------
// The small enums
// ---------------------------------------------------------------------------------------------

const SHAPES: [Shape; 6] = [
	Shape::Saw,
	Shape::Isaw,
	Shape::Sine,
	Shape::Cosine,
	Shape::Tri,
	Shape::Square,
];

fn write_seed(seed: &Seed, w: &mut Writer) {
	match seed {
		Seed::Num(n) => {
			w.word("n");
			w.number(*n);
		}
		Seed::Str(s) => {
			w.word("s");
			w.text(s);
		}
	}
}

fn read_seed(r: &mut Reader<'_>) -> Result<Seed> {
	match r.word()? {
		"n" => Ok(Seed::Num(r.number()?)),
		"s" => Ok(Seed::Str(r.text()?.into())),
		other => Err(r.error(alloc::format!("`{other}` is not a seed"))),
	}
}

fn write_kind<T: Wire>(kind: &SignalKind<T>, w: &mut Writer) {
	match kind {
		SignalKind::Periodic { shape, bipolar } => {
			w.word("per");
			w.word(shape.name());
			w.word(if *bipolar { "2" } else { "1" });
		}
		SignalKind::Rand => w.word("rand"),
		SignalKind::Rand2 => w.word("rand2"),
		SignalKind::Irand(n) => {
			w.word("irand");
			w.number(*n);
		}
		SignalKind::Choose(values) => {
			w.word("choose");
			w.int(values.len() as i128);
			for value in values {
				value.write(w);
			}
		}
		SignalKind::BrandBy(p) => {
			w.word("brand");
			w.number(*p);
		}
		SignalKind::Perlin => w.word("perlin"),
	}
}

fn read_kind<T: Wire>(r: &mut Reader<'_>) -> Result<SignalKind<T>> {
	Ok(match r.word()? {
		"per" => {
			let name = r.word()?;
			let shape = SHAPES
				.iter()
				.copied()
				.find(|s| s.name() == name)
				.ok_or_else(|| r.error(alloc::format!("`{name}` is not a shape")))?;
			let bipolar = match r.word()? {
				"1" => false,
				"2" => true,
				other => return Err(r.error(alloc::format!("`{other}` is not 1 or 2"))),
			};
			SignalKind::Periodic { shape, bipolar }
		}
		"rand" => SignalKind::Rand,
		"rand2" => SignalKind::Rand2,
		"irand" => SignalKind::Irand(r.number()?),
		"choose" => {
			let count = r.count()?;
			if count == 0 {
				return Err(r.error("a choice needs at least one value"));
			}
			let mut values = Vec::with_capacity(count);
			for _ in 0..count {
				values.push(T::read(r)?);
			}
			SignalKind::Choose(values)
		}
		"brand" => SignalKind::BrandBy(r.number()?),
		"perlin" => SignalKind::Perlin,
		other => return Err(r.error(alloc::format!("`{other}` is not a signal"))),
	})
}

fn write_map(f: &MapFn, w: &mut Writer) {
	match f {
		MapFn::Add(n) => {
			w.word("add");
			w.number(*n);
		}
		MapFn::Sub(n) => {
			w.word("sub");
			w.number(*n);
		}
		MapFn::Mul(n) => {
			w.word("mul");
			w.number(*n);
		}
		MapFn::Div(n) => {
			w.word("div");
			w.number(*n);
		}
		MapFn::Neg => w.word("neg"),
		MapFn::Abs => w.word("abs"),
		MapFn::Round => w.word("round"),
		MapFn::Floor => w.word("floor"),
		MapFn::Range { lo, hi } => {
			w.word("range");
			w.number(*lo);
			w.number(*hi);
		}
		MapFn::Range2 { lo, hi } => {
			w.word("range2");
			w.number(*lo);
			w.number(*hi);
		}
		MapFn::Rangex { lo, ratio } => {
			w.word("rangex");
			w.number(*lo);
			w.number(*ratio);
		}
		MapFn::Scale(scale) => {
			w.word("scale");
			w.number(scale.root_midi);
			w.int(scale.intervals.len() as i128);
			for interval in scale.intervals {
				w.int(i128::from(*interval));
			}
		}
		MapFn::Voicing(options) => {
			w.word("voicing");
			match &options.anchor {
				None => w.word("-"),
				Some(Anchor::Midi(midi)) => {
					w.word("m");
					w.number(*midi);
				}
				Some(Anchor::Name(name)) => {
					w.word("n");
					w.text(name);
				}
			}
		}
		MapFn::Drift(options) => {
			w.word("drift");
			write_seed(&options.seed, w);
			match &options.seed_utf16 {
				None => w.word("-"),
				Some(units) => {
					w.word("u");
					w.int(units.len() as i128);
					for unit in units {
						w.int(i128::from(*unit));
					}
				}
			}
			for n in [
				options.timing,
				options.level,
				options.cents,
				options.pan,
				options.push,
				options.cycles_per_pass,
			] {
				w.number(n);
			}
		}
		MapFn::Merge(fields) => {
			w.word("merge");
			w.int(fields.len() as i128);
			for (key, value) in fields {
				w.text(key);
				match value {
					Some(value) => {
						w.word("v");
						value.write(w);
					}
					None => w.word("x"),
				}
			}
		}
	}
}

fn read_map(r: &mut Reader<'_>) -> Result<MapFn> {
	Ok(match r.word()? {
		"add" => MapFn::Add(r.number()?),
		"sub" => MapFn::Sub(r.number()?),
		"mul" => MapFn::Mul(r.number()?),
		"div" => MapFn::Div(r.number()?),
		"neg" => MapFn::Neg,
		"abs" => MapFn::Abs,
		"round" => MapFn::Round,
		"floor" => MapFn::Floor,
		"range" => MapFn::Range {
			lo: r.number()?,
			hi: r.number()?,
		},
		"range2" => MapFn::Range2 {
			lo: r.number()?,
			hi: r.number()?,
		},
		"rangex" => MapFn::Rangex {
			lo: r.number()?,
			ratio: r.number()?,
		},
		"scale" => {
			let root_midi = r.number()?;
			let count = r.count()?;
			let mut intervals = Vec::with_capacity(count);
			for _ in 0..count {
				let n = r.int()?;
				intervals
					.push(i32::try_from(n).map_err(|_| r.error("a scale interval is too large"))?);
			}
			let intervals = control::scale_table(&intervals)
				.ok_or_else(|| r.error("a scale that is not in the scale table"))?;
			MapFn::Scale(ParsedScale {
				root_midi,
				intervals,
			})
		}
		"voicing" => MapFn::Voicing(VoicingOptions {
			anchor: match r.word()? {
				"-" => None,
				"m" => Some(Anchor::Midi(r.number()?)),
				"n" => Some(Anchor::Name(r.text()?.into())),
				other => return Err(r.error(alloc::format!("`{other}` is not an anchor"))),
			},
		}),
		"drift" => {
			let seed = read_seed(r)?;
			let seed_utf16 = match r.word()? {
				"-" => None,
				"u" => {
					let count = r.count()?;
					let mut units = Vec::with_capacity(count);
					for _ in 0..count {
						let n = r.int()?;
						units.push(
							u16::try_from(n).map_err(|_| r.error("a UTF-16 unit is too large"))?,
						);
					}
					Some(units)
				}
				other => return Err(r.error(alloc::format!("`{other}` is not - or u"))),
			};
			MapFn::Drift(DriftOptions {
				seed,
				seed_utf16,
				timing: r.number()?,
				level: r.number()?,
				cents: r.number()?,
				pan: r.number()?,
				push: r.number()?,
				cycles_per_pass: r.number()?,
			})
		}
		"merge" => {
			let count = r.count()?;
			let mut fields = Vec::with_capacity(count);
			for _ in 0..count {
				let key: String = r.text()?.into();
				let value = match r.word()? {
					"v" => Some(Value::read(r)?),
					"x" => None,
					other => {
						return Err(r.error(alloc::format!("`{other}` is not v or x")));
					}
				};
				fields.push((key, value));
			}
			MapFn::Merge(fields)
		}
		other => return Err(r.error(alloc::format!("`{other}` is not a map"))),
	})
}

fn read_op(r: &mut Reader<'_>) -> Result<ArithOp> {
	Ok(match r.word()? {
		"add" => ArithOp::Add,
		"sub" => ArithOp::Sub,
		"mul" => ArithOp::Mul,
		"div" => ArithOp::Div,
		other => return Err(r.error(alloc::format!("`{other}` is not an operation"))),
	})
}

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

fn write_children<T: Wire>(children: &[Pattern<T>], w: &mut Writer) -> Result<()> {
	w.int(children.len() as i128);
	for child in children {
		write_pattern(child, w)?;
	}
	Ok(())
}

fn write_pattern<T: Wire>(pattern: &Pattern<T>, w: &mut Writer) -> Result<()> {
	match pattern.node() {
		Node::Silence => w.word("_"),
		Node::Pure(value) => {
			w.word("p");
			value.write(w);
		}
		Node::Stack(children) => {
			w.word("st");
			write_children(children, w)?;
		}
		Node::Cat(children) => {
			w.word("ct");
			write_children(children, w)?;
		}
		Node::Compress { begin, end, child } => {
			w.word("cp");
			w.fraction(*begin);
			w.fraction(*end);
			write_pattern(child, w)?;
		}
		Node::Fast { factor, child } => {
			w.word("fa");
			w.fraction(*factor);
			write_pattern(child, w)?;
		}
		Node::Slow { factor, child } => {
			w.word("sl");
			w.fraction(*factor);
			write_pattern(child, w)?;
		}
		Node::Rev(child) => {
			w.word("rv");
			write_pattern(child, w)?;
		}
		Node::Every {
			n,
			base,
			transformed,
		} => {
			w.word("ev");
			w.int(*n);
			write_pattern(base, w)?;
			write_pattern(transformed, w)?;
		}
		Node::Arrange(sections) => {
			w.word("ar");
			w.int(sections.len() as i128);
			for (cycles, child) in sections {
				w.int(*cycles);
				write_pattern(child, w)?;
			}
		}
		Node::WithControl {
			child,
			control,
			input,
		} => {
			w.word("wc");
			w.word(control.name());
			let (kind, source) = match input {
				ControlSource::Literal(source) => ("l", source),
				ControlSource::Pattern(source) => ("p", source),
			};
			w.word(kind);
			write_pattern(child, w)?;
			write_pattern(source, w)?;
		}
		Node::Signal(signal) => {
			w.word("sig");
			write_kind(&signal.kind, w);
			write_seed(&signal.seed, w);
		}
		Node::Sample { source, structure } => {
			w.word("sa");
			write_pattern(source, w)?;
			write_pattern(structure, w)?;
		}
		Node::Segment { source, count, .. } => {
			w.word("sg");
			w.fraction(*count);
			write_pattern(source, w)?;
		}
		Node::Map { child, f } => {
			w.word("map");
			write_map(f, w);
			write_pattern(child, w)?;
		}
		Node::Arith { left, op, right } => {
			w.word("ai");
			w.word(op.name());
			write_pattern(left, w)?;
			write_pattern(right, w)?;
		}
		Node::Degrees(child) => {
			w.word("dg");
			write_pattern(child, w)?;
		}
		Node::Custom { .. } => {
			return Err(Error::new(
				"cannot serialise a pattern that holds a Custom node: a closure or Query written in Rust cannot leave the thread that built it (build the tree from data nodes, or rebuild it on the other thread)",
			));
		}
		Node::Foreign { .. } => {
			return Err(Error::new(
				"cannot serialise a pattern that holds a Foreign node: a callback registered with the host (such as a JavaScript function) means something only to that host, and cannot leave its thread",
			));
		}
	}
	Ok(())
}

fn read_children<T: Wire>(r: &mut Reader<'_>) -> Result<Vec<Pattern<T>>> {
	let count = r.count()?;
	let mut children = Vec::with_capacity(count);
	for _ in 0..count {
		children.push(read_pattern(r)?);
	}
	Ok(children)
}

fn read_pattern<T: Wire>(r: &mut Reader<'_>) -> Result<Pattern<T>> {
	r.descend()?;
	let tag = r.word()?;
	let node = match tag {
		"_" => Node::Silence,
		"p" => Node::Pure(T::read(r)?),
		"st" => Node::Stack(read_children(r)?),
		"ct" => {
			let children = read_children(r)?;
			if children.is_empty() {
				return Err(r.error("a cat needs at least one child"));
			}
			Node::Cat(children)
		}
		"cp" => {
			let begin = r.fraction()?;
			let end = r.fraction()?;
			if begin > end {
				return Err(r.error("a compress window ends before it begins"));
			}
			Node::Compress {
				begin,
				end,
				child: read_pattern(r)?,
			}
		}
		"fa" => Node::Fast {
			factor: r.positive()?,
			child: read_pattern(r)?,
		},
		"sl" => Node::Slow {
			factor: r.positive()?,
			child: read_pattern(r)?,
		},
		"rv" => Node::Rev(read_pattern(r)?),
		"ev" => {
			let n = r.int()?;
			if n <= 0 {
				return Err(r.error("every needs a cycle count above zero"));
			}
			Node::Every {
				n,
				base: read_pattern(r)?,
				transformed: read_pattern(r)?,
			}
		}
		"ar" => {
			let count = r.count()?;
			if count == 0 {
				return Err(r.error("an arrangement needs at least one section"));
			}
			let mut sections = Vec::with_capacity(count);
			for _ in 0..count {
				let cycles = r.int()?;
				if cycles <= 0 {
					return Err(r.error("a section needs at least one cycle"));
				}
				sections.push((cycles, read_pattern(r)?));
			}
			Node::Arrange(sections)
		}
		"wc" => {
			let name = r.word()?;
			let control = Control::from_name(name)
				.ok_or_else(|| r.error(alloc::format!("`{name}` is not a control")))?;
			let kind = r.word()?;
			let child = read_pattern(r)?;
			let source = read_pattern(r)?;
			let input = match kind {
				"l" => ControlSource::Literal(source),
				"p" => ControlSource::Pattern(source),
				other => return Err(r.error(alloc::format!("`{other}` is not l or p"))),
			};
			Node::WithControl {
				child,
				control,
				input,
			}
		}
		"sig" => {
			let kind = read_kind(r)?;
			let seed = read_seed(r)?;
			Node::Signal(Signal { kind, seed })
		}
		"sa" => Node::Sample {
			source: read_pattern(r)?,
			structure: read_pattern::<bool>(r)?,
		},
		"sg" => {
			let count = r.positive()?;
			let source = read_pattern(r)?;
			// The structure is `pure(true)` sped up by the count, as `segment` builds it.
			let structure = Pattern::from_node(Node::Fast {
				factor: count,
				child: pure(true),
			});
			Node::Segment {
				source,
				count,
				structure,
			}
		}
		"map" => {
			let f = read_map(r)?;
			Node::Map {
				child: read_pattern(r)?,
				f,
			}
		}
		"ai" => {
			let op = read_op(r)?;
			Node::Arith {
				left: read_pattern(r)?,
				op,
				right: read_pattern(r)?,
			}
		}
		"dg" => Node::Degrees(read_pattern(r)?),
		other => return Err(r.error(alloc::format!("`{other}` is not a node"))),
	};
	r.depth -= 1;
	Ok(Pattern::from_node(node))
}

impl<T: Wire> Pattern<T> {
	/// The tree as text, to rebuild it with [`Pattern::deserialize`] on another thread, in a worklet, or in a test. The text is deterministic and holds no pointers, so it is the only thing the two sides share.
	///
	/// A tree holding a [`Node::Custom`] or a [`Node::Foreign`] is refused with an [`Error`] that says which: neither can leave the thread that made it.
	///
	/// ```
	/// use undertone_pattern::signal::{periodic, Shape};
	/// use undertone_pattern::{Fraction, Pattern};
	/// let lfo = periodic::<f64>(Shape::Tri, false).range(0.2, 0.8).fast(2.0).unwrap();
	/// let text = lfo.serialize().unwrap();
	/// let there = std::thread::spawn(move || {
	///     let rebuilt = Pattern::<f64>::deserialize(&text).unwrap();
	///     rebuilt.sample_at(Fraction::new(1, 8))
	/// })
	/// .join()
	/// .unwrap();
	/// assert_eq!(there, lfo.sample_at(Fraction::new(1, 8)));
	///
	/// let closure = Pattern::<f64>::from_fn(|_span, _out| {});
	/// assert!(closure.serialize().unwrap_err().message().contains("Custom"));
	/// ```
	pub fn serialize(&self) -> Result<String> {
		let mut w = Writer::new();
		write_pattern(self, &mut w)?;
		Ok(w.out)
	}

	/// Rebuilds a tree from the text [`Pattern::serialize`] wrote. The rebuilt tree queries and samples exactly as the original did, and prints and hashes the same.
	///
	/// ```
	/// use undertone_pattern::{pure, seq, Pattern};
	/// let p = seq(vec![pure(1.0), pure(2.0)]).fast(2.0).unwrap();
	/// let q = Pattern::<f64>::deserialize(&p.serialize().unwrap()).unwrap();
	/// assert_eq!(q.structural_hash(), p.structural_hash());
	/// assert!(Pattern::<f64>::deserialize("ut1 fa 0 _").is_err());
	/// ```
	pub fn deserialize(text: &str) -> Result<Pattern<T>> {
		let mut r = Reader {
			text,
			pos: 0,
			depth: 0,
		};
		if !text.starts_with(HEADER) {
			return Err(Error::new(
				"cannot rebuild the pattern: the text does not start with `ut1`",
			));
		}
		r.pos = HEADER.len();
		let pattern = read_pattern(&mut r)?;
		if r.pos != text.len() {
			return Err(r.error("the text goes on after the tree"));
		}
		Ok(pattern)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::signal::{perlin, rand};
	use crate::{Span, cat, seq, silence, stack};

	fn round_trip<T: Wire>(p: &Pattern<T>) -> Pattern<T> {
		Pattern::deserialize(&p.serialize().unwrap()).unwrap()
	}

	#[test]
	fn numbers_keep_every_bit() {
		for n in [
			0.0,
			-0.0,
			0.1,
			1.0 / 3.0,
			f64::MAX,
			f64::MIN_POSITIVE,
			5e-324,
			f64::INFINITY,
			f64::NEG_INFINITY,
		] {
			let back = round_trip(&pure(n));
			let Node::Pure(m) = back.node() else {
				panic!("not pure")
			};
			assert_eq!(n.to_bits(), m.to_bits(), "{n}");
		}
		let rebuilt = round_trip(&pure(f64::NAN));
		let Node::Pure(nan) = rebuilt.node() else {
			panic!("not pure")
		};
		assert!(nan.is_nan());
	}

	#[test]
	fn strings_need_no_escaping() {
		let value = Value::Map(
			[
				("a b".to_string(), Value::Str("x y:z \n\u{1f3b5}".into())),
				("".to_string(), Value::List(vec![Value::Undefined])),
			]
			.into(),
		);
		assert_eq!(round_trip(&pure(value.clone())).structural_hash(), {
			pure(value).structural_hash()
		});
	}

	#[test]
	fn the_text_is_deterministic_and_short() {
		let p = cat(vec![
			rand::<f64>().range(0.0, 1.0),
			perlin::<f64>().segment(8.0).unwrap(),
		]);
		assert_eq!(p.serialize().unwrap(), p.serialize().unwrap());
		assert_eq!(
			p.serialize().unwrap(),
			"ut1 ct 2 map range 0e0 1e0 sig rand n 0e0 sg 8 sig perlin n 0e0"
		);
	}

	#[test]
	fn custom_and_foreign_are_refused_and_named() {
		let custom = Pattern::<f64>::from_fn(|_, _| {});
		let inside = stack(vec![pure(1.0), custom.fast(2.0).unwrap()]);
		let message = inside.serialize().unwrap_err();
		assert!(message.message().contains("Custom"), "{message}");
		assert!(message.message().contains("cannot leave"), "{message}");
		let mapped = pure(1.0).fmap_with(|v: &f64| v + 1.0);
		assert!(mapped.serialize().is_err());
		struct Host;
		impl crate::ForeignHost<f64> for Host {
			fn query(&self, _: crate::ForeignId, _: Span, _: &mut Vec<crate::Hap<f64>>) {}
		}
		let foreign = Pattern::foreign(alloc::sync::Arc::new(Host), crate::ForeignId(3));
		let message = foreign.serialize().unwrap_err();
		assert!(message.message().contains("Foreign"), "{message}");
	}

	#[test]
	fn bad_text_is_an_error_not_a_panic() {
		for text in [
			"",
			"ut2 _",
			"ut1",
			"ut1 _ _",
			"ut1 nope",
			"ut1 fa 0 _",
			"ut1 fa 1/0 _",
			"ut1 ct 0",
			"ut1 ar 1 0 _",
			"ut1 ar 0",
			"ut1 ev 0 _ _",
			"ut1 p 4:ab",
			"ut1 st 99999999 _",
			"ut1 sig choose 0 n0e0",
			"ut1 wc bogus l _ _",
			"ut1 map scale 6e1 1 5 _",
			"ut1 p x",
		] {
			assert!(Pattern::<f64>::deserialize(text).is_err(), "{text:?}");
		}
		let deep = alloc::format!("ut1{}", " rv".repeat(200));
		assert!(Pattern::<f64>::deserialize(&deep).is_err());
	}

	#[test]
	fn a_rebuilt_tree_queries_the_same() {
		let p = seq(vec![
			rand::<f64>().seed(Seed::Str("kick".into())).unwrap(),
			silence(),
		])
		.every(2.0, |p| p.rev())
		.unwrap();
		let q = round_trip(&p);
		assert_eq!(q.structural_hash(), p.structural_hash());
		let span = Span::new(Fraction::new(-3, 2), Fraction::new(9, 2));
		assert_eq!(q.query(span), p.query(span));
	}
}
