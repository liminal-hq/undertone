// Turns a corpus program (JSON data) into a pattern by calling the Rust library
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The Rust twin of `conformance/recorder/interpret.ts`.
//!
//! A program is a list of steps: a constructor, then methods. A nested program is a pattern argument, except for the transform of `every` (second argument) and `jux` (first), which is a list of methods applied to the pattern. The interpreter returns `Err(message)` for what the reference throws, word for word, and `Err(Uncovered)` for what this spike does not implement (and says so rather than guessing).

#![allow(dead_code)]

use super::json::Json;
use undertone_pattern::chord::{self, VoicingOptions};
use undertone_pattern::control;
use undertone_pattern::controls::{ArgKind, Control, ControlInput, control_spec};
use undertone_pattern::drift::{self, DriftOptions};
use undertone_pattern::instruments::{
	EnvelopeDefinition, FmVoiceDefinition, LayerOptions, fm_presets, fm_voice, layer,
};
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
				"pitch" => Ok(control::note(source)?),
				"drum" => Ok(control::s(source)?),
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
		"chord" => match &raw[0] {
			Json::Str(s) => Ok(chord::chord(s)?),
			_ => uncovered("chord() with a non-string"),
		},
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

fn control_arg(json: &Json) -> Built<ControlInput> {
	match json {
		Json::Num(_, n) => Ok(ControlInput::Number(*n)),
		Json::Str(s) => Ok(ControlInput::Text(s.clone())),
		program if is_program(program) => Ok(ControlInput::Pattern(interpret(program)?)),
		_ => uncovered("a control argument of another type"),
	}
}

