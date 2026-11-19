// Throwaway skeleton of the Rust side of the bridge for spike R3: patterns in Rust, booking calls out
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The skeleton's Rust half. **What is real:** the pattern and the query (`undertone-pattern`'s `note`),
//! the note-to-Hz conversion, and the pan-law maths (`undertone-engine`'s `libm` back-end).
//! **What is stubbed:** the engine. There is no `VoiceParams` resolver and no scheduler; `book` hand-writes
//! the booking of the five voices spike R3 compares (a plain voice, a filter envelope, the stereo panner,
//! a pan path, and a pan law), in the order the TypeScript engine calls Web Audio. The result is a flat
//! list of operations that the TypeScript side replays on the caller's `AudioContext`.

use js_sys::Reflect;
use undertone_engine::math;
use undertone_pattern::control::{midi_to_frequency, note, note_to_midi};
use undertone_pattern::{Fraction, Span, Value};
use wasm_bindgen::prelude::*;

/// Operation codes in the booking list. Each operation is six numbers: the code and five arguments.
mod op {
	/// `create(code, id, kind, inputs)`: kind 0 oscillator, 1 gain, 2 filter, 3 panner, 4 merger.
	pub const CREATE: f64 = 0.0;
	/// `set_type(code, id, type)`: an oscillator type index (sine, square, sawtooth, triangle).
	pub const SET_TYPE: f64 = 1.0;
	/// `set(code, id, time, value)` on the node's one automated parameter.
	pub const SET: f64 = 2.0;
	/// `lin(code, id, time, value)`: a linear ramp.
	pub const LIN: f64 = 3.0;
	/// `connect(code, from, to, output, input)`.
	pub const CONNECT: f64 = 4.0;
	/// `connect_destination(code, from)`.
	pub const DESTINATION: f64 = 5.0;
	/// `start(code, id, time)`.
	pub const START: f64 = 6.0;
	/// `stop(code, id, time)`.
	pub const STOP: f64 = 7.0;
}

const OSC: f64 = 0.0;
const GAIN: f64 = 1.0;
const FILTER: f64 = 2.0;
const PANNER: f64 = 3.0;
const MERGER: f64 = 4.0;
const STOP_TAIL_SECONDS: f64 = 0.02;

/// A pattern handle, as in spike R2.
#[wasm_bindgen]
pub struct Pattern(undertone_pattern::Pattern<Value>);

/// `note("...")`.
#[wasm_bindgen]
pub fn note_pattern(text: &str) -> Result<Pattern, JsError> {
	note(text)
		.map(Pattern)
		.map_err(|e| JsError::new(e.message()))
}

/// The voice settings of one program: the defaults of the TypeScript `resolveParams`, then the patch.
struct Params {
	sound: u8,
	pitch_hz: f64,
	gain_level: f64,
	attack: f64,
	decay: f64,
	sustain: f64,
	release: f64,
	duration: f64,
	filter_cutoff: Option<f64>,
	filter_env: f64,
	filter_decay: f64,
	pan: Option<f64>,
	pan_path: Option<Vec<(f64, f64)>>,
	pan_law: Option<f64>,
}

fn number(patch: &JsValue, key: &str) -> Option<f64> {
	Reflect::get(patch, &JsValue::from_str(key))
		.ok()
		.and_then(|v| v.as_f64())
}

fn clamp_pan(pan: f64) -> f64 {
	pan.clamp(-1.0, 1.0)
}

/// An envelope on a parameter, as `scheduleEnvelope` books it (linear ramps only).
fn envelope(
	out: &mut Vec<[f64; 6]>,
	id: f64,
	start: f64,
	base: f64,
	peak: f64,
	shape: [f64; 4],
	gate_end: Option<f64>,
) -> f64 {
	let [attack, decay, sustain, release] = shape;
	let sustain_value = base + (peak - base) * sustain;
	out.push([op::SET, id, start, base, 0.0, 0.0]);
	let attack_end = start + attack;
	if attack > 0.0 {
		out.push([op::LIN, id, attack_end, peak, 0.0, 0.0]);
	} else {
		out.push([op::SET, id, start, peak, 0.0, 0.0]);
	}
	let decay_end = attack_end + decay;
	if decay > 0.0 {
		out.push([op::LIN, id, decay_end, sustain_value, 0.0, 0.0]);
	} else {
		out.push([op::SET, id, decay_end, sustain_value, 0.0, 0.0]);
	}
	let release_start = gate_end.map_or(decay_end, |g| decay_end.max(g));
	if release_start > decay_end {
		out.push([op::SET, id, release_start, sustain_value, 0.0, 0.0]);
	}
	let release_end = release_start + release;
	if release > 0.0 {
		out.push([op::LIN, id, release_end, base, 0.0, 0.0]);
	}
	release_end
}

