// Turns a corpus program (JSON data) into a pattern by calling the Rust library
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The Rust twin of `conformance/recorder/interpret.ts`.
//!
//! A program is a list of steps: a constructor, then methods. A nested program is a pattern argument, except for the transform of `every` (second argument) and `jux` (first), which is a list of methods applied to the pattern. The interpreter returns `Err(message)` for what the reference throws, word for word, and `Err(Uncovered)` for what this spike does not implement (and says so rather than guessing).

#![allow(dead_code)]

use super::json::Json;
use undertone_pattern::control::{self, Control, ControlArg};
use undertone_pattern::random::Seed;
use undertone_pattern::signal;
use undertone_pattern::{
	ArithOp, MapFn, Pattern, Value, arrange, cat, js, mini, pure, seq, silence, stack, timecat,
};

pub type Pat = Pattern<Value>;

/// Why a program did not give a pattern.
#[derive(Debug, PartialEq)]
pub enum Failure {
	/// The reference throws this message too.
	Error(String),
	/// The spike does not implement something the program needs.
	Uncovered(String),
}

type Built<T> = Result<T, Failure>;

fn err<T>(message: impl Into<String>) -> Built<T> {
	Err(Failure::Error(message.into()))
}

fn uncovered<T>(what: &str) -> Built<T> {
	Err(Failure::Uncovered(what.into()))
}

impl From<undertone_pattern::Error> for Failure {
	fn from(e: undertone_pattern::Error) -> Failure {
		Failure::Error(e.message().into())
	}
}

/// Whether a JSON value is a program: an array of non-empty arrays that each start with a name.
pub fn is_program(value: &Json) -> bool {
	match value {
		Json::Arr(steps) => {
			!steps.is_empty()
				&& steps.iter().all(|step| match step {
					Json::Arr(items) => matches!(items.first(), Some(Json::Str(_))),
					_ => false,
				})
		}
		_ => false,
	}
}

/// The pattern a program describes.
pub fn interpret(program: &Json) -> Built<Pat> {
	let steps = program.as_arr().filter(|s| !s.is_empty());
	let Some((first, rest)) = steps.and_then(|s| s.split_first()) else {
		return err("A program needs at least one step");
	};
	let mut pattern = construct(first)?;
	for step in rest {
		pattern = apply(&pattern, step)?;
	}
	Ok(pattern)
}

fn step_parts(step: &Json) -> (&str, &[Json]) {
	let items = step.as_arr().expect("a step is an array");
	(
		items[0].as_str().expect("a step starts with a name"),
		&items[1..],
	)
}

fn json_value(json: &Json) -> Value {
	match json {
		Json::Num(_, n) => Value::Num(*n),
		Json::Str(s) => Value::Str(s.clone()),
		Json::Bool(b) => Value::Bool(*b),
		other => panic!("not a plain value: {other:?}"),
	}
}

fn pattern_arg(json: &Json) -> Built<Pat> {
	if is_program(json) {
		interpret(json)
	} else {
		uncovered("a pattern argument that is not a program")
	}
}

fn num(json: &Json) -> f64 {
	json.as_f64().expect("a number argument")
}