fn arithmetic(pattern: &Pat, op: ArithOp, arg: &Json) -> Built<Pat> {
	match arg {
		Json::Num(_, n) => Ok(pattern.fmap(match op {
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

/// A number as the corpus writes it: plain, or one of the `$num` specials.
fn json_number(json: &Json) -> Option<f64> {
	match json {
		Json::Num(_, n) => Some(*n),
		Json::Obj(_) => match json.get("$num").and_then(Json::as_str)? {
			"NaN" => Some(f64::NAN),
			"Infinity" => Some(f64::INFINITY),
			"-Infinity" => Some(f64::NEG_INFINITY),
			"-0" => Some(-0.0),
			_ => None,
		},
		_ => None,
	}
}

/// The options object of a `drift` step.
///
/// The reference takes any JavaScript value for an option, and the corpus holds a few that a typed Rust struct cannot: `null` (which acts as the default) and a string. A string is refused by the reference's own checks, with the string in the message, so this reads those checks in the reference's order (`cyclesPerPass`, `timing`, `level`, `cents`, `pan`) and reports the message itself. A bridge from JavaScript has to do the same coercion before it builds `DriftOptions`.
fn drift_options(object: &Json) -> Built<DriftOptions> {
	// A missing seed is `undefined`, which the key prints as the word.
	let seed = match object.get("seed") {
		Some(Json::Str(s) | Json::Wide(_, s)) => Seed::Str(s.clone()),
		Some(other) => match json_number(other) {
			Some(n) => Seed::Num(n),
			None => return uncovered("drift() with another seed type"),
		},
		None => Seed::Str("undefined".into()),
	};
	let mut options = DriftOptions::new(seed);
	if let Some(Json::Wide(units, _)) = object.get("seed") {
		options.seed_utf16 = Some(units.clone());
	}
	for name in ["cyclesPerPass", "timing", "level", "cents", "pan", "push"] {
		let Some(value) = object.get(name) else {
			continue;
		};
		let number = match value {
			Json::Null => continue,
			Json::Str(text) => {
				// What the reference's checks say about a string, after the checks of the options before it.
				options.validate()?;
				let n = undertone_pattern::js::string_to_number(text);
				return match name {
					"cyclesPerPass" => Err(drift::cycles_per_pass_error(text).into()),
					"push" => uncovered("drift() push as a string"),
					_ if n.is_nan() || n < 0.0 => {
						Err(drift::negative_range_error(name, text).into())
					}
					_ => uncovered("drift() with a numeric string for a range"),
				};
			}
			other => match json_number(other) {
				Some(n) => n,
				None => return uncovered("drift() with another option type"),
			},
		};
		match name {
			"cyclesPerPass" => options.cycles_per_pass = number,
			"timing" => options.timing = number,
			"level" => options.level = number,
			"cents" => options.cents = number,
			"pan" => options.pan = number,
			_ => options.push = number,
		}
	}
	Ok(options)
}

/// A voice patch as the corpus writes it: a plain object, `{"$fmVoice": definition}`, or `{"$preset": name}`.
fn patch_value(json: &Json) -> Built<Value> {
	Ok(match json {
		Json::Num(_, n) => Value::Num(*n),
		Json::Str(s) | Json::Wide(_, s) => Value::Str(s.clone()),
		Json::Bool(b) => Value::Bool(*b),
		Json::Null => Value::Undefined,
		Json::Arr(items) => Value::List(items.iter().map(patch_value).collect::<Built<_>>()?),
		Json::Obj(fields) => {
			if let Some(definition) = json.get("$fmVoice") {
				return Ok(fm_voice(&fm_definition(definition)?)?);
			}
			if let Some(name) = json.get("$preset") {
				let name = name.as_str().expect("a preset name");
				return match fm_presets().get(name) {
					Some(preset) => Ok(preset.clone()),
					None => uncovered(&format!("the preset {name}")),
				};
			}
			Value::Map(
				fields
					.iter()
					.map(|(key, value)| Ok((key.clone(), patch_value(value)?)))
					.collect::<Built<_>>()?,
			)
		}
	})
}

fn envelope_definition(json: Option<&Json>) -> EnvelopeDefinition {
	let field = |name: &str| json.and_then(|j| j.get(name)).and_then(Json::as_f64);
	EnvelopeDefinition {
		attack: field("attack"),
		decay: field("decay"),
		sustain: field("sustain"),
		release: field("release"),
	}
}

/// The `fmVoice` definition object of a patch.
fn fm_definition(json: &Json) -> Built<FmVoiceDefinition> {
	let wave = |name: &str| {
		json.get(name)
			.and_then(|j| j.get("type"))
			.and_then(Json::as_str)
			.map(str::to_string)
	};
	Ok(FmVoiceDefinition {
		harmonicity: json.get("harmonicity").and_then(Json::as_f64),
		modulation_index: json.get("modulationIndex").and_then(Json::as_f64),
		oscillator: wave("oscillator"),
		modulation: wave("modulation"),
		envelope: envelope_definition(json.get("envelope")),
		modulation_envelope: envelope_definition(json.get("modulationEnvelope")),
		level: json.get("level").and_then(Json::as_f64),
		pan: json.get("pan").and_then(Json::as_f64),
	})
}

/// The options object of a `layer` step.
fn layer_options(json: Option<&Json>) -> LayerOptions {
	let list = |name: &str| -> Vec<f64> {
		json.and_then(|j| j.get(name))
			.and_then(Json::as_arr)
			.map(|items| items.iter().map(num).collect())
			.unwrap_or_default()
	};
	LayerOptions {
		stagger: json.and_then(|j| j.get("stagger")).and_then(Json::as_f64),
		levels: list("levels"),
		pans: list("pans"),
	}
}

/// Methods that run side effects or leave the data model, so a program may not name them.
const FORBIDDEN: [&str; 6] = ["query", "sampleAt", "play", "loop", "render", "constructor"];

fn apply(pattern: &Pat, step: &Json) -> Built<Pat> {
	let (name, raw) = step_parts(step);
	if name == "fmap" {
		let map = raw[0].as_str().expect("a map name");
		let arg = raw.get(1).map_or(0.0, num);
		return Ok(pattern.fmap(named_map(map, arg)?));
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
		"scale" => Ok(pattern.scale(raw[0].as_str().expect("a scale spec"))?),
		// Every other control is in the table: a list argument is data, anything else goes through the dynamic path.
		name if control_spec(name).is_some() => {
			let spec = control_spec(name).expect("a known control");
			let control = Control::from_name(name).expect("a known control");
			match spec.arg {
				ArgKind::PatternableWithTime => {
					let seconds = raw.get(1).map(num);
					Ok(pattern.pan_slide(control_arg(&raw[0])?, seconds)?)
				}
				ArgKind::NumberList | ArgKind::Path => {
					let Json::Arr(items) = &raw[0] else {
						return Ok(pattern.control(control, control_arg(&raw[0])?)?);
					};
					if is_program(&raw[0]) {
						return Ok(pattern.control(control, control_arg(&raw[0])?)?);
					}
					// `panpath` also takes `{ time, pan }` points.
					if name == "panpath" && items.iter().all(|item| matches!(item, Json::Obj(_))) {
						let field =
							|item: &Json, key: &str| num(item.get(key).expect("a point field"));
						let points: Vec<(f64, f64)> = items
							.iter()
							.map(|item| (field(item, "time"), field(item, "pan")))
							.collect();
						return Ok(pattern.pan_path_points(&points)?);
					}
					let numbers: Vec<f64> = items.iter().map(num).collect();
					let rate = raw.get(1).map(num);
					Ok(match name {
						"channels" => pattern.channels(&numbers)?,
						"pitchsteps" => pattern.pitch_steps(&numbers, rate)?,
						_ => pattern.pan_path(&numbers, rate)?,
					})
				}
				ArgKind::Text => Ok(match name {
					"sound" => pattern.sound(raw[0].as_str().expect("a sound type")),
					"s" => pattern.s(raw[0].as_str().expect("a sound name")),
					_ => pattern.bank(raw[0].as_str().expect("a bank name")),
				}),
				_ => Ok(pattern.control(control, control_arg(&raw[0])?)?),
			}
		}
		"jux" => {
			let mut failure = None;
			let result = pattern.jux(|p| match transform(&raw[0], p) {
				Ok(transformed) => transformed,
				Err(e) => {
					failure = Some(e);
					p.clone()
				}
			});
			match failure {
				Some(e) => Err(e),
				None => Ok(result?),
			}
		}
		"voicing" => {
			let options = match raw.first() {
				None => VoicingOptions::default(),
				Some(object) => match object.get("anchor") {
					None => VoicingOptions::default(),
					Some(Json::Num(_, midi)) => VoicingOptions::anchor_midi(*midi),
					Some(Json::Str(name)) => VoicingOptions::anchor_name(name),
					Some(_) => return uncovered("voicing() with another anchor type"),
				},
			};
			Ok(pattern.voicing(options))
		}
		"drift" => Ok(drift::drift(pattern, drift_options(&raw[0])?)?),
		"voice" => Ok(pattern.voice(&patch_value(&raw[0])?)),
		"layer" => {
			let voices = raw[0]
				.as_arr()
				.expect("a list of voices")
				.iter()
				.map(patch_value)
				.collect::<Built<Vec<_>>>()?;
			Ok(layer(pattern, &voices, &layer_options(raw.get(1)))?)
		}
		other => uncovered(&format!("method {other}() (not in the spike's scope)")),
	}
}
