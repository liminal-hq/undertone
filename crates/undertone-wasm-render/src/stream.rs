// WorkletEngine: booked voices rendered a block at a time, for an AudioWorklet to play
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The render module's streaming export (RF-29, D-47, D-48). An `AudioWorkletProcessor` holds one [`WasmWorkletEngine`]
//! (`WorkletEngine`): the main thread collects voices as it does for `renderToBuffer` (`collectVoices`, the flat form of
//! [`crate::flat`]) and posts them with the frame they start at; the worklet books them here with
//! [`WasmWorkletEngine::book`] (all at once) or [`WasmWorkletEngine::queue`] (a few voices a block as the clock reaches
//! them, once or as a loop that repeats every period) and renders each 128-frame block with
//! [`WasmWorkletEngine::render_block`]. Patterns, foreign leaves, the scheduler, and sample decoding never run in the
//! worklet, and a loop repeats the voices it was given (the first `cycles` cycles), so it runs with no main thread.
//!
//! A `book` render is bit for bit the offline render's. A `queue` render books while voices end, which retires their nodes
//! and reuses the numbers, so a mix can be summed in another order: the same sound to within a few ulps.
//!
//! The sound is the offline render's: the same [`RenderPlan`] makes the output setup (master bus, seed, channels), the
//! voices are resolved and put in booking order by `pending_voices`, and the same [`Engine`] books them on the same
//! [`RenderGraph`], made without an end ([`RenderGraph::try_streaming`]). A test renders the same voices both ways and
//! compares them sample for sample.
//!
//! Booking allocates (nodes, buffers, a reverb's impulse response). That is accepted in the worklet for this opt-in
//! backend (D-34 stands); the harness measures what it costs.

use js_sys::Float32Array;
use undertone::engine::engine::Engine;
use undertone::engine::render::{RenderPlan, pending_voices};
use undertone::engine::render_graph::RenderGraph;
use undertone::engine::samples::Samples;
use undertone::engine::window::{PendingVoice, last_room_sizes};
use undertone::pattern::Error as EngineError;
use undertone::pattern::Result as EngineResult;
use wasm_bindgen::prelude::*;

use crate::convert::{error, list_items, rust_error, string_items};
use crate::options::render_options;
use crate::samples::with_registry;

/// Voices waiting to be booked as the stream's clock reaches them: one pass of voices, once or repeating.
struct Queued {
	id: u32,
	voices: Vec<PendingVoice>,
	/// The frame pass 0 starts at.
	start_frame: f64,
	/// Frames from one pass's start to the next, for a loop.
	period: Option<f64>,
	pass: u64,
	next: usize,
}

impl Queued {
	/// The frame the current pass starts at: counted from the loop's first pass, so rounding never accumulates.
	fn base(&self) -> f64 {
		match self.period {
			Some(period) => self.start_frame + (self.pass as f64 * period).round(),
			None => self.start_frame,
		}
	}
}

/// How far ahead of the clock a queued voice is booked, in seconds. Booking a little early spreads the work over
/// blocks; the sound is the same wherever in time a voice is booked (the offline render books every voice up front).
const LOOK_AHEAD_SECONDS: f64 = 0.1;

/// A streaming engine: voices booked at absolute frames and rendered a block at a time. The host-independent half of
/// [`WasmWorkletEngine`], so Rust tests can drive it.
pub struct Stream {
	sample_rate: f64,
	channels: usize,
	look_ahead: f64,
	engine: Engine<RenderGraph>,
	/// The block last rendered, one `Vec` per channel; only grows.
	scratch: Vec<Vec<f32>>,
	warned: usize,
	queued: Vec<Queued>,
	next_id: u32,
}

impl Stream {
	/// Makes the engine for `plan` on a graph without an end (the plan's length and booking window do not apply).
	///
	/// # Errors
	///
	/// A master bus whose options are invalid, as for any render.
	pub fn new(plan: &RenderPlan) -> EngineResult<Self> {
		let graph = RenderGraph::try_streaming(plan.sample_rate, plan.channels)?;
		let engine = Engine::new(graph, plan.output_setup())?;
		Ok(Self {
			sample_rate: plan.sample_rate,
			channels: plan.channels as usize,
			look_ahead: (LOOK_AHEAD_SECONDS * plan.sample_rate).ceil(),
			engine,
			scratch: vec![Vec::new(); plan.channels as usize],
			warned: 0,
			queued: Vec::new(),
			next_id: 0,
		})
	}

