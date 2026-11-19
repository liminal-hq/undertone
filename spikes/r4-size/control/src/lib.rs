// Throwaway spike R4 control module: R2's binding grown to the whole API, stubbed, to measure size
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The control module of spike R4 (RF-11). It is R2's binding (a `Handle` around `Pattern<Value>`, the
//! two host-function escape hatches) plus: every constructor and combinator the pattern crate has today
//! exported, the 53 control methods of `API-MAPPING.md` stubbed through (each records the call into the
//! pattern tree and does nothing else), the engine crate linked and its maths exported, and, behind
//! features, `VoiceParams`-sized data crossing through `serde-wasm-bindgen` (planned) or `serde_json`
//! (the comparison). The point is the size of the glue and the code, not behaviour.

use std::sync::Arc;

use js_sys::{Array, Float64Array, Function};
use undertone_pattern::control::{
	Control, ControlArg, n, n_degree, n_pattern, note, note_hz, s as s_ctor, sound,
};
use undertone_pattern::random::Seed;
use undertone_pattern::signal;
use undertone_pattern::{
	CustomQuery, ForeignFn, Fraction, Hap, Pattern, Span, Value, arrange, cat, pure, seq, silence,
	stack, timecat,
};
use wasm_bindgen::prelude::*;

/// A JavaScript function the tree may call; wasm is single-threaded.
struct HostFn(Function, u64);
unsafe impl Send for HostFn {}
unsafe impl Sync for HostFn {}

impl ForeignFn<Value> for HostFn {
	fn call(&self, value: &Value) -> Value {
		let arg = JsValue::from_f64(value.as_number().unwrap_or(f64::NAN));
		let out = self
			.0
			.call1(&JsValue::NULL, &arg)
			.unwrap_or(JsValue::from_f64(f64::NAN));
		Value::Num(out.as_f64().unwrap_or(f64::NAN))
	}
	fn id(&self) -> u64 {
		self.1
	}
}

impl CustomQuery<Value> for HostFn {
	fn query(&self, span: Span) -> Vec<Hap<Value>> {
		let b = JsValue::from_f64(span.begin.to_f64());
		let e = JsValue::from_f64(span.end.to_f64());
		let out = self
			.0
			.call2(&JsValue::NULL, &b, &e)
			.unwrap_or(JsValue::NULL);
		Array::from(&out)
			.iter()
			.map(|row| {
				let row = Float64Array::new(&row).to_vec();
				Hap {
					whole: None,
					part: Span::new(
						Fraction::from_f64(row[0]).unwrap_or(Fraction::from_int(0)),
						Fraction::from_f64(row[1]).unwrap_or(Fraction::from_int(0)),
					),
					value: Value::Num(row[2]),
				}
			})
			.collect()
	}
	fn id(&self) -> u64 {
		self.1
	}
}

/// A pattern handle.
#[wasm_bindgen]
#[derive(Clone)]
pub struct Handle(Pattern<Value>);

fn wrap(p: Pattern<Value>) -> Handle {
	Handle(p)
}

fn err(e: undertone_pattern::Error) -> JsError {
	JsError::new(e.message())
}

fn handles(list: Vec<Handle>) -> Vec<Pattern<Value>> {
	list.into_iter().map(|h| h.0).collect()
}

/// `note("...")`.
#[wasm_bindgen]
pub fn note_handle(text: &str) -> Result<Handle, JsError> {
	note(text).map(wrap).map_err(err)
}

/// `note(hz)`.
#[wasm_bindgen]
pub fn note_hz_handle(hz: f64) -> Result<Handle, JsError> {
	note_hz(hz).map(wrap).map_err(err)
}

/// `sound("...")`.
#[wasm_bindgen]
pub fn sound_handle(text: &str) -> Result<Handle, JsError> {
	sound(text).map(wrap).map_err(err)
}

/// `s("...")`.
#[wasm_bindgen]
pub fn s_handle(text: &str) -> Result<Handle, JsError> {
	s_ctor(text).map(wrap).map_err(err)
}

/// `n("...")`.
#[wasm_bindgen]
pub fn n_handle(text: &str) -> Result<Handle, JsError> {
	n(text).map(wrap).map_err(err)
}

/// `n(degree)`.
#[wasm_bindgen]
pub fn n_degree_handle(degree: f64) -> Result<Handle, JsError> {
	n_degree(degree).map(wrap).map_err(err)
}

