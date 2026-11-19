// Throwaway wasm-bindgen binding of the R1 pattern core for spike R5 (the TypeScript suite against a Rust-backed Pattern)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A `Handle` around `Pattern<Value>`, a value conversion between JavaScript and `Value`, and the constructors
//! and methods the suite's pattern, mini-notation, signal, and control tests call. Nothing here decides anything:
//! every operation is R1's. A hap crosses as a flat row of numbers (`[partBeginN, partBeginD, partEndN,
//! partEndD, wholeBeginN, wholeBeginD, wholeEndN, wholeEndD, value]`, with `null` whole fields when there is none).

use std::collections::BTreeMap;
use std::sync::Arc;

use js_sys::{Array, Function, Object, Reflect};
use undertone_pattern::control::{self, Control, ControlArg};
use undertone_pattern::random::Seed;
use undertone_pattern::signal;
use undertone_pattern::value::MapFn;
use undertone_pattern::{
	ArithOp, CustomQuery, ForeignFn, Fraction, Hap, Pattern, Span, Value, arrange, cat, mini, pure,
	seq, silence, stack, timecat,
};
use wasm_bindgen::prelude::*;

fn err(e: undertone_pattern::Error) -> JsError {
	JsError::new(e.message())
}

/// A JavaScript value as a `Value`: a number, string, boolean, or a plain object of those. Anything else is an error:
/// that is the measurement (arrays, functions, `undefined`, and class instances cannot sit in the Rust tree).
fn to_value(js: &JsValue) -> Result<Value, String> {
	if let Some(n) = js.as_f64() {
		Ok(Value::Num(n))
	} else if let Some(s) = js.as_string() {
		Ok(Value::Str(s))
	} else if let Some(b) = js.as_bool() {
		Ok(Value::Bool(b))
	} else if js.is_object() && !Array::is_array(js) && !js.is_function() {
		let mut map = BTreeMap::new();
		for key in Object::keys(js.unchecked_ref::<Object>()).iter() {
			let value = Reflect::get(js, &key).map_err(|_| "unreadable field".to_string())?;
			if value.is_undefined() {
				continue;
			}
			map.insert(key.as_string().unwrap_or_default(), to_value(&value)?);
		}
		Ok(Value::Map(map))
	} else {
		Err(format!(
			"the bridge cannot hold this JavaScript value in a pattern (kind: {})",
			kind(js)
		))
	}
}

fn kind(js: &JsValue) -> &'static str {
	if js.is_undefined() {
		"undefined"
	} else if js.is_null() {
		"null"
	} else if Array::is_array(js) {
		"array"
	} else if js.is_function() {
		"function"
	} else if js.is_bigint() {
		"bigint"
	} else if js.is_symbol() {
		"symbol"
	} else {
		"other"
	}
}

fn from_value(value: &Value) -> JsValue {
	match value {
		Value::Num(n) => JsValue::from_f64(*n),
		Value::Str(s) => JsValue::from_str(s),
		Value::Bool(b) => JsValue::from_bool(*b),
		Value::Map(map) => {
			let object = Object::new();
			for (k, v) in map {
				let _ = Reflect::set(&object, &JsValue::from_str(k), &from_value(v));
			}
			object.into()
		}
	}
}

fn fraction_of(n: f64, d: f64) -> Fraction {
	Fraction::new(n as i128, d as i128)
}

fn row(hap: &Hap<Value>) -> Array {
	let r = Array::new();
	let push = |f: &Fraction| {
		r.push(&JsValue::from_f64(f.numerator() as f64));
		r.push(&JsValue::from_f64(f.denominator() as f64));
	};
	push(&hap.part.begin);
	push(&hap.part.end);
	match &hap.whole {
		Some(w) => {
			push(&w.begin);
			push(&w.end);
		}
		None => {
			for _ in 0..4 {
				r.push(&JsValue::NULL);
			}
		}
	}
	r.push(&from_value(&hap.value));
	r
}

fn hap_of(row: &JsValue) -> Option<Hap<Value>> {
	let a = Array::from(row);
	let num = |i: u32| a.get(i).as_f64();
	let part = Span::new(fraction_of(num(0)?, num(1)?), fraction_of(num(2)?, num(3)?));
	let whole = match (num(4), num(5), num(6), num(7)) {
		(Some(a), Some(b), Some(c), Some(d)) => {
			Some(Span::new(fraction_of(a, b), fraction_of(c, d)))
		}
		_ => None,
	};
	Some(Hap {
		whole,
		part,
		value: to_value(&a.get(8)).ok()?,
	})
}

/// A JavaScript function the tree may call during a query (the two escape hatches).
struct HostFn(Function, u64);
unsafe impl Send for HostFn {}
unsafe impl Sync for HostFn {}