	/// Books `voices` (in booking order) so that each starts `start_frame` frames plus its own start time after frame 0 of
	/// the engine's clock, with `samples` as the registry the engine plays from for the call. A voice that starts before
	/// the frame being rendered starts at once. Returns how many voices were booked; a voice that fails stops the
	/// booking with its message, and the voices before it stay booked, as in the offline render.
	///
	/// # Errors
	///
	/// A voice that fails to book ([`Engine::play`]).
	pub fn book(
		&mut self,
		voices: &[PendingVoice],
		start_frame: f64,
		samples: &mut Samples,
	) -> EngineResult<usize> {
		let offset = start_frame / self.sample_rate;
		std::mem::swap(self.engine.samples_mut(), samples);
		let mut booked = Ok(0);
		for voice in voices {
			if let Err(failure) = self.engine.play(&voice.params, offset + voice.start_time) {
				booked = Err(failure);
				break;
			}
			if let Ok(count) = &mut booked {
				*count += 1;
			}
		}
		std::mem::swap(self.engine.samples_mut(), samples);
		booked
	}

	/// Queues `voices` (in booking order) as one pass starting at `start_frame`, repeating every `period` frames when
	/// given: each voice is booked as the clock comes within the look-ahead of it, so a long pass or a loop books a few
	/// voices a block, never all at once. With a booking-window-style rule the pass is given the last room size its
	/// orbit asks for ([`last_room_sizes`]), as the offline render does for one render. Returns the queue's id.
	pub fn queue(
		&mut self,
		voices: Vec<PendingVoice>,
		start_frame: f64,
		period: Option<f64>,
		samples: &mut Samples,
	) -> EngineResult<u32> {
		let period = period.filter(|period| period.is_finite());
		if let Some(period) = period {
			// Passes are booked one after the other, so a pass must start all its voices before the next one starts.
			let last = voices
				.iter()
				.map(|voice| (voice.start_time + voice.params.nudge_time) * self.sample_rate)
				.fold(0.0_f64, f64::max);
			if period < 1.0 || period <= last {
				return Err(EngineError::new(format!(
					"a loop's period must be longer than the start of its last voice ({last} frames), got {period}"
				)));
			}
		}
		std::mem::swap(self.engine.samples_mut(), samples);
		let engine = &self.engine;
		let sized = last_room_sizes(&voices, |params| engine.is_voice_skipped(params));
		std::mem::swap(self.engine.samples_mut(), samples);
		let id = self.next_id;
		self.next_id = self.next_id.wrapping_add(1);
		self.queued.push(Queued {
			id,
			voices: sized,
			start_frame,
			period,
			pass: 0,
			next: 0,
		});
		Ok(id)
	}

	/// Drops a queue: its voices not yet booked never are (those booked play out). `false` when it is not queued.
	pub fn cancel(&mut self, id: u32) -> bool {
		let before = self.queued.len();
		self.queued.retain(|queued| queued.id != id);
		self.queued.len() != before
	}

	/// How many queues are waiting.
	pub fn queue_count(&self) -> usize {
		self.queued.len()
	}

	/// Books every queued voice that starts before `horizon` frames; returns the messages of voices that failed to book
	/// (each is skipped; the rest are booked).
	fn pump(&mut self, horizon: f64, samples: &mut Samples) -> Vec<String> {
		let mut failures = Vec::new();
		if self.queued.is_empty() {
			return failures;
		}
		let produced = self.frames_rendered() as f64;
		std::mem::swap(self.engine.samples_mut(), samples);
		let rate = self.sample_rate;
		let mut queues = std::mem::take(&mut self.queued);
		queues.retain_mut(|queued| {
			loop {
				let Some((start_time, nudge)) = queued
					.voices
					.get(queued.next)
					.map(|voice| (voice.start_time, voice.params.nudge_time))
				else {
					let Some(period) = queued.period.filter(|_| !queued.voices.is_empty()) else {
						return false;
					};
					// A loop that fell more than a pass behind skips the passes that have gone by, not plays them all at once.
					queued.pass += 1;
					if queued.base() + period <= produced {
						queued.pass += ((produced - queued.base()) / period).floor() as u64;
					}
					queued.next = 0;
					continue;
				};
				let base = queued.base();
				if base + (start_time + nudge) * rate >= horizon {
					return true;
				}
				let index = queued.next;
				queued.next += 1;
				if let Err(failure) = self
					.engine
					.play(&queued.voices[index].params, base / rate + start_time)
				{
					failures.push(failure.message().to_owned());
				}
			}
		});
		self.queued = queues;
		std::mem::swap(self.engine.samples_mut(), samples);
		failures
	}

