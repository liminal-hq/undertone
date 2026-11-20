// The engine's booking as exports: WasmEngine books voices on a RecordGraph whose records JavaScript replays
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`WasmEngine`]: one per audio context, the reference's per-context state (orbit buses, cut groups, the shared
//! waves, the seed, the buffers made from samples) around an `Engine<RecordGraph>`. Every call that books leaves its
//! Web Audio calls in the recorder; the wrapper takes them with [`WasmEngine::take`] and replays them on the context
//! (`packages/undertone/src/webaudio.ts`, RF-26), **also after a call that throws**, since the nodes a failing voice
//! made before the failure stay on the context in the reference too. The record format is [`crate::record`].
//!
//! The wrapper sets the context's clock before each call ([`WasmEngine::set_time`]) and names nodes by number: `0` is
//! the destination, a node the engine made has the number of its `create` record, and a node of the host's own (a
//! game's mix bus given as `output`) gets a number from [`WasmEngine::adopt`].
//!
//! Warnings the engine gives are printed through [`crate::warnings::warn_once`] when the call returns; a sample
//! warning is printed each time the registry gives it, since the registry keeps its own once-only set and forgets it
//! on `clearSamples()`, as the reference's `samples.ts` does.

use js_sys::{Array, Float32Array, Float64Array, Object, Reflect};
use undertone::engine::engine::{Engine, OutputSetup, Playback};
use undertone::engine::graph::{Graph, NodeId};
use undertone::engine::params::resolve_params;
use undertone::engine::surround::create_mono_fold;
use undertone::sched::PlaybackHandle;
use wasm_bindgen::prelude::*;

use crate::convert::{from_js, rust_error};
use crate::options::{master_options, seed};
use crate::record::{NAMES, RecordGraph};
use crate::samples::with_registry;
use crate::warnings::warn_once;

/// A playback: the voices one call booked, their window, and the means to stop them (the reference's
/// `PlaybackHandle`). Its `stop` takes the engine that booked it; a handle given another engine stops nothing.
#[wasm_bindgen]
pub struct WasmPlayback {
	start: f64,
	end: f64,
	voices: Voices,
}

enum Voices {
	Booked(Vec<Playback>),
	Played(PlaybackHandle),
}

impl WasmPlayback {
	/// The handle of voices booked one by one (`combineHandles`: one voice is its own window, none is `0` to `0`).
	pub(crate) fn booked(playbacks: Vec<Playback>) -> Self {
		let (start, end) = if playbacks.is_empty() {
			(0.0, 0.0)
		} else {
			playbacks
				.iter()
				.fold((f64::INFINITY, f64::NEG_INFINITY), |(s, e), p| {
					(s.min(p.start_time), e.max(p.end_time))
				})
		};
		Self {
			start,
			end,
			voices: Voices::Booked(playbacks),
		}
	}

	/// The handle of a transport's `play`.
	pub(crate) fn played(handle: PlaybackHandle) -> Self {
		Self {
			start: handle.start_time,
			end: handle.end_time,
			voices: Voices::Played(handle),
		}
	}
}

#[wasm_bindgen]
impl WasmPlayback {
	/// The earliest start of any voice, on the context's clock.
	#[wasm_bindgen(getter, js_name = startTime)]
	pub fn start_time(&self) -> f64 {
		self.start
	}

	/// The latest time any voice is still sounding, on the context's clock.
	#[wasm_bindgen(getter, js_name = endTime)]
	pub fn end_time(&self) -> f64 {
		self.end
	}

	/// How many voices the handle covers.
	#[wasm_bindgen(getter)]
	pub fn voices(&self) -> usize {
		match &self.voices {
			Voices::Booked(playbacks) => playbacks.len(),
			Voices::Played(handle) => handle.voices(),
		}
	}

	/// `stop(when?, { fade })`: stops every voice at `when` (default: the engine's clock now) with a fade (default 0.01 s).
	pub fn stop(&self, engine: &mut WasmEngine, when: Option<f64>, fade: Option<f64>) {
		match &self.voices {
			Voices::Booked(playbacks) => {
				for playback in playbacks {
					engine.engine.stop(*playback, when, fade);
				}
			}
			Voices::Played(handle) => handle.stop(&mut engine.engine, when, fade),
		}
	}
}

/// One audio context's engine, booking on a recorder. See the [module documentation](self).
#[wasm_bindgen]
pub struct WasmEngine {
	pub(crate) engine: Engine<RecordGraph>,
	/// How many of the engine's warnings have been printed.
	warned: usize,
}

impl WasmEngine {
	/// Wraps an engine.
	pub(crate) fn from_engine(engine: Engine<RecordGraph>) -> Self {
		Self { engine, warned: 0 }
	}