fn construct(step: &Json) -> Built<Pat> {
	let (name, raw) = step_parts(step);
	match name {
		"mini" => {
			let source = raw[0].as_str().expect("mini source");
			let rule = raw[1].as_str().expect("mini rule");
			match rule {
				"word" => Ok(mini::parse(source, |w| Ok(Value::Str(w.into())))?),
				"number" => Ok(mini::parse(source, |w| {
					Ok(Value::Num(js::string_to_number(w)))
				})?),
				other => err(format!("Unknown leaf rule \"{other}\"")),
			}
		}
		"pure" => Ok(pure(json_value(&raw[0]))),
		"silence" => Ok(silence()),
		"note" => match &raw[0] {
			Json::Str(s) => Ok(control::note(s)?),
			Json::Num(_, hz) => Ok(control::note_hz(*hz)?),
			_ => uncovered("note() with another argument type"),
		},
		"sound" | "s" => {
			let Json::Str(input) = &raw[0] else {
				return uncovered("sound() with a non-string");
			};
			Ok(if name == "sound" {
				control::sound(input)?
			} else {
				control::s(input)?
			})
		}
		"n" => match &raw[0] {
			Json::Str(s) => Ok(control::n(s)?),
			Json::Num(_, d) => Ok(control::n_degree(*d)?),
			program if is_program(program) => Ok(control::n_pattern(&interpret(program)?)?),
			_ => uncovered("n() with another argument type"),
		},
		"chord" => uncovered("chord() and voicing() (chord.ts is the chords group, RF-15)"),
		"stack" | "seq" | "cat" => {
			let patterns = raw.iter().map(pattern_arg).collect::<Built<Vec<_>>>()?;
			Ok(match name {
				"stack" => stack(patterns),
				"seq" => seq(patterns),
				_ => cat(patterns),
			})
		}
		"timecat" => {
			let pairs = pairs_arg(&raw[0])?;
			Ok(timecat(pairs)?)
		}
		"arrange" => {
			let sections = raw.iter().map(pair_arg).collect::<Built<Vec<_>>>()?;
			Ok(arrange(sections)?)
		}
		"irand" => Ok(signal::irand(num(&raw[0]))?),
		"choose" => Ok(signal::choose(raw.iter().map(json_value).collect())?),
		"brandBy" => Ok(signal::brand_by(num(&raw[0]))?),
		other => match signal::by_name(other) {
			Some(pattern) => Ok(pattern),
			None => err(format!("Unknown constructor \"{other}\"")),
		},
	}
}

fn pair_arg(json: &Json) -> Built<(f64, Pat)> {
	let pair = json.as_arr().expect("a [weight, program] pair");
	Ok((num(&pair[0]), pattern_arg(&pair[1])?))
}

fn pairs_arg(json: &Json) -> Built<Vec<(f64, Pat)>> {
	json.as_arr()
		.expect("a list of pairs")
		.iter()
		.map(pair_arg)
		.collect()
}

fn named_map(name: &str, arg: f64) -> Built<MapFn> {
	Ok(match name {
		"add" => MapFn::Add(arg),
		"sub" => MapFn::Sub(arg),
		"mul" => MapFn::Mul(arg),
		"div" => MapFn::Div(arg),
		"neg" => MapFn::Neg,
		"abs" => MapFn::Abs,
		"round" => MapFn::Round,
		"floor" => MapFn::Floor,
		other => return err(format!("Unknown named map \"{other}\"")),
	})
}

/// Applies a list of method steps to a pattern (the transform of `every` and `jux`).
fn transform(steps: &Json, pattern: &Pat) -> Built<Pat> {
	if !is_program(steps) {
		return err("A transform must be a program of methods");
	}
	let mut out = pattern.clone();
	for step in steps.as_arr().unwrap() {
		out = apply(&out, step)?;
	}
	Ok(out)
}

fn control_arg(json: &Json) -> Built<ControlArg> {
	match json {
		Json::Num(_, n) => Ok(ControlArg::Number(*n)),
		Json::Str(s) => Ok(ControlArg::Text(s.clone())),
		program if is_program(program) => Ok(ControlArg::Pattern(interpret(program)?)),
		_ => uncovered("a control argument of another type"),
	}
}

fn arithmetic(pattern: &Pat, op: ArithOp, arg: &Json) -> Built<Pat> {
	match arg {
		Json::Num(_, n) => Ok(pattern.map(match op {
			ArithOp::Add => MapFn::Add(*n),
			ArithOp::Sub => MapFn::Sub(*n),
			ArithOp::Mul => MapFn::Mul(*n),
			ArithOp::Div => MapFn::Div(*n),
		})),
		program if is_program(program) => Ok(pattern.arith(op, &interpret(program)?)),
		_ => err(format!(
			"{}() needs a number or a pattern of numbers",
			op.name()
		)),
	}
}

