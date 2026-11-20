// renderVoices, ContextRender, and encodeWav: what the render module does with the voices the main module collected
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The render module's exports. Every render starts from the voices the main module collected (`collectVoices`, as
//! `[Float64Array, string[]]`, [`crate::flat`]) and the render options they were collected with; the plan is made again
//! here from the same options ([`RenderPlan::new`], which the main module already ran, so it cannot fail differently).

use std::collections::VecDeque;

use js_sys::{Array, Float32Array, Float64Array, Object, Reflect, Uint8Array};
use undertone::engine::engine::Engine;
use undertone::engine::render::{RenderPlan, pending_voices};
use undertone::engine::wav::{BitDepth, WavOptions, encode_wav as encode};
use undertone::engine::window::{BookingWindow, PendingVoice};
use wasm_bindgen::prelude::*;

use crate::convert::{error, rust_error};
use crate::options::{field, flag, number, render_options, seed};
use crate::record::RecordGraph;
use crate::samples::with_registry;

fn plan_and_voices(
	numbers: &Float64Array,
	strings: Vec<String>,
	options: &JsValue,
) -> Result<(RenderPlan, Vec<PendingVoice>), JsValue> {
	let plan = RenderPlan::new(&render_options(options)).map_err(rust_error)?;
	let values = crate::flat::decode(&numbers.to_vec(), &strings).map_err(|m| error(&m))?;
	Ok((plan, pending_voices(values)))
}

fn set(object: &Object, key: &str, value: &JsValue) {
	let _ = Reflect::set(object, &JsValue::from_str(key), value);
}

fn channels_out(channels: &[Vec<f32>]) -> Array {
	channels
		.iter()
		.map(|channel| JsValue::from(Float32Array::from(channel.as_slice())))
		.collect()
}

/// Prints the engine's warnings from `from` on: a sample warning each time (the registry keeps its own once-only set),
/// the others once per key per instance.
fn print_warnings<G: undertone::engine::graph::Graph>(engine: &Engine<G>, from: usize) -> usize {
	for warning in &engine.warnings()[from..] {
		if warning.key.starts_with("sample:") {
			crate::warnings::print(&warning.message);
		} else {
			crate::warnings::warn_once(&warning.key, &warning.message);
		}
	}
	engine.warnings().len()
}

/// `renderToBuffer`'s render (D-14): the voices booked and rendered offline in this module, `{ sampleRate, channels }`
/// with one `Float32Array` per channel, a `wrap` render's tail already folded. The samples the voices play are the ones
/// registered in this module.
#[wasm_bindgen(js_name = renderVoices)]
pub fn render_voices(
	numbers: &Float64Array,
	strings: Vec<String>,
	options: JsValue,
) -> Result<Object, JsValue> {
	let (plan, voices) = plan_and_voices(numbers, strings, &options)?;
	let samples = with_registry(|samples| samples.clone());
	let rendered = undertone::render_voices(&plan, samples, voices).map_err(rust_error)?;
	let out = Object::new();
	set(
		&out,
		"sampleRate",
		&JsValue::from_f64(rendered.sample_rate()),
	);
	set(&out, "channels", &channels_out(rendered.channels()));
	Ok(out)
}

/// The same voices booked on a recorder for the caller's `OfflineAudioContext` (`renderToBuffer(pattern, { context })`).
///
/// The wrapper makes the context with `numberOfChannels: channels`, `length`, and `sampleRate`, replays [`take`]
/// after the constructor (the master bus and the widened destination), and then, for each time of [`pauses`] in
/// order: for `0`, at once; for a later time, after `ctx.suspend(time)` resolved; it calls [`book_window`], replays
/// [`take`], and resumes. After `startRendering()` it passes the channels through [`finish`].
///
/// [`take`]: WasmContextRender::take
/// [`pauses`]: WasmContextRender::pauses
/// [`book_window`]: WasmContextRender::book_window
/// [`finish`]: WasmContextRender::finish
#[wasm_bindgen(js_name = ContextRender)]
pub struct WasmContextRender {
	plan: RenderPlan,
	engine: Engine<RecordGraph>,
	windows: VecDeque<BookingWindow>,
	warned: usize,
}