/// `n(pattern)`.
#[wasm_bindgen]
pub fn n_pattern_handle(p: &Handle) -> Result<Handle, JsError> {
	n_pattern(&p.0).map(wrap).map_err(err)
}

/// `pure(number)`.
#[wasm_bindgen]
pub fn pure_handle(v: f64) -> Handle {
	wrap(pure(Value::Num(v)))
}

/// `silence`.
#[wasm_bindgen]
pub fn silence_handle() -> Handle {
	wrap(silence())
}

/// `stack(...)`.
#[wasm_bindgen]
pub fn stack_handle(list: Vec<Handle>) -> Handle {
	wrap(stack(handles(list)))
}

/// `seq(...)`.
#[wasm_bindgen]
pub fn seq_handle(list: Vec<Handle>) -> Handle {
	wrap(seq(handles(list)))
}

/// `cat(...)`.
#[wasm_bindgen]
pub fn cat_handle(list: Vec<Handle>) -> Handle {
	wrap(cat(handles(list)))
}

/// `timecat([[weight, pattern], ...])`.
#[wasm_bindgen]
pub fn timecat_handle(weights: Vec<f64>, list: Vec<Handle>) -> Result<Handle, JsError> {
	let pairs = weights.into_iter().zip(handles(list)).collect();
	timecat(pairs).map(wrap).map_err(err)
}

/// `arrange([cycles, pattern], ...)`.
#[wasm_bindgen]
pub fn arrange_handle(cycles: Vec<f64>, list: Vec<Handle>) -> Result<Handle, JsError> {
	let sections = cycles.into_iter().zip(handles(list)).collect();
	arrange(sections).map(wrap).map_err(err)
}

/// `new Pattern(query)`: a pattern defined by a JavaScript query function.
#[wasm_bindgen]
pub fn custom_handle(query: Function, id: u32) -> Handle {
	wrap(Pattern::custom(Arc::new(HostFn(query, id as u64))))
}

/// A signal by name (`sine`, `saw2`, `rand`, `perlin`, `brand`, ...).
#[cfg(feature = "signals")]
#[wasm_bindgen]
pub fn signal_handle(name: &str) -> Option<Handle> {
	signal::by_name::<Value>(name).map(wrap)
}

/// `irand(n)`.
#[cfg(feature = "signals")]
#[wasm_bindgen]
pub fn irand_handle(n: f64) -> Result<Handle, JsError> {
	signal::irand::<Value>(n).map(wrap).map_err(err)
}

/// `brandBy(p)`.
#[cfg(feature = "signals")]
#[wasm_bindgen]
pub fn brand_by_handle(p: f64) -> Result<Handle, JsError> {
	signal::brand_by::<Value>(p).map(wrap).map_err(err)
}

/// `choose([...])` of numbers.
#[cfg(feature = "signals")]
#[wasm_bindgen]
pub fn choose_handle(values: Vec<f64>) -> Result<Handle, JsError> {
	signal::choose(values.into_iter().map(Value::Num).collect())
		.map(wrap)
		.map_err(err)
}

/// Turns a JavaScript value (number, string, or `Handle`) into a control argument.
fn control_arg(v: &JsValue) -> Result<ControlArg, JsError> {
	if let Some(x) = v.as_f64() {
		return Ok(ControlArg::Number(x));
	}
	if let Some(text) = v.as_string() {
		return Ok(ControlArg::Text(text));
	}
	let ptr = js_sys::Reflect::get(v, &JsValue::from_str("__wbg_ptr"))
		.map_err(|_| JsError::new("a control takes a number, a string, or a pattern"))?;
	if ptr.as_f64().is_none() {
		return Err(JsError::new(
			"a control takes a number, a string, or a pattern",
		));
	}
	let handle = <Handle as wasm_bindgen::convert::TryFromJsValue>::try_from_js_value_ref(v)
		.ok_or_else(|| JsError::new("a control takes a number, a string, or a pattern"))?;
	Ok(ControlArg::Pattern(handle.0))
}

#[wasm_bindgen]
impl Handle {
	/// `rev()`.
	pub fn rev(&self) -> Handle {
		wrap(self.0.rev())
	}

	/// `fast(factor)`.
	pub fn fast(&self, factor: f64) -> Result<Handle, JsError> {
		self.0.fast(factor).map(wrap).map_err(err)
	}