	/// Books what is due, then renders the next `frames` frames into the scratch channels and returns them with the
	/// messages of any voices that failed to book.
	pub fn render(&mut self, frames: usize, samples: &mut Samples) -> (&[Vec<f32>], Vec<String>) {
		let horizon = (self.frames_rendered() + frames as u64) as f64 + self.look_ahead;
		let failures = self.pump(horizon, samples);
		for channel in &mut self.scratch {
			if channel.len() < frames {
				channel.resize(frames, 0.0);
			}
		}
		let mut slices: Vec<&mut [f32]> = self
			.scratch
			.iter_mut()
			.map(|channel| &mut channel[..frames])
			.collect();
		let written = self.engine.graph_mut().render_block(&mut slices);
		debug_assert_eq!(written, frames, "a streaming graph never ends");
		(&self.scratch, failures)
	}

	/// How many frames have been rendered so far: the engine's own clock.
	pub fn frames_rendered(&self) -> u64 {
		self.engine.graph().frames_rendered()
	}

	/// The output channels.
	pub fn channels(&self) -> usize {
		self.channels
	}

	/// How many nodes the graph holds now.
	pub fn live_nodes(&self) -> usize {
		self.engine.graph().live_nodes()
	}

	/// The warnings the engine gave since the last call: `(key, message)`.
	pub fn new_warnings(&mut self) -> Vec<(String, String)> {
		let all = self.engine.warnings();
		let fresh = all[self.warned.min(all.len())..]
			.iter()
			.map(|warning| (warning.key.to_string(), warning.message.clone()))
			.collect();
		self.warned = all.len();
		fresh
	}
}

/// Prints the engine's new warnings: a sample warning each time (the registry keeps its own once-only set), the others
/// once per key per instance, as the offline exports do.
fn print_warnings(stream: &mut Stream) {
	for (key, message) in stream.new_warnings() {
		if key.starts_with("sample:") {
			crate::warnings::print(&message);
		} else {
			crate::warnings::warn_once(&key, &message);
		}
	}
}

fn decode_voices(
	numbers: &js_sys::Float64Array,
	strings: &JsValue,
) -> Result<Vec<PendingVoice>, JsValue> {
	let strings = string_items(strings, "the voices' strings")?;
	let values = crate::flat::decode(&numbers.to_vec(), &strings).map_err(|m| error(&m))?;
	Ok(pending_voices(values))
}

/// The streaming engine of the AudioWorklet backend (`WorkletEngine`). See the [module documentation](self).
#[wasm_bindgen(js_name = WorkletEngine)]
pub struct WasmWorkletEngine {
	stream: Stream,
}

#[wasm_bindgen(js_class = WorkletEngine)]
impl WasmWorkletEngine {
	/// Makes the engine from the render options (`sampleRate`, `channels`, `master`, `seed`; the length options do not
	/// apply to a stream).
	#[wasm_bindgen(constructor)]
	pub fn new(options: JsValue) -> Result<WasmWorkletEngine, JsValue> {
		let plan = RenderPlan::new(&render_options(&options)).map_err(rust_error)?;
		let stream = Stream::new(&plan).map_err(rust_error)?;
		Ok(WasmWorkletEngine { stream })
	}

	/// Books the voices the main thread collected (`[Float64Array, string[]]`, [`crate::flat`]) at `startFrame`, an
	/// absolute frame of this engine's clock (it counts the frames `renderBlock` has produced; it may be fractional),
	/// all at once. Returns how many voices were booked. Allocates: that is accepted here (D-34).
	pub fn book(
		&mut self,
		numbers: &js_sys::Float64Array,
		strings: JsValue,
		start_frame: f64,
	) -> Result<u32, JsValue> {
		let voices = decode_voices(numbers, &strings)?;
		let booked = with_registry(|samples| self.stream.book(&voices, start_frame, samples));
		print_warnings(&mut self.stream);
		booked.map(|count| count as u32).map_err(rust_error)
	}

	/// As `book`, but each voice is booked as the clock comes within 100 ms of it, so a long pass books a few voices a
	/// block. With `periodFrames` the pass repeats every that many frames (a loop, counted from `startFrame` so the
	/// rounding never accumulates) until `cancel`. Returns the queue's id.
	pub fn queue(
		&mut self,
		numbers: &js_sys::Float64Array,
		strings: JsValue,
		start_frame: f64,
		period_frames: Option<f64>,
	) -> Result<u32, JsValue> {
		let voices = decode_voices(numbers, &strings)?;
		with_registry(|samples| {
			self.stream
				.queue(voices, start_frame, period_frames, samples)
		})
		.map_err(rust_error)
	}