/// Books one voice in the order the TypeScript `playVoice` calls Web Audio, so the nodes are numbered alike.
fn book_voice(p: &Params, start: f64, out: &mut Vec<[f64; 6]>, next: &mut f64) {
	let mut make = |out: &mut Vec<[f64; 6]>, kind: f64, inputs: f64| {
		let id = *next;
		*next += 1.0;
		out.push([op::CREATE, id, kind, inputs, 0.0, 0.0]);
		id
	};
	let gate_end = (p.sustain > 0.0).then_some(start + p.duration);
	let gain = make(out, GAIN, 0.0);
	let gain_end = envelope(
		out,
		gain,
		start,
		0.0,
		p.gain_level,
		[p.attack, p.decay, p.sustain, p.release],
		gate_end,
	);
	let mut filter_end = gain_end;
	let osc = make(out, OSC, 0.0);
	out.push([op::SET_TYPE, osc, f64::from(p.sound), 0.0, 0.0, 0.0]);
	out.push([op::SET, osc, start, p.pitch_hz, 0.0, 0.0]);
	let mut tail = osc;
	if let Some(cutoff) = p.filter_cutoff {
		let filter = make(out, FILTER, 0.0);
		filter_end = envelope(
			out,
			filter,
			start,
			cutoff,
			cutoff + p.filter_env,
			[0.0, p.filter_decay, 1.0, 0.0],
			gate_end,
		);
		out.push([op::CONNECT, tail, filter, 0.0, 0.0, 0.0]);
		tail = filter;
	}
	let voice_end = gain_end.max(filter_end) + STOP_TAIL_SECONDS;
	out.push([op::CONNECT, tail, gain, 0.0, 0.0, 0.0]);

	let panned = p.pan.is_some() || p.pan_path.is_some();
	let law = p
		.pan_law
		.filter(|l| l.is_finite() && *l != -3.0)
		.map(|l| l.clamp(-6.0, 0.0));
	if panned && let Some(law) = law {
		// A pan law other than the stereo panner's: one gain per side into a two-input merger (no path here).
		let merger = make(out, MERGER, 2.0);
		let left = make(out, GAIN, 0.0);
		let right = make(out, GAIN, 0.0);
		let angle = ((clamp_pan(p.pan.unwrap_or(0.0)) + 1.0) * core::f64::consts::PI) / 4.0;
		let scale = core::f64::consts::SQRT_2 * undertone_pattern::js::pow(10.0, law / 20.0);
		out.push([
			op::SET,
			left,
			start,
			(scale * math::cos(angle)).min(1.0),
			0.0,
			0.0,
		]);
		out.push([
			op::SET,
			right,
			start,
			(scale * math::sin(angle)).min(1.0),
			0.0,
			0.0,
		]);
		out.push([op::CONNECT, gain, left, 0.0, 0.0, 0.0]);
		out.push([op::CONNECT, gain, right, 0.0, 0.0, 0.0]);
		out.push([op::CONNECT, left, merger, 0.0, 0.0, 0.0]);
		out.push([op::CONNECT, right, merger, 0.0, 1.0, 0.0]);
		out.push([op::DESTINATION, merger, 0.0, 0.0, 0.0, 0.0]);
	} else if panned {
		let panner = make(out, PANNER, 0.0);
		if let Some(path) = &p.pan_path {
			let mut previous = 0.0_f64;
			for (index, (time, pan)) in path.iter().enumerate() {
				let offset = time.max(previous).max(0.0);
				let value = clamp_pan(*pan);
				if index == 0 {
					out.push([op::SET, panner, start, value, 0.0, 0.0]);
					if offset > 0.0 {
						out.push([op::SET, panner, start + offset, value, 0.0, 0.0]);
					}
				} else if offset == previous {
					out.push([op::SET, panner, start + offset, value, 0.0, 0.0]);
				} else {
					out.push([op::LIN, panner, start + offset, value, 0.0, 0.0]);
				}
				previous = offset;
			}
		} else {
			out.push([op::SET, panner, start, p.pan.unwrap_or(0.0), 0.0, 0.0]);
		}
		out.push([op::CONNECT, gain, panner, 0.0, 0.0, 0.0]);
		out.push([op::DESTINATION, panner, 0.0, 0.0, 0.0, 0.0]);
	} else {
		out.push([op::DESTINATION, gain, 0.0, 0.0, 0.0, 0.0]);
	}
	out.push([op::START, osc, start, 0.0, 0.0, 0.0]);
	out.push([op::STOP, osc, voice_end, 0.0, 0.0, 0.0]);
}