	/// `slow(factor)`.
	pub fn slow(&self, factor: f64) -> Result<Handle, JsError> {
		self.0.slow(factor).map(wrap).map_err(err)
	}

	/// `euclid(pulses, steps, rotation)`.
	pub fn euclid(&self, pulses: f64, steps: f64, rotation: f64) -> Result<Handle, JsError> {
		self.0
			.euclid(pulses, steps, rotation)
			.map(wrap)
			.map_err(err)
	}

	/// `every(n, fn)` after the wrapper ran `fn`.
	pub fn every_with(&self, n: f64, transformed: &Handle) -> Result<Handle, JsError> {
		self.0
			.every(n, |_| transformed.0.clone())
			.map(wrap)
			.map_err(err)
	}

	/// `jux(fn)` after the wrapper ran `fn`.
	pub fn jux_with(&self, transformed: &Handle) -> Result<Handle, JsError> {
		self.0.jux(&transformed.0).map(wrap).map_err(err)
	}

	/// `fmap(fn)` as a foreign leaf.
	pub fn fmap_foreign(&self, f: Function, id: u32) -> Handle {
		wrap(self.0.foreign_map(Arc::new(HostFn(f, id as u64))))
	}

	/// `segment(count)`.
	pub fn segment(&self, count: f64) -> Result<Handle, JsError> {
		self.0.segment(count).map(wrap).map_err(err)
	}

	/// `range(lo, hi)`.
	pub fn range(&self, lo: f64, hi: f64) -> Handle {
		wrap(self.0.range(lo, hi))
	}

	/// `range2(lo, hi)`.
	pub fn range2(&self, lo: f64, hi: f64) -> Handle {
		wrap(self.0.range2(lo, hi))
	}

	/// `rangex(lo, hi)`.
	pub fn rangex(&self, lo: f64, hi: f64) -> Result<Handle, JsError> {
		self.0.rangex(lo, hi).map(wrap).map_err(err)
	}

	/// `round()`.
	pub fn round(&self) -> Handle {
		wrap(self.0.round())
	}

	/// `floor()`.
	pub fn floor(&self) -> Handle {
		wrap(self.0.floor())
	}

	/// `add(other)`, `sub`, `mul`, `div` by an operation number 0 to 3.
	pub fn arith(&self, op: u8, other: &Handle) -> Handle {
		use undertone_pattern::ArithOp;
		let op = match op {
			0 => ArithOp::Add,
			1 => ArithOp::Sub,
			2 => ArithOp::Mul,
			_ => ArithOp::Div,
		};
		wrap(self.0.arith(op, &other.0))
	}

	/// `.seed(n)`.
	#[cfg(feature = "signals")]
	pub fn seed(&self, seed: f64) -> Result<Handle, JsError> {
		self.0.seed(Seed::Num(seed)).map(wrap).map_err(err)
	}

	/// `.seed("text")`.
	#[cfg(feature = "signals")]
	pub fn seed_text(&self, seed: &str) -> Result<Handle, JsError> {
		self.0.seed(Seed::Str(seed.into())).map(wrap).map_err(err)
	}

	/// `.scale(spec)`.
	#[cfg(feature = "scales")]
	pub fn scale(&self, spec: &str) -> Result<Handle, JsError> {
		self.0.scale(spec).map(wrap).map_err(err)
	}

	/// `.s(name)`.
	pub fn s(&self, name: &str) -> Handle {
		wrap(self.0.with_s(name))
	}

	/// `.bank(name)`.
	pub fn bank(&self, name: &str) -> Handle {
		wrap(self.0.with_bank(name))
	}

	/// `.sound(type)`.
	pub fn sound(&self, sound_type: &str) -> Handle {
		wrap(self.0.with_sound(sound_type))
	}

	/// The haps of cycles `from..to`, flat.
	pub fn query(&self, from: f64, to: f64) -> Vec<f64> {
		let span = Span::new(
			Fraction::from_int(from as i128),
			Fraction::from_int(to as i128),
		);
		let haps = self.0.query(span);
		let mut flat = Vec::with_capacity(haps.len() * 5);
		for hap in &haps {
			flat.push(hap.part.begin.to_f64());
			flat.push(hap.part.end.to_f64());
			flat.push(hap.whole.map_or(f64::NAN, |w| w.begin.to_f64()));
			flat.push(hap.whole.map_or(f64::NAN, |w| w.end.to_f64()));
			flat.push(hap.value.as_number().unwrap_or(f64::NAN));
		}
		flat
	}