	/// Stops a queue: what it has not booked yet never is. `false` when `id` is not queued.
	pub fn cancel(&mut self, id: u32) -> bool {
		self.stream.cancel(id)
	}

	/// Renders the next block into `out`, one `Float32Array` per channel, all of one length (128 in a worklet), and
	/// advances the clock by that many frames, booking the queued voices that have come due first. Returns the message
	/// of the first voice that failed to book in this block (the voice is skipped and the sound goes on), or
	/// `undefined`.
	#[wasm_bindgen(js_name = renderBlock)]
	pub fn render_block(&mut self, out: JsValue) -> Result<Option<String>, JsValue> {
		let channels = list_items(&out, "renderBlock() channels")?;
		if channels.len() != self.stream.channels() {
			return Err(error(&format!(
				"renderBlock() needs {} channels, got {}",
				self.stream.channels(),
				channels.len()
			)));
		}
		let mut arrays = Vec::with_capacity(channels.len());
		for channel in &channels {
			let Some(array) = channel.dyn_ref::<Float32Array>() else {
				return Err(error("renderBlock() channels must be Float32Arrays"));
			};
			arrays.push(array);
		}
		let frames = arrays.first().map_or(0, |array| array.length()) as usize;
		if arrays.iter().any(|array| array.length() as usize != frames) {
			return Err(error("renderBlock() channels must all have one length"));
		}
		let failure = with_registry(|samples| {
			let (rendered, failures) = self.stream.render(frames, samples);
			for (array, channel) in arrays.iter().zip(rendered) {
				array.copy_from(&channel[..frames]);
			}
			failures.into_iter().next()
		});
		print_warnings(&mut self.stream);
		Ok(failure)
	}

	/// How many frames have been rendered: this engine's clock.
	#[wasm_bindgen(getter)]
	pub fn frame(&self) -> f64 {
		self.stream.frames_rendered() as f64
	}

	/// How many nodes the graph holds now (a gauge for the harness: it should stay flat as voices end).
	#[wasm_bindgen(getter, js_name = liveNodes)]
	pub fn live_nodes(&self) -> u32 {
		self.stream.live_nodes() as u32
	}