#[wasm_bindgen]
impl Pattern {
	/// Queries cycles `from..to`, turns each event with an onset into a voice (the stubbed resolver: the
	/// pitch comes from the pattern, the rest from `patch`), and returns the booking operations flat, six
	/// numbers each. `cycle_seconds` is the length of a cycle, `at` the context time of cycle 0.
	pub fn book(
		&self,
		patch: &JsValue,
		from: f64,
		to: f64,
		cycle_seconds: f64,
		at: f64,
	) -> Result<Vec<f64>, JsError> {
		let span = Span::new(
			Fraction::from_int(from as i128),
			Fraction::from_int(to as i128),
		);
		let sound = match Reflect::get(patch, &JsValue::from_str("soundType"))
			.ok()
			.and_then(|v| v.as_string())
			.as_deref()
		{
			None | Some("sine") => 0,
			Some("square") => 1,
			Some("sawtooth") => 2,
			Some("triangle") => 3,
			Some(other) => return Err(JsError::new(&format!("the skeleton has no sound {other}"))),
		};
		let pan_path = Reflect::get(patch, &JsValue::from_str("panPath"))
			.ok()
			.filter(|v| v.is_object())
			.map(|v| {
				js_sys::Array::from(&v)
					.iter()
					.map(|p| {
						(
							number(&p, "time").unwrap_or(0.0),
							number(&p, "pan").unwrap_or(0.0),
						)
					})
					.collect()
			});
		let mut out = Vec::new();
		let mut next = 1.0; // 0 is the destination
		for hap in self.0.query(span) {
			let Some(whole) = hap.whole else { continue };
			if !hap.has_onset() {
				continue;
			}
			let pitch_hz = match hap.value.get("pitch") {
				Some(Value::Str(name)) => {
					midi_to_frequency(note_to_midi(name).map_err(|e| JsError::new(e.message()))?)
				}
				Some(Value::Num(hz)) => *hz,
				_ => 440.0,
			};
			let params = Params {
				sound,
				pitch_hz,
				gain_level: number(patch, "gainLevel").unwrap_or(0.8),
				attack: number(patch, "attack").unwrap_or(0.01),
				decay: number(patch, "decay").unwrap_or(0.1),
				sustain: number(patch, "sustain").unwrap_or(0.0),
				release: number(patch, "release").unwrap_or(0.05),
				duration: (whole.end.to_f64() - whole.begin.to_f64()) * cycle_seconds,
				filter_cutoff: number(patch, "filterCutoff"),
				filter_env: number(patch, "filterEnvAmount").unwrap_or(0.0),
				filter_decay: number(patch, "filterDecay").unwrap_or(0.0),
				pan: number(patch, "pan"),
				pan_path: pan_path.clone(),
				pan_law: number(patch, "panLaw"),
			};
			let voice_at = (at + whole.begin.to_f64() * cycle_seconds).max(0.0);
			let mut ops = Vec::new();
			book_voice(&params, voice_at, &mut ops, &mut next);
			out.extend(ops);
		}
		Ok(out.into_iter().flatten().collect())
	}
}