impl ForeignFn<Value> for HostFn {
	fn call(&self, value: &Value) -> Value {
		let out = self
			.0
			.call1(&JsValue::NULL, &from_value(value))
			.unwrap_or(JsValue::UNDEFINED);
		to_value(&out).unwrap_or(Value::Num(f64::NAN))
	}
	fn id(&self) -> u64 {
		self.1
	}
}

impl CustomQuery<Value> for HostFn {
	fn query(&self, span: Span) -> Vec<Hap<Value>> {
		let args = [
			span.begin.numerator() as f64,
			span.begin.denominator() as f64,
			span.end.numerator() as f64,
			span.end.denominator() as f64,
		];
		let out = self
			.0
			.apply(
				&JsValue::NULL,
				&args
					.iter()
					.map(|x| JsValue::from_f64(*x))
					.collect::<Array>(),
			)
			.unwrap_or(JsValue::NULL);
		Array::from(&out)
			.iter()
			.filter_map(|r| hap_of(&r))
			.collect()
	}
	fn id(&self) -> u64 {
		self.1
	}
}

/// `new Pattern(query, sample)`: the host query function and, for a continuous pattern, its point sampler.
struct HostPattern {
	query: HostFn,
	sample: Option<Function>,
}

impl CustomQuery<Value> for HostPattern {
	fn query(&self, span: Span) -> Vec<Hap<Value>> {
		CustomQuery::query(&self.query, span)
	}
	fn sample(&self, t: Fraction) -> Option<Value> {
		let f = self.sample.as_ref()?;
		let out = f
			.call2(
				&JsValue::NULL,
				&JsValue::from_f64(t.numerator() as f64),
				&JsValue::from_f64(t.denominator() as f64),
			)
			.ok()?;
		if out.is_undefined() {
			None
		} else {
			to_value(&out).ok()
		}
	}
	fn has_sampler(&self) -> bool {
		self.sample.is_some()
	}
	fn id(&self) -> u64 {
		self.query.1
	}
}
unsafe impl Send for HostPattern {}
unsafe impl Sync for HostPattern {}

/// A pattern handle (the reference's `Pattern`).
#[wasm_bindgen]
pub struct Handle(Pattern<Value>);

fn wrap(p: Pattern<Value>) -> Handle {
	Handle(p)
}

/// A list of patterns built one `push` at a time: exported structs given inside a JavaScript array are moved out
/// (the JavaScript object is left with a null pointer), so a list borrows each handle instead.
#[wasm_bindgen]
#[derive(Default)]
pub struct List(Vec<(f64, Pattern<Value>)>);

#[wasm_bindgen]
impl List {
	#[wasm_bindgen(constructor)]
	pub fn new() -> List {
		List(Vec::new())
	}

	pub fn push(&mut self, weight: f64, handle: &Handle) {
		self.0.push((weight, handle.0.clone()));
	}
}

fn plain(list: &List) -> Vec<Pattern<Value>> {
	list.0.iter().map(|(_, p)| p.clone()).collect()
}

#[wasm_bindgen]
pub fn pure_handle(value: JsValue) -> Result<Handle, JsError> {
	to_value(&value)
		.map(|v| wrap(pure(v)))
		.map_err(|m| JsError::new(&m))
}

#[wasm_bindgen]
pub fn silence_handle() -> Handle {
	wrap(silence())
}

#[wasm_bindgen]
pub fn seq_handle(list: &List) -> Handle {
	wrap(seq(plain(list)))
}

#[wasm_bindgen]
pub fn cat_handle(list: &List) -> Handle {
	wrap(cat(plain(list)))
}

#[wasm_bindgen]
pub fn stack_handle(list: &List) -> Handle {
	wrap(stack(plain(list)))
}