	/// How many queues are waiting to book voices.
	#[wasm_bindgen(getter, js_name = queueCount)]
	pub fn queue_count(&self) -> u32 {
		self.stream.queue_count() as u32
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use undertone::engine::render::RenderOptions as EngineOptions;
	use undertone::engine::samples::SampleData;
	use undertone::pattern::random::Seed;
	use undertone::prelude::*;

	const RATE: f64 = 8_000.0;

	fn options(channels: f64) -> EngineOptions {
		EngineOptions {
			sample_rate: Some(RATE),
			channels: Some(channels),
			cycles: Some(2.0),
			tail: Some(0.5),
			seed: Some(Seed::Str("stream".into())),
			..EngineOptions::default()
		}
	}

	fn tune() -> Pattern<ControlMap> {
		note("c4 e4 g4 [b4 d5]")
			.unwrap()
			.sound("triangle")
			.release(0.2)
			.unwrap()
	}

	/// Noise, a filtered saw, and reverb and delay sends: nodes that keep state from block to block.
	fn busy() -> Pattern<ControlMap> {
		stack(vec![
			sound("white*4").unwrap().decay(0.05).unwrap(),
			note("c3 g3").unwrap().sound("sawtooth").lpf(900).unwrap(),
		])
		.room(0.4)
		.unwrap()
		.delay(0.3)
		.unwrap()
	}

	fn offline(plan: &RenderPlan, voices: Vec<PendingVoice>) -> Vec<Vec<f32>> {
		undertone::render_voices(plan, Samples::new(), voices)
			.unwrap()
			.channels()
			.to_vec()
	}

	/// Fails with the first frame that differs, not the whole render.
	fn same(got: &[Vec<f32>], expected: &[Vec<f32>], what: &str) {
		assert_eq!(got.len(), expected.len(), "{what}: channels");
		for (c, (a, b)) in got.iter().zip(expected).enumerate() {
			assert_eq!(a.len(), b.len(), "{what}: length of channel {c}");
			if let Some(i) = a.iter().zip(b).position(|(x, y)| x != y) {
				let count = a.iter().zip(b).filter(|(x, y)| x != y).count();
				let worst = a
					.iter()
					.zip(b)
					.map(|(x, y)| (x - y).abs())
					.fold(0.0_f32, f32::max);
				panic!(
					"{what}: channel {c} differs at frame {i}: {} against {} ({count} frames differ, by at most {worst})",
					a[i], b[i]
				);
			}
		}
	}

	/// Booking while voices end retires their nodes and reuses the numbers, which can change the order a mix is summed in:
	/// the same sound to within a few ulps (the tests for `book` hold bit for bit).
	fn close(got: &[Vec<f32>], expected: &[Vec<f32>], what: &str) {
		assert_eq!(got.len(), expected.len(), "{what}: channels");
		for (c, (a, b)) in got.iter().zip(expected).enumerate() {
			assert_eq!(a.len(), b.len(), "{what}: length of channel {c}");
			let worst = a
				.iter()
				.zip(b)
				.map(|(x, y)| (x - y).abs())
				.fold(0.0_f32, f32::max);
			assert!(worst < 1e-6, "{what}: channel {c} differs by up to {worst}");
		}
	}

	fn streamed(
		stream: &mut Stream,
		frames: usize,
		block: usize,
		mut before: impl FnMut(&mut Stream, usize),
	) -> Vec<Vec<f32>> {
		let mut out = vec![Vec::new(); stream.channels()];
		let mut at = 0;
		while at < frames {
			before(stream, at);
			let take = block.min(frames - at);
			for (channel, rendered) in out
				.iter_mut()
				.zip(stream.render(take, &mut Samples::new()).0)
			{
				channel.extend_from_slice(&rendered[..take]);
			}
			at += take;
		}
		out
	}

	#[test]
	fn streaming_blocks_equal_one_offline_render_sample_for_sample() {
		for (pattern, channels) in [(tune(), 2.0), (busy(), 2.0), (busy(), 6.0)] {
			let plan = RenderPlan::new(&options(channels)).unwrap();
			let voices = plan.collect_voices(&pattern).unwrap();
			let expected = offline(&plan, voices.clone());
			assert!(expected.iter().flatten().any(|s| s.abs() > 0.01));
			// A worklet's block, and a size that divides neither the quantum nor the length.
			for block in [128, 100] {
				let mut stream = Stream::new(&plan).unwrap();
				let booked = stream.book(&voices, 0.0, &mut Samples::new()).unwrap();
				assert_eq!(booked, voices.len());
				let got = streamed(&mut stream, plan.length, block, |_, _| {});
				same(
					&got,
					&expected,
					&format!("{channels} channels, blocks of {block}"),
				);
			}
		}
	}

	#[test]
	fn voices_booked_later_at_a_frame_equal_the_same_voices_shifted() {
		let plan = RenderPlan::new(&options(2.0)).unwrap();
		let voices = plan.collect_voices(&busy()).unwrap();
		// Frame 1,000 is not a multiple of the 128-frame quantum: the voices start mid-quantum.
		let frame = 1_000.0;
		let shifted: Vec<PendingVoice> = voices
			.iter()
			.map(|voice| PendingVoice {
				start_time: frame / RATE + voice.start_time,
				params: voice.params.clone(),
			})
			.collect();
		let mut shifted_plan = plan.clone();
		shifted_plan.length = plan.length + frame as usize;
		let expected = offline(&shifted_plan, shifted);

		// Booked while the stream runs, a block before they are due, as the worklet books a message between blocks.
		let mut stream = Stream::new(&plan).unwrap();
		let got = streamed(&mut stream, shifted_plan.length, 128, |stream, at| {
			if at == 896 {
				stream.book(&voices, frame, &mut Samples::new()).unwrap();
			}
		});
		same(&got, &expected, "streamed");
	}

	#[test]
	fn a_stream_that_has_run_books_at_the_frame_it_is_given_and_counts_frames() {
		let plan = RenderPlan::new(&options(2.0)).unwrap();
		let voices = plan.collect_voices(&tune()).unwrap();
		let mut stream = Stream::new(&plan).unwrap();
		streamed(&mut stream, 2_000, 128, |_, _| {});
		assert_eq!(stream.frames_rendered(), 2_000);
		stream.book(&voices, 2_000.0, &mut Samples::new()).unwrap();
		let heard = streamed(&mut stream, 1_024, 128, |_, _| {});
		assert!(heard.iter().flatten().any(|s| s.abs() > 0.01));
		assert_eq!(stream.frames_rendered(), 3_024);
	}

	#[test]
	fn a_queued_pass_equals_the_offline_render_and_books_a_few_voices_a_block() {
		let plan = RenderPlan::new(&options(2.0)).unwrap();
		let voices = plan.collect_voices(&busy()).unwrap();
		let expected = offline(&plan, voices.clone());
		let mut stream = Stream::new(&plan).unwrap();
		let id = stream
			.queue(voices, 0.0, None, &mut Samples::new())
			.unwrap();
		assert_eq!(stream.queue_count(), 1);
		let got = streamed(&mut stream, plan.length, 128, |_, _| {});
		close(&got, &expected, "queued pass");
		assert_eq!(stream.queue_count(), 0, "a finished pass leaves the queue");
		assert!(!stream.cancel(id));
	}

	#[test]
	fn a_queued_loop_repeats_every_period_and_cancel_stops_it() {
		let mut config = options(2.0);
		config.cycles = Some(1.0);
		let plan = RenderPlan::new(&config).unwrap();
		let voices = plan.collect_voices(&tune()).unwrap();
		// A cycle is 16,000 frames at 8 kHz; 16,001 is a period that is not a multiple of the quantum.
		let period = 16_001.0;
		let passes = 3_usize;
		let every: Vec<PendingVoice> = (0..passes)
			.flat_map(|pass| {
				let shift = (pass as f64 * period).round() / RATE;
				voices.iter().map(move |voice| PendingVoice {
					start_time: shift + voice.start_time,
					params: voice.params.clone(),
				})
			})
			.collect();
		let mut long_plan = plan.clone();
		long_plan.length = (period as usize) * passes;
		let expected = offline(&long_plan, every);

		let mut stream = Stream::new(&plan).unwrap();
		let id = stream
			.queue(voices.clone(), 0.0, Some(period), &mut Samples::new())
			.unwrap();
		assert!(
			stream
				.queue(voices.clone(), 0.0, Some(12_000.0), &mut Samples::new())
				.is_err()
		);
		let got = streamed(&mut stream, long_plan.length, 128, |_, _| {});
		close(&got, &expected, "queued loop");
		assert_eq!(stream.queue_count(), 1, "a loop stays queued");
		assert!(stream.cancel(id));
		// Cancelled, only what was booked already rings out: the tail dies away to silence.
		let after = streamed(&mut stream, 24_000, 128, |_, _| {});
		assert!(after.iter().flatten().rev().take(2_000).all(|s| *s == 0.0));
		assert_eq!(stream.queue_count(), 0);
	}

	#[test]
	fn a_loop_that_fell_behind_skips_the_passes_that_have_gone_by() {
		let plan = RenderPlan::new(&options(2.0)).unwrap();
		let voices = plan.collect_voices(&tune()).unwrap();
		let mut stream = Stream::new(&plan).unwrap();
		streamed(&mut stream, 100_000, 128, |_, _| {});
		stream
			.queue(voices.clone(), 0.0, Some(32_001.0), &mut Samples::new())
			.unwrap();
		streamed(&mut stream, 128, 128, |_, _| {});
		// Booked what lies ahead of 100,000 frames, not six passes of voices at once.
		assert!(
			stream.live_nodes() < voices.len() * 12,
			"{}",
			stream.live_nodes()
		);
	}

	#[test]
	fn a_sample_voice_plays_from_the_registry_given_to_book() {
		let plan = RenderPlan::new(&options(2.0)).unwrap();
		let voices = plan.collect_voices(&s("kick").unwrap()).unwrap();
		let mut samples = Samples::new();
		let tone: Vec<f32> = (0..2_000).map(|i| (i as f32 * 0.05).sin()).collect();
		samples
			.register_sample("kick", SampleData::new(RATE, vec![tone]), None)
			.unwrap();
		let mut stream = Stream::new(&plan).unwrap();
		stream.book(&voices, 0.0, &mut samples).unwrap();
		let heard = streamed(&mut stream, 1_024, 128, |_, _| {});
		assert!(heard.iter().flatten().any(|s| s.abs() > 0.01));
		// The registry is handed back.
		assert!(samples.is_sample_registered("kick", None));
		// Without it the voice is skipped, with the engine's warning.
		let mut silent = Stream::new(&plan).unwrap();
		silent.book(&voices, 0.0, &mut Samples::new()).unwrap();
		let quiet = streamed(&mut silent, 1_024, 128, |_, _| {});
		assert!(quiet.iter().flatten().all(|s| *s == 0.0));
		assert!(!silent.new_warnings().is_empty());
	}
}
