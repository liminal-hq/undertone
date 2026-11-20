// The constructors and transforms of the pattern core: pure, mini, the list constructors, fast, every, jux, fmap, and the rest
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! API-MAPPING groups 3 to 6 (constructors, arrangement, time transforms, structural transforms) and the numeric
//! methods of group 18, as exports on [`WasmPattern`] and free functions. Each is the pattern crate's own function;
//! what this module adds is the crossing: values in through [`from_js`], errors out word for word, and the
//! JavaScript functions of `mini`, `every`, `jux`, and `fmap` (section 2 of `docs/rust-migration/results/M6-BOUNDARY.md`).

use js_sys::{Function, JsString, Reflect};
use undertone::pattern::random::Seed;
use undertone::pattern::{
	ArithOp, MapFn, Pattern, Value, arrange, cat, mini, pure, seq, silence, stack, timecat,
};
use wasm_bindgen::convert::TryFromJsValue;
use wasm_bindgen::prelude::*;

use crate::convert::{error, from_js, message_of, string_of};
use crate::foreign::{Entry, leaf};
use crate::pattern::{PatternList, WasmPattern, wrap};

/// Calls a transform's thunk (`() => fn(receiver).handle.clone()`, section 2) and takes the handle it returns. A thrown exception, or anything that is not a fresh handle, is kept in `failure` and the transform's place is silence until the caller returns the failure.
fn run_thunk(thunk: &Function, failure: &mut Option<JsValue>) -> Pattern<Value> {
	match thunk.call0(&JsValue::UNDEFINED) {
		Ok(returned) => match WasmPattern::try_from_js_value(returned) {
			Ok(handle) => handle.pattern().clone(),
			Err(_) => {
				*failure = Some(error("a transform's thunk must return a pattern handle"));
				silence()
			}
		},
		Err(thrown) => {
			*failure = Some(thrown);
			silence()
		}
	}
}

/// The pattern crate's result, unless the thunk failed: then its failure, unchanged.
fn after_thunk(
	result: undertone::pattern::Result<Pattern<Value>>,
	failure: Option<JsValue>,
) -> Result<WasmPattern, JsValue> {
	let pattern = wrap(result)?;
	match failure {
		Some(thrown) => Err(thrown),
		None => Ok(pattern),
	}
}

fn arith_op(name: &str) -> Result<ArithOp, JsValue> {
	match name {
		"add" => Ok(ArithOp::Add),
		"sub" => Ok(ArithOp::Sub),
		"mul" => Ok(ArithOp::Mul),
		"div" => Ok(ArithOp::Div),
		_ => Err(error(&format!(
			"unknown arithmetic operation \"{name}\"; use add, sub, mul, or div"
		))),
	}
}

#[wasm_bindgen]
impl WasmPattern {
	/// `fast(factor)`: speeds the pattern up.
	pub fn fast(&self, factor: f64) -> Result<WasmPattern, JsValue> {
		wrap(self.pattern().fast(factor))
	}

	/// `slow(factor)`: slows the pattern down.
	pub fn slow(&self, factor: f64) -> Result<WasmPattern, JsValue> {
		wrap(self.pattern().slow(factor))
	}

	/// `rev()`: each cycle reversed.
	pub fn rev(&self) -> WasmPattern {
		WasmPattern::new(self.pattern().rev())
	}

	/// `euclid(pulses, steps, rotation)`: the pattern over a euclidean rhythm (the wrapper passes the reference's default rotation, 0).
	pub fn euclid(&self, pulses: f64, steps: f64, rotation: f64) -> Result<WasmPattern, JsValue> {
		wrap(self.pattern().euclid(pulses, steps, rotation))
	}

	/// `every(n, fn)`: `transform` is the wrapper's thunk, called once, after `n` is checked, as the reference calls `fn`.
	pub fn every(&self, n: f64, transform: &Function) -> Result<WasmPattern, JsValue> {
		let mut failure = None;
		let result = self
			.pattern()
			.every(n, |_| run_thunk(transform, &mut failure));
		after_thunk(result, failure)
	}