	/// Runs `run` on the engine with the instance's sample registry in it, then prints the warnings it gave.
	pub(crate) fn run<R>(&mut self, run: impl FnOnce(&mut Engine<RecordGraph>) -> R) -> R {
		let engine = &mut self.engine;
		let out = with_registry(|samples| {
			std::mem::swap(engine.samples_mut(), samples);
			let out = run(engine);
			std::mem::swap(engine.samples_mut(), samples);
			out
		});
		for warning in &self.engine.warnings()[self.warned..] {
			if warning.key.starts_with("sample:") {
				crate::warnings::print(&warning.message);
			} else {
				warn_once(&warning.key, &warning.message);
			}
		}
		self.warned = self.engine.warnings().len();
		out
	}

	/// An output node number, or the engine's output.
	pub(crate) fn output(&self, node: Option<f64>) -> NodeId {
		node.map_or_else(|| self.engine.output(), |node| NodeId::new(node as u32))
	}
}

/// A patch as resolved voice parameters (`resolveParams`; the identity on a complete `VoiceParams`).
fn voice(patch: &JsValue) -> Result<undertone::engine::params::VoiceParams, JsValue> {
	Ok(resolve_params(&from_js(patch)?))
}

#[wasm_bindgen]
impl WasmEngine {
	/// An engine for a context of `sampleRate` hertz whose destination has `channels` channels now and up to
	/// `maxChannels` (`ctx.destination.channelCount`, `.maxChannelCount`). Noise and reverb are seeded with `0` until
	/// [`WasmEngine::seed`] says otherwise (the reference uses `Math.random` on a context nobody seeded; Rust has no
	/// ambient source).
	#[wasm_bindgen(constructor)]
	pub fn new(sample_rate: f64, channels: u32, max_channels: u32) -> Result<WasmEngine, JsValue> {
		let graph = RecordGraph::new(sample_rate, channels, max_channels);
		let engine = Engine::new(graph, OutputSetup::default()).map_err(rust_error)?;
		Ok(WasmEngine::from_engine(engine))
	}

	/// Sets the context's clock (`ctx.currentTime`) for the calls that follow.
	#[wasm_bindgen(js_name = setTime)]
	pub fn set_time(&mut self, now: f64) {
		self.engine.graph_mut().set_current_time(now);
	}

	/// Tells the engine the destination's channel count, when the host changed it itself.
	#[wasm_bindgen(js_name = setDestinationChannels)]
	pub fn set_destination_channels(&mut self, channels: u32) {
		self.engine.graph_mut().set_destination_channels(channels);
	}

	/// A node number for a node of the host's own (an `output` the caller made); records nothing.
	pub fn adopt(&mut self) -> u32 {
		self.engine.graph_mut().adopt().index() as u32
	}

	/// The records made since the last call and their side data: `[Float64Array, Float32Array]`.
	pub fn take(&mut self) -> Array {
		let taken = self.engine.graph_mut().take();
		Array::of2(
			&Float64Array::from(taken.ops.as_slice()),
			&Float32Array::from(taken.data.as_slice()),
		)
	}

	/// `seedContext(ctx, seed)`: seeds this context's noise and reverb (a number or a string).
	#[wasm_bindgen(js_name = seed)]
	pub fn seed_js(&mut self, value: JsValue) {
		self.engine.set_seed(seed(&value));
	}

	/// `playVoice(ctx, params, startTime, { output })`: books one voice (a patch, resolved as `resolveParams` does).
	#[wasm_bindgen(js_name = playVoice)]
	pub fn play_voice(
		&mut self,
		patch: JsValue,
		start_time: f64,
		output: Option<f64>,
	) -> Result<WasmPlayback, JsValue> {
		let params = voice(&patch)?;
		let output = self.output(output);
		self.run(|engine| engine.play_to(output, &params, start_time))
			.map(|playback| WasmPlayback::booked(vec![playback]))
			.map_err(rust_error)
	}

	/// `playParams(ctx, voices, { when, output })` (and `playVoices`): books every patch at `when` (default: now), each
	/// offset by its own nudge. A voice that fails stops the call with its message; the ones before it stay booked, as
	/// in the reference.
	#[wasm_bindgen(js_name = playParams)]
	pub fn play_params(
		&mut self,
		patches: Array,
		when: Option<f64>,
		output: Option<f64>,
	) -> Result<WasmPlayback, JsValue> {
		let voices = patches
			.iter()
			.map(|patch| voice(&patch))
			.collect::<Result<Vec<_>, _>>()?;
		let output = self.output(output);
		let when = when.unwrap_or_else(|| self.engine.graph().current_time());
		self.run(|engine| {
			let mut playbacks = Vec::with_capacity(voices.len());
			for params in &voices {
				playbacks.push(engine.play_to(output, params, when)?);
			}
			Ok(playbacks)
		})
		.map(WasmPlayback::booked)
		.map_err(rust_error)
	}

	/// `isVoiceSkipped(ctx, params)`: whether booking the patch books nothing (a sample that is not available).
	#[wasm_bindgen(js_name = isVoiceSkipped)]
	pub fn is_voice_skipped(&mut self, patch: JsValue) -> Result<bool, JsValue> {
		let params = voice(&patch)?;
		Ok(self.run(|engine| engine.is_voice_skipped(&params)))
	}