/// Methods that run side effects or leave the data model, so a program may not name them.
const FORBIDDEN: [&str; 6] = ["query", "sampleAt", "play", "loop", "render", "constructor"];

fn apply(pattern: &Pat, step: &Json) -> Built<Pat> {
	let (name, raw) = step_parts(step);
	if name == "fmap" {
		let map = raw[0].as_str().expect("a map name");
		let arg = raw.get(1).map_or(0.0, num);
		return Ok(pattern.map(named_map(map, arg)?));
	}
	if FORBIDDEN.contains(&name) {
		return err(format!("Method \"{name}\" is not allowed in a program"));
	}
	match name {
		"rev" => Ok(pattern.rev()),
		"fast" => Ok(pattern.fast(num(&raw[0]))?),
		"slow" => Ok(pattern.slow(num(&raw[0]))?),
		"every" => {
			let mut failure = None;
			let result = pattern.every(num(&raw[0]), |p| match transform(&raw[1], p) {
				Ok(transformed) => transformed,
				Err(e) => {
					failure = Some(e);
					p.clone()
				}
			})?;
			match failure {
				Some(e) => Err(e),
				None => Ok(result),
			}
		}
		"euclid" => Ok(pattern.euclid(num(&raw[0]), num(&raw[1]), raw.get(2).map_or(0.0, num))?),
		"segment" => Ok(pattern.segment(num(&raw[0]))?),
		"seed" => {
			let seed = match &raw[0] {
				Json::Num(_, n) => Seed::Num(*n),
				Json::Str(s) => Seed::Str(s.clone()),
				_ => return uncovered("seed() with another type"),
			};
			Ok(pattern.seed(seed)?)
		}
		"range" => Ok(pattern.range(num(&raw[0]), num(&raw[1]))),
		"range2" => Ok(pattern.range2(num(&raw[0]), num(&raw[1]))),
		"rangex" => Ok(pattern.rangex(num(&raw[0]), num(&raw[1]))?),
		"add" => arithmetic(pattern, ArithOp::Add, &raw[0]),
		"sub" => arithmetic(pattern, ArithOp::Sub, &raw[0]),
		"mul" => arithmetic(pattern, ArithOp::Mul, &raw[0]),
		"div" => arithmetic(pattern, ArithOp::Div, &raw[0]),
		"round" => Ok(pattern.round()),
		"floor" => Ok(pattern.floor()),
		"gain" | "lpf" | "pan" | "attack" => {
			let control = Control::from_name(name).expect("a known control");
			Ok(pattern.control(control, control_arg(&raw[0])?)?)
		}
		"scale" => Ok(pattern.scale(raw[0].as_str().expect("a scale spec"))?),
		"sound" => Ok(pattern.with_sound(raw[0].as_str().expect("a sound type"))),
		"s" => Ok(pattern.with_s(raw[0].as_str().expect("a sound name"))),
		"bank" => Ok(pattern.with_bank(raw[0].as_str().expect("a bank name"))),
		"orbit" | "cut" | "panlaw" => match &raw[0] {
			Json::Num(_, n) => Ok(match name {
				"orbit" => pattern.with_orbit(*n)?,
				"cut" => pattern.with_cut(*n)?,
				_ => pattern.with_panlaw(*n)?,
			}),
			program if is_program(program) => Err(Failure::Error(
				control::plain_value_error(name).message().into(),
			)),
			_ => uncovered("a scalar control with another type"),
		},
		"jux" => {
			let transformed = transform(&raw[0], pattern)?;
			Ok(pattern.jux(&transformed)?)
		}
		"voicing" => uncovered("chord() and voicing() (chord.ts is the chords group, RF-15)"),
		other => uncovered(&format!("method {other}() (not in the spike's scope)")),
	}
}