#[wasm_bindgen]
pub fn timecat_handle(list: &List) -> Result<Handle, JsError> {
	timecat(list.0.clone()).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn arrange_handle(list: &List) -> Result<Handle, JsError> {
	arrange(list.0.clone()).map(wrap).map_err(err)
}

/// `mini(source, leaf)`: `leaf` runs once per word at construction (it may throw to reject a word).
#[wasm_bindgen]
pub fn mini_handle(source: &str, leaf: &Function) -> Result<Handle, JsError> {
	mini::parse(source, |word| {
		let out = leaf
			.call1(&JsValue::NULL, &JsValue::from_str(word))
			.map_err(|e| {
				Reflect::get(&e, &JsValue::from_str("message"))
					.ok()
					.and_then(|m| m.as_string())
					.unwrap_or_else(|| "leaf failed".to_string())
			})?;
		to_value(&out)
	})
	.map(wrap)
	.map_err(err)
}

/// `new Pattern(query)`: a pattern defined by a host query function (takes four numbers, returns rows).
#[wasm_bindgen]
pub fn custom_handle(query: Function, id: u32, sample: Option<Function>) -> Handle {
	wrap(Pattern::custom(Arc::new(HostPattern {
		query: HostFn(query, id as u64),
		sample,
	})))
}

#[wasm_bindgen]
pub fn note_handle(input: &str) -> Result<Handle, JsError> {
	control::note(input).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn note_hz_handle(hz: f64) -> Result<Handle, JsError> {
	control::note_hz(hz).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn sound_handle(input: &str) -> Result<Handle, JsError> {
	control::sound(input).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn s_handle(input: &str) -> Result<Handle, JsError> {
	control::s(input).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn n_handle(input: &str) -> Result<Handle, JsError> {
	control::n(input).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn n_degree_handle(degree: f64) -> Result<Handle, JsError> {
	control::n_degree(degree).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn n_pattern_handle(pattern: &Handle) -> Result<Handle, JsError> {
	control::n_pattern(&pattern.0).map(wrap).map_err(err)
}

/// A signal by its exported name (`sine`, `saw2`, `rand`, `perlin`, `brand`, ...).
#[wasm_bindgen]
pub fn signal_handle(name: &str) -> Result<Handle, JsError> {
	signal::by_name::<Value>(name)
		.map(wrap)
		.ok_or_else(|| JsError::new(&format!("unknown signal {name}")))
}

#[wasm_bindgen]
pub fn irand_handle(n: f64) -> Result<Handle, JsError> {
	signal::irand::<Value>(n).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn choose_handle(values: &Array) -> Result<Handle, JsError> {
	let values = values
		.iter()
		.map(|v| to_value(&v).map_err(|m| JsError::new(&m)))
		.collect::<Result<Vec<_>, _>>()?;
	signal::choose(values).map(wrap).map_err(err)
}

#[wasm_bindgen]
pub fn brand_by_handle(p: f64) -> Result<Handle, JsError> {
	signal::brand_by::<Value>(p).map(wrap).map_err(err)
}

fn arith_op(name: &str) -> Option<ArithOp> {
	match name {
		"add" => Some(ArithOp::Add),
		"sub" => Some(ArithOp::Sub),
		"mul" => Some(ArithOp::Mul),
		"div" => Some(ArithOp::Div),
		_ => None,
	}
}

#[wasm_bindgen]
impl Handle {
	/// The haps over `[begin, end)`, as rows.
	pub fn query(&self, bn: f64, bd: f64, en: f64, ed: f64) -> Array {
		let span = Span::new(fraction_of(bn, bd), fraction_of(en, ed));
		self.0.query(span).iter().map(row).collect()
	}

	/// The value at an instant, or `undefined` in a rest.
	pub fn sample_at(&self, n: f64, d: f64) -> JsValue {
		self.0
			.sample_at(fraction_of(n, d))
			.map_or(JsValue::UNDEFINED, |v| from_value(&v))
	}

	/// Whether a sampler answers `sampleAt` (a signal), so the wrapper can expose `.sample`.
	pub fn has_sampler(&self) -> bool {
		self.0.has_sampler()
	}

	pub fn fast(&self, factor: f64) -> Result<Handle, JsError> {
		self.0.fast(factor).map(wrap).map_err(err)
	}

	pub fn slow(&self, factor: f64) -> Result<Handle, JsError> {
		self.0.slow(factor).map(wrap).map_err(err)
	}

	pub fn rev(&self) -> Handle {
		wrap(self.0.rev())
	}

	/// `every(n, fn)` after the wrapper ran `fn` once with the receiver.
	pub fn every_with(&self, n: f64, transformed: &Handle) -> Result<Handle, JsError> {
		self.0
			.every(n, |_| transformed.0.clone())
			.map(wrap)
			.map_err(err)
	}

	pub fn euclid(&self, pulses: f64, steps: f64, rotation: f64) -> Result<Handle, JsError> {
		self.0
			.euclid(pulses, steps, rotation)
			.map(wrap)
			.map_err(err)
	}

	pub fn segment(&self, count: f64) -> Result<Handle, JsError> {
		self.0.segment(count).map(wrap).map_err(err)
	}

	pub fn seed(&self, seed: JsValue) -> Result<Handle, JsError> {
		let seed = match (seed.as_f64(), seed.as_string()) {
			(Some(n), _) => Seed::Num(n),
			(_, Some(s)) => Seed::Str(s),
			_ => return Err(JsError::new("seed() needs a finite number or a string")),
		};
		self.0.seed(seed).map(wrap).map_err(err)
	}

	pub fn range(&self, lo: f64, hi: f64) -> Handle {
		wrap(self.0.range(lo, hi))
	}

	pub fn range2(&self, lo: f64, hi: f64) -> Handle {
		wrap(self.0.range2(lo, hi))
	}

	pub fn rangex(&self, lo: f64, hi: f64) -> Result<Handle, JsError> {
		self.0.rangex(lo, hi).map(wrap).map_err(err)
	}

	pub fn round(&self) -> Handle {
		wrap(self.0.round())
	}

	pub fn floor(&self) -> Handle {
		wrap(self.0.floor())
	}

	/// `add`, `sub`, `mul`, `div` with a number.
	pub fn arith_number(&self, op: &str, n: f64) -> Result<Handle, JsError> {
		let f = match op {
			"add" => MapFn::Add(n),
			"sub" => MapFn::Sub(n),
			"mul" => MapFn::Mul(n),
			"div" => MapFn::Div(n),
			_ => return Err(JsError::new("unknown operation")),
		};
		Ok(wrap(self.0.map(f)))
	}

	/// `add`, `sub`, `mul`, `div` with a pattern.
	pub fn arith_pattern(&self, op: &str, other: &Handle) -> Result<Handle, JsError> {
		let op = arith_op(op).ok_or_else(|| JsError::new("unknown operation"))?;
		Ok(wrap(self.0.arith(op, &other.0)))
	}

	/// `fmap(fn)` as a foreign leaf (the value is converted each way on every query).
	pub fn fmap_foreign(&self, f: Function, id: u32) -> Handle {
		wrap(self.0.foreign_map(Arc::new(HostFn(f, id as u64))))
	}

	pub fn describe(&self) -> String {
		self.0.to_string()
	}

	/// A control by name (`gain`, `lpf`, `pan`, `attack`), given a number, a string, or a pattern.
	pub fn control(&self, name: &str, arg: JsValue) -> Result<Handle, JsError> {
		let control = Control::from_name(name).ok_or_else(|| JsError::new("not bound"))?;
		let arg = if let Some(n) = arg.as_f64() {
			ControlArg::Number(n)
		} else if let Some(s) = arg.as_string() {
			ControlArg::Text(s)
		} else {
			return Err(JsError::new(
				"a control takes a number, a string, or a pattern",
			));
		};
		self.0.control(control, arg).map(wrap).map_err(err)
	}

	/// A control given a pattern.
	pub fn control_pattern(&self, name: &str, arg: &Handle) -> Result<Handle, JsError> {
		let control = Control::from_name(name).ok_or_else(|| JsError::new("not bound"))?;
		self.0
			.control(control, ControlArg::Pattern(arg.0.clone()))
			.map(wrap)
			.map_err(err)
	}

	pub fn with_sound(&self, t: &str) -> Handle {
		wrap(self.0.with_sound(t))
	}

	pub fn with_s(&self, t: &str) -> Handle {
		wrap(self.0.with_s(t))
	}

	pub fn with_bank(&self, t: &str) -> Handle {
		wrap(self.0.with_bank(t))
	}

	pub fn with_orbit(&self, n: f64) -> Result<Handle, JsError> {
		self.0.with_orbit(n).map(wrap).map_err(err)
	}

	pub fn with_cut(&self, n: f64) -> Result<Handle, JsError> {
		self.0.with_cut(n).map(wrap).map_err(err)
	}

	pub fn with_panlaw(&self, db: f64) -> Result<Handle, JsError> {
		self.0.with_panlaw(db).map(wrap).map_err(err)
	}

	pub fn scale(&self, spec: &str) -> Result<Handle, JsError> {
		self.0.scale(spec).map(wrap).map_err(err)
	}

	pub fn jux_with(&self, transformed: &Handle) -> Result<Handle, JsError> {
		self.0.jux(&transformed.0).map(wrap).map_err(err)
	}
}

/// `noteToMidi(name)`.
#[wasm_bindgen]
pub fn note_to_midi_js(name: &str) -> Result<f64, JsError> {
	control::note_to_midi(name).map_err(err)
}

/// `midiToFrequency(midi)`.
#[wasm_bindgen]
pub fn midi_to_frequency_js(midi: f64) -> f64 {
	control::midi_to_frequency(midi)
}

/// `noteToFrequency(pitch)`: a number passes through as Hz when finite and above zero, a string is a note name.
#[wasm_bindgen]
pub fn note_to_frequency_js(pitch: JsValue) -> Result<f64, JsError> {
	if let Some(hz) = pitch.as_f64() {
		if !hz.is_finite() || hz <= 0.0 {
			return Err(JsError::new(&format!(
				"Invalid frequency: {}",
				undertone_pattern::js::number_to_string(hz)
			)));
		}
		return Ok(hz);
	}
	let name = pitch.as_string().unwrap_or_default();
	control::note_to_midi(&name)
		.map(control::midi_to_frequency)
		.map_err(err)
}