	/// `createMasterBus(ctx, options)`: `{ input, compressor?, clipper? }` as node numbers.
	#[wasm_bindgen(js_name = createMasterBus)]
	pub fn create_master_bus(&mut self, options: JsValue) -> Result<Object, JsValue> {
		let options = master_options(&options);
		let bus = self
			.run(|engine| engine.create_master_bus(options))
			.map_err(rust_error)?;
		let out = Object::new();
		let set = |key: &str, node: Option<NodeId>| {
			if let Some(node) = node {
				let _ = Reflect::set(
					&out,
					&JsValue::from_str(key),
					&JsValue::from(node.index() as u32),
				);
			}
		};
		set("input", Some(bus.input));
		set("compressor", bus.compressor);
		set("clipper", bus.clipper);
		Ok(out)
	}

	/// `createMonoFold(ctx, output?)`: the fold's node number.
	#[wasm_bindgen(js_name = createMonoFold)]
	pub fn create_mono_fold(&mut self, output: Option<f64>) -> u32 {
		let output = self.output(output);
		create_mono_fold(self.engine.graph_mut(), output).index() as u32
	}

	/// `enableMultichannel(ctx)`: widens the destination to its hardware channels; returns the count afterwards.
	#[wasm_bindgen(js_name = enableMultichannel)]
	pub fn enable_multichannel(&mut self) -> u32 {
		self.engine.enable_multichannel()
	}

	/// `getOrbitBus(ctx, orbit, output?)`: `[reverbInput, delayInput]` as node numbers, made on first use.
	#[wasm_bindgen(js_name = getOrbitBus)]
	pub fn get_orbit_bus(&mut self, orbit: f64, output: Option<f64>) -> Vec<u32> {
		let output = self.output(output);
		let bus = self.engine.orbit_bus(orbit, Some(output));
		vec![
			bus.reverb_input.index() as u32,
			bus.delay_input.index() as u32,
		]
	}

	/// The orbit bus's `setRoomSize(size)`: regenerates its impulse response when the size differs.
	#[wasm_bindgen(js_name = setRoomSize)]
	pub fn set_room_size(
		&mut self,
		orbit: f64,
		output: Option<f64>,
		size: f64,
	) -> Result<(), JsValue> {
		let output = self.output(output);
		self.engine
			.set_orbit_room_size(orbit, Some(output), size)
			.map_err(rust_error)
	}

	/// The orbit bus's `setDelay(time, feedback, when?)`: from `when` (default: now).
	#[wasm_bindgen(js_name = setDelay)]
	pub fn set_delay(
		&mut self,
		orbit: f64,
		output: Option<f64>,
		time: f64,
		feedback: f64,
		when: Option<f64>,
	) {
		let output = self.output(output);
		let now = self.engine.graph().current_time();
		if let Some(when) = when {
			self.engine.graph_mut().set_current_time(when);
		}
		self.engine
			.set_orbit_delay(orbit, Some(output), time, feedback);
		self.engine.graph_mut().set_current_time(now);
	}

	/// `buildImpulseResponse(ctx, seconds, random)` with a seeded source: the buffer's number. `seed` is a number or a
	/// string (the reference takes a random function, which cannot cross; the wrapper passes `seededRandom`'s seed).
	#[wasm_bindgen(js_name = buildImpulseResponse)]
	pub fn build_impulse_response(
		&mut self,
		seconds: f64,
		random_seed: JsValue,
	) -> Result<u32, JsValue> {
		let mut random = undertone::pattern::random::SeededRandom::from_seed(&seed(&random_seed));
		undertone::engine::effects::build_impulse_response(
			self.engine.graph_mut(),
			seconds,
			&mut random,
		)
		.map(|buffer| buffer.index() as u32)
		.map_err(rust_error)
	}

	/// How many booked voices the engine still tracks (for tests of long sessions).
	#[wasm_bindgen(getter, js_name = voiceCount)]
	pub fn voice_count(&self) -> usize {
		self.engine.voice_count()
	}
}

/// The names of the numbers in a record (`{ ops, kinds, params, oscillatorTypes, filterTypes, oversample,
/// channelCountModes, channelInterpretations }`, each an array indexed by the number), so the replayer has no table
/// of its own to drift.
#[wasm_bindgen(js_name = graphNames)]
pub fn graph_names() -> Object {
	let out = Object::new();
	let lists: [(&str, &[&str]); 8] = [
		("ops", NAMES.ops),
		("kinds", NAMES.kinds),
		("params", NAMES.params),
		("oscillatorTypes", NAMES.oscillator_types),
		("filterTypes", NAMES.filter_types),
		("oversample", NAMES.oversample),
		("channelCountModes", NAMES.channel_count_modes),
		("channelInterpretations", NAMES.channel_interpretations),
	];
	for (key, names) in lists {
		let array: Array = names.iter().map(|name| JsValue::from_str(name)).collect();
		let _ = Reflect::set(&out, &JsValue::from_str(key), &array);
	}
	out
}