	/// The tree as an s-expression.
	pub fn describe(&self) -> String {
		self.0.to_string()
	}

	/// The tree's structural hash.
	pub fn hash(&self) -> f64 {
		self.0.structural_hash() as f64
	}
}

// The stub every control method calls: it records the call into the tree (a control node, then a
// bank node carrying the method's name so each stub is distinct) and does nothing else.
impl Handle {
	fn record(&self, name: &'static str, v: &JsValue) -> Result<Handle, JsError> {
		let arg = control_arg(v)?;
		let next = self.0.control(Control::Gain, arg).map_err(err)?;
		Ok(wrap(next.with_bank(name)))
	}
}

// The table-driven shape: three exports for every control, the name resolved in TypeScript to an
// index that Rust resolves to a `Control`. The bridge's generated methods would call these.
#[wasm_bindgen]
impl Handle {
	/// A control by table index, given a number.
	pub fn control_number(&self, index: u32, v: f64) -> Result<Handle, JsError> {
		self.record(
			CONTROL_NAMES[(index as usize) % CONTROL_NAMES.len()],
			&JsValue::from_f64(v),
		)
	}

	/// A control by table index, given a mini-notation string.
	pub fn control_text(&self, index: u32, v: &str) -> Result<Handle, JsError> {
		self.record(
			CONTROL_NAMES[(index as usize) % CONTROL_NAMES.len()],
			&JsValue::from_str(v),
		)
	}

	/// A control by table index, given a pattern.
	pub fn control_pattern(&self, index: u32, v: &Handle) -> Result<Handle, JsError> {
		let next = self
			.0
			.control(Control::Gain, ControlArg::Pattern(v.0.clone()))
			.map_err(err)?;
		Ok(wrap(next.with_bank(
			CONTROL_NAMES[(index as usize) % CONTROL_NAMES.len()],
		)))
	}
}

macro_rules! controls {
	($(($id:ident, $js:literal)),* $(,)?) => {
		/// The 50 control names of `API-MAPPING.md` (the table the bridge and the name-map test share).
		pub const CONTROL_NAMES: &[&str] = &[$($js),*];

		/// One named export per control: the "every method is a wasm-bindgen export" shape.
		#[cfg(feature = "named-controls")]
		#[wasm_bindgen]
		impl Handle {
			$(
				#[wasm_bindgen(js_name = $js)]
				#[allow(missing_docs)]
				pub fn $id(&self, v: JsValue) -> Result<Handle, JsError> {
					self.record($js, &v)
				}
			)*
		}
	};
}

controls! {
	(attack, "attack"), (decay, "decay"), (sustain, "sustain"), (release, "release"),
	(gain, "gain"), (velocity, "velocity"), (duration, "duration"), (legato, "legato"),
	(lpf, "lpf"), (lpenv, "lpenv"), (lpa, "lpa"), (lpd, "lpd"), (lps, "lps"), (lpr, "lpr"),
	(hpf, "hpf"), (phaser, "phaser"), (slide, "slide"), (penv, "penv"), (pattack, "pattack"),
	(pdecay, "pdecay"), (pitchsteps, "pitchsteps"), (fm, "fm"), (fmi, "fmi"), (fmh, "fmh"),
	(fmattack, "fmattack"), (fmdecay, "fmdecay"), (fmsustain, "fmsustain"), (fmrelease, "fmrelease"),
	(fmenv, "fmenv"), (fmwave, "fmwave"), (nudge, "nudge"), (late, "late"), (early, "early"),
	(cut, "cut"), (pan, "pan"), (panslide, "panslide"), (panpath, "panpath"), (panlaw, "panlaw"),
	(autopan, "autopan"), (autopandepth, "autopandepth"), (autopanshape, "autopanshape"),
	(autopanphase, "autopanphase"), (room, "room"), (roomsize, "roomsize"), (delay, "delay"),
	(delaytime, "delaytime"), (delayfeedback, "delayfeedback"), (orbit, "orbit"),
	(channels, "channels"), (surround, "surround"),
}

/// The engine crate linked: its maths tables exported (the voice graph is not built yet).
#[cfg(feature = "engine")]
mod engine {
	use undertone_engine::math::Libm;
	use undertone_engine::math::gains::{pan_law_gains, pan_law_scale, surround_gains};
	use undertone_engine::math::waves::{
		LfoShape, ShapedWave, autopan_wave_table, shaped_wave_table,
	};
	use wasm_bindgen::prelude::*;