#[wasm_bindgen(js_class = ContextRender)]
impl WasmContextRender {
	/// Plans the render and makes its engine: the destination widened for more than two channels, the master bus, the
	/// seed, as `renderToBuffer` prepares its context; the windows are planned with this module's samples.
	#[wasm_bindgen(constructor)]
	pub fn new(
		numbers: &Float64Array,
		strings: Vec<String>,
		options: JsValue,
	) -> Result<WasmContextRender, JsValue> {
		let (plan, voices) = plan_and_voices(numbers, strings, &options)?;
		let graph = RecordGraph::new(plan.sample_rate, plan.channels, plan.channels);
		let mut engine = Engine::new(graph, plan.output_setup()).map_err(rust_error)?;
		let windows = with_registry(|samples| {
			std::mem::swap(engine.samples_mut(), samples);
			let windows = plan.booking_windows(&engine, voices);
			std::mem::swap(engine.samples_mut(), samples);
			windows
		});
		let warned = print_warnings(&engine, 0);
		Ok(WasmContextRender {
			plan,
			engine,
			windows: windows.into(),
			warned,
		})
	}

	/// The render's sample rate.
	#[wasm_bindgen(getter, js_name = sampleRate)]
	pub fn sample_rate(&self) -> f64 {
		self.plan.sample_rate
	}

	/// The render's channels.
	#[wasm_bindgen(getter)]
	pub fn channels(&self) -> u32 {
		self.plan.channels
	}

	/// The render's length in frames, the tail included.
	#[wasm_bindgen(getter)]
	pub fn length(&self) -> f64 {
		self.plan.length as f64
	}

	/// The times the context pauses at to book the windows, in order; the first is `0` (no pause: booked before the
	/// render starts). One `0` without a booking window.
	pub fn pauses(&self) -> Vec<f64> {
		self.windows
			.iter()
			.map(|window| window.suspend_at)
			.collect()
	}

	/// Books the next window at `now` (the pause's time); `false` when none is left. A voice that fails throws its
	/// message, and the voices before it stay booked, as in the reference.
	#[wasm_bindgen(js_name = bookWindow)]
	pub fn book_window(&mut self, now: f64) -> Result<bool, JsValue> {
		let Some(window) = self.windows.pop_front() else {
			return Ok(false);
		};
		self.engine.graph_mut().set_current_time(now);
		let engine = &mut self.engine;
		let booked = with_registry(|samples| {
			std::mem::swap(engine.samples_mut(), samples);
			let mut booked = Ok(());
			for voice in &window.voices {
				if let Err(failure) = engine.play(&voice.params, voice.start_time) {
					booked = Err(failure);
					break;
				}
			}
			std::mem::swap(engine.samples_mut(), samples);
			booked
		});
		self.warned = print_warnings(&self.engine, self.warned);
		booked.map(|()| true).map_err(rust_error)
	}

	/// The records made since the last call and their side data, `[Float64Array, Float32Array]`, as the main module's
	/// engine gives them.
	pub fn take(&mut self) -> Array {
		let taken = self.engine.graph_mut().take();
		Array::of2(
			&Float64Array::from(taken.ops.as_slice()),
			&Float32Array::from(taken.data.as_slice()),
		)
	}

	/// The rendered channels as the render returns them: unchanged, or for `wrap` with a tail folded onto the start and
	/// held to the master `ceiling`.
	pub fn finish(&self, channels: Vec<Float32Array>) -> Array {
		let rendered: Vec<Vec<f32>> = channels.iter().map(Float32Array::to_vec).collect();
		channels_out(&self.plan.finish(rendered))
	}
}

/// `encodeWav(source, options)` on the source's channels: WAV bytes, `{ bitDepth, dither, seed, channelMask }` as the
/// reference reads them. A `bitDepth` other than 16, 24, or 32 is refused (the reference's type allows only those).
#[wasm_bindgen(js_name = encodeWav)]
pub fn encode_wav(
	sample_rate: f64,
	channels: Vec<Float32Array>,
	options: JsValue,
) -> Result<Uint8Array, JsValue> {
	let bit_depth = match number(&field(&options, "bitDepth")) {
		None => BitDepth::Sixteen,
		Some(16.0) => BitDepth::Sixteen,
		Some(24.0) => BitDepth::TwentyFour,
		Some(32.0) => BitDepth::ThirtyTwo,
		Some(other) => {
			return Err(error(&format!(
				"encodeWav: bitDepth must be 16, 24 or 32, got {}",
				undertone::pattern::js::number_to_string(other)
			)));
		}
	};
	let seed_value = field(&options, "seed");
	let options = WavOptions {
		bit_depth,
		dither: flag(&field(&options, "dither")),
		seed: (!seed_value.is_undefined()).then(|| seed(&seed_value)),
		channel_mask: number(&field(&options, "channelMask")).map(|mask| mask as u32),
	};
	let channels: Vec<Vec<f32>> = channels.iter().map(Float32Array::to_vec).collect();
	encode(sample_rate, &channels, &options)
		.map(|bytes| Uint8Array::from(bytes.as_slice()))
		.map_err(rust_error)
}