	/// `jux(fn)`: the pattern hard left and the thunk's pattern hard right; the thunk is called once.
	pub fn jux(&self, transform: &Function) -> Result<WasmPattern, JsValue> {
		let mut failure = None;
		let result = self.pattern().jux(|_| run_thunk(transform, &mut failure));
		after_thunk(result, failure)
	}

	/// `fmap(fn)` with a JavaScript function: a foreign leaf over this pattern. `map` is batched: it takes the array of a query's values and returns the array of mapped values (the wrapper passes `(values) => values.map(fn)`).
	pub fn fmap(&self, map: Function) -> Result<WasmPattern, JsValue> {
		leaf(Entry::Map {
			child: self.pattern().clone(),
			map,
		})
		.map(WasmPattern::new)
	}

	/// `segment(count)`: `count` haps per cycle, each holding the value at its onset.
	pub fn segment(&self, count: f64) -> Result<WasmPattern, JsValue> {
		wrap(self.pattern().segment(count))
	}

	/// `seed(seed)` on a random signal: a number or a string; anything else fails with the reference's message.
	pub fn seed(&self, seed: JsValue) -> Result<WasmPattern, JsValue> {
		if let Some(number) = seed.as_f64() {
			return wrap(self.pattern().seed(Seed::Num(number)));
		}
		if let Some(text) = seed.as_string() {
			return wrap(self.pattern().seed(Seed::Str(text)));
		}
		// The reference checks that the pattern can be seeded first, then the seed's type.
		self.pattern()
			.seed(Seed::Num(0.0))
			.map_err(crate::convert::rust_error)?;
		Err(error(&format!(
			"seed() needs a finite number or a string, got {}",
			string_of(&seed)
		)))
	}

	/// `range(lo, hi)`: from 0..1 onto lo..hi.
	pub fn range(&self, lo: f64, hi: f64) -> WasmPattern {
		WasmPattern::new(self.pattern().range(lo, hi))
	}

	/// `range2(lo, hi)`: from -1..1 onto lo..hi.
	pub fn range2(&self, lo: f64, hi: f64) -> WasmPattern {
		WasmPattern::new(self.pattern().range2(lo, hi))
	}

	/// `rangex(lo, hi)`: from 0..1 onto lo..hi exponentially.
	pub fn rangex(&self, lo: f64, hi: f64) -> Result<WasmPattern, JsValue> {
		wrap(self.pattern().rangex(lo, hi))
	}

	/// `add`, `sub`, `mul`, or `div` (named by `op`) with a number. The wrapper gives the reference's message for anything that is neither a number nor a pattern.
	pub fn arith(&self, op: &str, other: f64) -> Result<WasmPattern, JsValue> {
		let map = match arith_op(op)? {
			ArithOp::Add => MapFn::Add(other),
			ArithOp::Sub => MapFn::Sub(other),
			ArithOp::Mul => MapFn::Mul(other),
			ArithOp::Div => MapFn::Div(other),
		};
		Ok(WasmPattern::new(self.pattern().fmap(map)))
	}

	/// `add`, `sub`, `mul`, or `div` with a pattern read at each onset.
	#[wasm_bindgen(js_name = arithPattern)]
	pub fn arith_pattern(&self, op: &str, other: &WasmPattern) -> Result<WasmPattern, JsValue> {
		Ok(WasmPattern::new(
			self.pattern().arith(arith_op(op)?, other.pattern()),
		))
	}

	/// `round()`: to the nearest whole number, halves up.
	pub fn round(&self) -> WasmPattern {
		WasmPattern::new(self.pattern().round())
	}

	/// `floor()`: down to a whole number.
	pub fn floor(&self) -> WasmPattern {
		WasmPattern::new(self.pattern().floor())
	}
}

/// `pure(value)`: the value once per cycle.
#[wasm_bindgen(js_name = pure)]
pub fn pure_js(value: JsValue) -> Result<WasmPattern, JsValue> {
	Ok(WasmPattern::new(pure(from_js(&value)?)))
}

/// `silence`: no haps, ever.
#[wasm_bindgen(js_name = silence)]
pub fn silence_js() -> WasmPattern {
	WasmPattern::new(silence())
}