	/// A shaped wave's coefficients, real then imaginary.
	#[wasm_bindgen]
	pub fn shaped_wave(kind: u8) -> Vec<f32> {
		let wave = match kind {
			0 => ShapedWave::HalfSine,
			1 => ShapedWave::AbsSine,
			_ => ShapedWave::PulseSine,
		};
		let t = shaped_wave_table::<Libm>(wave);
		[t.real, t.imag].concat()
	}

	/// An autopan LFO's coefficients, real then imaginary.
	#[wasm_bindgen]
	pub fn autopan_wave(kind: u8, phase: f64) -> Vec<f32> {
		let shape = match kind {
			0 => LfoShape::Sine,
			1 => LfoShape::Triangle,
			_ => LfoShape::Square,
		};
		let t = autopan_wave_table::<Libm>(shape, phase);
		[t.real, t.imag].concat()
	}

	/// The left and right gains of a pan under a law.
	#[wasm_bindgen]
	pub fn pan_gains(pan: f64, law: f64) -> Vec<f64> {
		let g = pan_law_gains::<Libm>(pan, law);
		vec![g.left, g.right, pan_law_scale::<Libm>(law)]
	}

	/// The 7.1 gains for an angle.
	#[wasm_bindgen]
	pub fn surround(angle: f64) -> Result<Vec<f64>, JsError> {
		surround_gains::<Libm>(angle)
			.map(|g| g.to_vec())
			.map_err(|_| JsError::new("angle must be finite"))
	}
}

/// `VoiceParams`-sized data (about 65 optional fields, camelCase) for the serde experiments.
#[cfg(any(feature = "serde-params", feature = "json-params"))]
mod params {
	use serde::{Deserialize, Serialize};

	macro_rules! voice_params {
		($($field:ident),* $(,)?) => {
			/// A stand-in with the field count of `VoiceParams`.
			#[derive(Serialize, Deserialize, Default, Clone)]
			#[serde(rename_all = "camelCase", default)]
			pub struct VoiceParams {
				pub sound_type: Option<String>,
				pub sample_name: Option<String>,
				pub sample_bank: Option<String>,
				pub channel_gains: Option<Vec<f64>>,
				pub pan_path: Option<Vec<(f64, f64)>>,
				pub filter_env_curve: Option<String>,
				pub fm_wave: Option<String>,
				pub autopan_shape: Option<String>,
				$(pub $field: Option<f64>,)*
			}
		};
	}

	voice_params! {
		frequency, attack, decay, sustain, release, gain_level, velocity, duration, legato,
		filter_cutoff, filter_env_amount, filter_attack, filter_decay, filter_sustain,
		filter_release, hpf_cutoff, phaser_rate, slide_time, pitch_env_amount, pitch_attack,
		pitch_decay, pitch_steps, pitch_step_rate, fm_index, fm_harmonicity, fm_attack, fm_decay,
		fm_sustain, fm_release, nudge_time, cut_group, pan, pan_slide_from, pan_slide_time,
		pan_law, autopan, autopan_depth, autopan_phase, room_level, room_size, delay_level,
		delay_time, delay_feedback, orbit, degree, detune, start_time, tail,
	}

	#[cfg(feature = "serde-params")]
	pub mod wasm {
		use super::VoiceParams;
		use wasm_bindgen::prelude::*;

		/// Reads a JavaScript object as `VoiceParams` and writes it back with `gainLevel` doubled.
		#[wasm_bindgen]
		pub fn resolve_params(v: JsValue) -> Result<JsValue, JsError> {
			let mut p: VoiceParams = serde_wasm_bindgen::from_value(v)?;
			p.gain_level = p.gain_level.map(|g| g * 2.0);
			Ok(serde_wasm_bindgen::to_value(&p)?)
		}
	}

	#[cfg(feature = "json-params")]
	pub mod json {
		use super::VoiceParams;
		use wasm_bindgen::prelude::*;

		/// The same through JSON text.
		#[wasm_bindgen]
		pub fn resolve_params_json(text: &str) -> Result<String, JsError> {
			let mut p: VoiceParams = serde_json::from_str(text)?;
			p.gain_level = p.gain_level.map(|g| g * 2.0);
			Ok(serde_json::to_string(&p)?)
		}
	}
}