/// `stack(...patterns)`: all at once.
#[wasm_bindgen(js_name = stack)]
pub fn stack_js(list: &PatternList) -> WasmPattern {
	WasmPattern::new(stack(list.patterns()))
}

/// `seq(...patterns)`: one after another within each cycle.
#[wasm_bindgen(js_name = seq)]
pub fn seq_js(list: &PatternList) -> WasmPattern {
	WasmPattern::new(seq(list.patterns()))
}

/// `cat(...patterns)`: one per cycle, in rotation.
#[wasm_bindgen(js_name = cat)]
pub fn cat_js(list: &PatternList) -> WasmPattern {
	WasmPattern::new(cat(list.patterns()))
}

/// `timecat([[weight, pattern], ...])`: one after another within each cycle, each taking its weight (the list's weights).
#[wasm_bindgen(js_name = timecat)]
pub fn timecat_js(list: &PatternList) -> Result<WasmPattern, JsValue> {
	wrap(timecat(list.weighted()))
}

/// `arrange([cycles, pattern], ...)`: each section for its whole cycles, in order, looping (the list's weights are the cycle counts).
#[wasm_bindgen(js_name = arrange)]
pub fn arrange_js(list: &PatternList) -> Result<WasmPattern, JsValue> {
	wrap(arrange(list.weighted()))
}

/// `mini(source, leaf)`: mini-notation, with `leaf` called once per word while parsing. A leaf that throws fails the parse with its message at the word's position, as the reference reports it.
///
/// The source is taken as a JavaScript string, because a Rust string cannot hold a lone UTF-16 surrogate half: the parser
/// reads it with each lone half (and so each half of a character beyond the Basic Multilingual Plane that it reports) as
/// U+FFFD, and the error message is then rebuilt with the source's own code units, so it is the
/// reference's word for word (`unexpected "\ud83d"` for an emoji).
#[wasm_bindgen(js_name = mini)]
pub fn mini_js(source: &JsString, leaf: &Function) -> Result<WasmPattern, JsValue> {
	let text = String::from(source);
	let result = mini(&text, |word| {
		let value = leaf
			.call1(&JsValue::UNDEFINED, &JsValue::from_str(word))
			.map_err(|thrown| message_of(&thrown))?;
		from_js(&value).map_err(|refused| message_of(&refused))
	});
	match result {
		Ok(pattern) => Ok(WasmPattern::new(pattern)),
		Err(err) => {
			let error = js_sys::Error::new("");
			let message = mini_message(err.message(), &text, source);
			Reflect::set(&error, &JsValue::from_str("message"), &message)?;
			Err(error.into())
		}
	}
}

/// The parser's message with the JavaScript source's own code units put back: the quoted source, and the character an
/// `unexpected` message quotes (the code unit at the reported position, as the reference's tokenizer reads it). A message
/// for a source with no surrogate halves is returned as it is.
pub(crate) fn mini_message(message: &str, text: &str, source: &JsString) -> JsString {
	let plain = || JsString::from(message);
	let Some((position, rest)) = message
		.strip_prefix("Mini-notation error at position ")
		.and_then(|rest| rest.split_once(' '))
	else {
		return plain();
	};
	let quoted = format!("in \"{text}\": ");
	let (Ok(position), Some(detail)) =
		(position.parse::<u32>(), rest.strip_prefix(quoted.as_str()))
	else {
		return plain();
	};
	let surrogate = position < source.length()
		&& (0xd800..=0xdfff).contains(&(source.char_code_at(position) as u32));
	let replaced = detail == "unexpected \"\u{fffd}\"" && surrogate;
	if !replaced && text.encode_utf16().eq(source.iter()) {
		return plain();
	}
	let detail = if replaced {
		JsString::from("unexpected \"")
			.concat(&source.char_at(position))
			.concat(&JsValue::from_str("\""))
	} else {
		JsString::from(detail)
	};
	JsString::from(format!("Mini-notation error at position {position} in \"").as_str())
		.concat(source)
		.concat(&JsValue::from_str("\": "))
		.concat(&detail)
}
