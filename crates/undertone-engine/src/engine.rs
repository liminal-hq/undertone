// The Engine: books voices on a Graph, keeping what must outlive one voice (orbits, cut groups, seeds)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Engine`], which books [`VoiceParams`](crate::params::VoiceParams) on a [`Graph`] exactly as `playVoice` and `playParams` in
//! `src/engine.ts` do.
//!
//! A voice is a gain envelope on an oscillator (or a noise buffer), optionally through a lowpass filter with
//! its own envelope, a high-pass filter, and a four-stage phaser, with an FM modulator, a pitch curve (slide,
//! envelope, or steps), a placement (a panner, a pan law, a pan path, an autopan, or per-speaker gains), and
//! sends to its orbit's shared reverb and delay. The order nodes are created in is the reference's, which is
//! what numbers them in a recorded graph, so a [`LogGraph`](crate::graph::LogGraph) booking is comparable to
//! the corpus byte for byte.
//!
//! What the engine keeps between voices is what the reference keeps per audio context:
//!
//! - the **orbit buses**, one reverb and one delay per (output, orbit), made when a voice first sends to it;
//! - the **cut groups**: the newest voice per (output, group), which the next voice in the group chokes;
//! - the **shaped waves**, made once and shared;
//! - the **seed** that noise and reverb draw their randomness from, and the **warnings** given once.
//!
//! ```
//! use undertone_engine::engine::{Engine, OutputSetup};
//! use undertone_engine::graph::LogGraph;
//! use undertone_engine::params::{Pitch, SoundType, VoiceParams};
//!
//! let mut engine = Engine::new(LogGraph::new(44_100.0, 2), OutputSetup::default())?;
//! let voice = VoiceParams {
//!     sound_type: Some(SoundType::Triangle),
//!     pitch: Some(Pitch::Name("a3".into())),
//!     duration: Some(0.4),
//!     sustain: 0.6,
//!     ..VoiceParams::empty()
//! };
//! let playback = engine.play(&voice, 0.0)?;
//! assert_eq!(playback.start_time, 0.0);
//! assert!(playback.end_time > 0.4);
//!
//! // The graph is a recording: one gain, one oscillator, and the destination.
//! let record = engine.into_graph().finish(None);
//! assert_eq!(record.counts.last().unwrap().1, 3);
//! assert_eq!(record.nodes[2].kind, "oscillator");
//! # Ok::<(), undertone_pattern::Error>(())
//! ```

use crate::effects::OrbitBus;
use crate::graph::{ChannelInterpretation, Graph, NodeId, ParamId};
use crate::master::{MasterBus, MasterBusOptions, create_master_bus};
use crate::math::gains::PanEvent;
use crate::surround::MAX_CHANNELS;
use crate::warn::{Warning, Warnings};
use crate::waves::ShapedWaves;
use std::collections::HashMap;
use undertone_pattern::Result;
use undertone_pattern::random::{Seed, SeededRandom};

/// How the engine's output is set up before any voice is booked: the reference's context preparation.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputSetup {
	/// A master bus to put between the voices and the destination (`createMasterBus`). `None` sends voices
	/// straight to the destination.
	pub master: Option<MasterBusOptions>,
	/// Whether to widen the destination to its hardware channel count with discrete channel interpretation
	/// (`enableMultichannel`), so channel gains address real speakers. Without it, or on stereo hardware,
	/// multichannel voices fold down to stereo.
	pub multichannel: bool,
	/// The seed that noise and reverb impulse responses draw from. The reference uses `Math.random` on a
	/// context nobody seeded; Rust has no ambient source, so the default is the seed `0` that a render uses.
	pub seed: Seed,
}

impl Default for OutputSetup {
	fn default() -> Self {
		Self {
			master: None,
			multichannel: false,
			seed: Seed::Num(0.0),
		}
	}
}

/// What booking a voice reports: its time window, and (for a voice that was booked) the means to stop it.
///
/// The window is `start_time` (after any nudge, never before 0) to `end_time` (after the release and a short
/// tail), on the graph's clock. A voice that books nothing (a sample that is not available) has an empty
/// window at its start and cannot be stopped.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Playback {
	/// The voice's start on the graph's clock, in seconds.
	pub start_time: f64,
	/// The latest time the voice is still sounding (after its release), in seconds.
	pub end_time: f64,
	pub(crate) voice: Option<usize>,
}

/// The envelope a gain was scheduled with, kept so a stopped voice can fade from wherever it actually is.
#[derive(Debug, Clone, Copy)]
pub(crate) struct EnvelopeShape {
	pub(crate) start: f64,
	pub(crate) base: f64,
	pub(crate) peak: f64,
	pub(crate) attack_end: f64,
	pub(crate) decay_end: f64,
	pub(crate) sustain_value: f64,
	pub(crate) release_start: f64,
	pub(crate) release_end: f64,
	pub(crate) release: f64,
}

impl EnvelopeShape {
	/// Absolute time the envelope finishes (fully released).
	pub(crate) fn end(&self) -> f64 {
		self.release_end
	}

	/// The level the scheduled automation is at, `t` seconds on the graph's clock.
	pub(crate) fn value_at(&self, t: f64) -> f64 {
		let lerp =
			|from: f64, to: f64, t0: f64, t1: f64| from + ((to - from) * (t - t0)) / (t1 - t0);
		if t <= self.start {
			return self.base;
		}
		if t < self.attack_end {
			return lerp(self.base, self.peak, self.start, self.attack_end);
		}
		if t < self.decay_end {
			return lerp(
				self.peak,
				self.sustain_value,
				self.attack_end,
				self.decay_end,
			);
		}
		if t < self.release_start {
			return self.sustain_value;
		}
		if self.release > 0.0 && t < self.release_end {
			return lerp(
				self.sustain_value,
				self.base,
				self.release_start,
				self.release_end,
			);
		}
		if self.release > 0.0 {
			self.base
		} else {
			self.sustain_value
		}
	}
}

/// A booked voice, kept for stopping it early.
#[derive(Debug, Clone)]
pub(crate) struct BookedVoice {
	pub(crate) end: f64,
	pub(crate) gain: ParamId,
	pub(crate) envelope: EnvelopeShape,
	pub(crate) stoppables: Vec<NodeId>,
	pub(crate) pan_paths: Vec<(ParamId, Vec<PanEvent>)>,
}

/// A number as a map key, with JavaScript's `SameValueZero`: `-0` is `0`, and every `NaN` is the same.
pub(crate) fn number_key(value: f64) -> u64 {
	if value.is_nan() {
		f64::NAN.to_bits()
	} else if value == 0.0 {
		0
	} else {
		value.to_bits()
	}
}

const DEFAULT_STOP_FADE_SECONDS: f64 = 0.01; // short enough to feel immediate, long enough to avoid a click
const STOP_FADE_TIME_CONSTANTS: f64 = 5.0; // setTargetAtTime reaches ~99% of the way after five time constants

/// Books voices on a [`Graph`].
///
/// See the [module documentation](self) for what a voice is made of and what the engine keeps between voices.
pub struct Engine<G: Graph> {
	pub(crate) graph: G,
	pub(crate) output: NodeId,
	pub(crate) master: Option<MasterBus>,
	pub(crate) seed: Seed,
	pub(crate) occurrences: HashMap<String, u32>,
	pub(crate) shaped_waves: ShapedWaves,
	pub(crate) buses: HashMap<(NodeId, u64), OrbitBus>,
	pub(crate) cut_groups: HashMap<(NodeId, u64), Playback>,
	pub(crate) voices: Vec<BookedVoice>,
	pub(crate) warnings: Warnings,
}

impl<G: Graph> Engine<G> {
	/// An engine that books on `graph`, with its output set up as `setup` says: multichannel first (when
	/// asked), then the master bus (when asked), as the reference's recorder prepares a context.
	///
	/// # Errors
	///
	/// A master bus whose options are invalid fails with the reference's message (see
	/// [`create_master_bus`]).
	pub fn new(graph: G, setup: OutputSetup) -> Result<Self> {
		let mut engine = Self {
			output: graph.destination(),
			graph,
			master: None,
			seed: setup.seed,
			occurrences: HashMap::new(),
			shaped_waves: ShapedWaves::default(),
			buses: HashMap::new(),
			cut_groups: HashMap::new(),
			voices: Vec::new(),
			warnings: Warnings::default(),
		};
		if setup.multichannel {
			engine.enable_multichannel();
		}
		if let Some(options) = setup.master {
			let bus = create_master_bus(&mut engine.graph, &mut engine.warnings, options)?;
			engine.output = bus.input;
			engine.master = Some(bus);
		}
		Ok(engine)
	}

	/// Opts the destination into its full hardware channel count (up to eight) with discrete channel
	/// interpretation, so channel gains address real speakers (`enableMultichannel`). Does nothing on a
	/// destination of two channels or fewer. Returns the destination's channel count afterwards.
	pub fn enable_multichannel(&mut self) -> u32 {
		let destination = self.graph.destination();
		let max = self.graph.destination_max_channels();
		if max > 2 {
			self.graph
				.set_channel_count(destination, max.min(MAX_CHANNELS as u32));
			self.graph
				.set_channel_interpretation(destination, ChannelInterpretation::Discrete);
		}
		self.graph.destination_channels()
	}

	/// The graph the engine books on.
	pub fn graph(&self) -> &G {
		&self.graph
	}

	/// The graph, mutably: a host may add its own nodes beside the engine's.
	pub fn graph_mut(&mut self) -> &mut G {
		&mut self.graph
	}

	/// Takes the graph back, ending the engine.
	pub fn into_graph(self) -> G {
		self.graph
	}

	/// The node voices connect to: the master bus's input when there is one, the destination otherwise.
	pub fn output(&self) -> NodeId {
		self.output
	}

	/// The master bus, when the setup asked for one.
	pub fn master_bus(&self) -> Option<MasterBus> {
		self.master
	}

	/// The warnings given so far, each key once, in order.
	pub fn warnings(&self) -> &[Warning] {
		self.warnings.all()
	}

	/// A random source for one piece of generated audio data: the seed and `key`, plus a count of earlier
	/// calls with the same key, so two voices with an identical key still differ, deterministically
	/// (`contextRandom`).
	pub(crate) fn context_random(&mut self, key: &str) -> SeededRandom {
		let n = self.occurrences.entry(key.to_string()).or_insert(0);
		let seed = format!("{}|{key}#{n}", self.seed.key_text());
		*n += 1;
		SeededRandom::from_text(&seed)
	}

	/// Like `context_random` but without the count: the same key always gives the same sequence
	/// (`keyedRandom`), as reverb impulse responses need.
	pub(crate) fn keyed_random(&self, key: &str) -> SeededRandom {
		SeededRandom::from_text(&format!("{}|{key}", self.seed.key_text()))
	}

	/// Stops a booked voice early: at `when` (default: the graph's clock now) with a fade (default 0.01
	/// seconds) so there is no click. A voice that has not started never sounds; one that already finished is
	/// untouched; a voice that booked nothing is left alone. Safe to call any number of times.
	///
	/// The gain holds the envelope's level at the stop and falls exponentially to silence, a pan path under
	/// way is cut short where it is, and every source is stopped when the fade is done.
	pub fn stop(&mut self, playback: Playback, when: Option<f64>, fade: Option<f64>) {
		let Some(index) = playback.voice else {
			return;
		};
		let now = self.graph.current_time();
		let voice = self.voices[index].clone();
		let stop_at = crate::math::js_max(when.unwrap_or(now), 0.0);
		if stop_at >= voice.end {
			return;
		}
		let fade = crate::math::js_max(fade.unwrap_or(DEFAULT_STOP_FADE_SECONDS), 0.0);
		let mut silent_at = stop_at;
		self.graph.cancel_scheduled_values(voice.gain, stop_at);
		self.graph
			.set_value_at_time(voice.gain, voice.envelope.value_at(stop_at), stop_at);
		if fade > 0.0 {
			self.graph.set_target_at_time(
				voice.gain,
				0.0,
				stop_at,
				fade / STOP_FADE_TIME_CONSTANTS,
			);
			silent_at = stop_at + fade;
		} else {
			self.graph.set_value_at_time(voice.gain, 0.0, stop_at);
		}
		for (param, events) in &voice.pan_paths {
			crate::pan::stop_pan_path(&mut self.graph, *param, events, stop_at);
		}
		// Calling stop again on a source replaces the earlier stop time.
		for node in &voice.stoppables {
			self.graph
				.stop(*node, crate::math::js_min(silent_at, voice.end));
		}
	}
}

impl<G: Graph + std::fmt::Debug> std::fmt::Debug for Engine<G> {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Engine")
			.field("graph", &self.graph)
			.field("output", &self.output)
			.field("voices", &self.voices.len())
			.finish_non_exhaustive()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::graph::LogGraph;
	use crate::params::VoiceParams;

	fn engine() -> Engine<LogGraph> {
		Engine::new(LogGraph::new(44_100.0, 2), OutputSetup::default()).expect("a plain engine")
	}

	fn voice() -> VoiceParams {
		VoiceParams {
			duration: Some(1.0),
			sustain: 1.0,
			attack: 0.1,
			..VoiceParams::empty()
		}
	}

	#[test]
	fn a_stop_cancels_the_envelope_and_fades_from_where_it_is() {
		let mut engine = engine();
		let playback = engine.play(&voice(), 0.0).unwrap();
		engine.stop(playback, Some(0.05), None);
		let record = engine.into_graph().finish(None);
		let gain = &record.nodes[1];
		let calls = &gain.params[0].1;
		// The attack ramp is half done at 0.05 s: 0.8 * 0.5 = 0.4.
		assert!(calls.contains(&"cancel @0.05".to_string()), "{calls:?}");
		assert!(calls.contains(&"set 0.4 @0.05".to_string()), "{calls:?}");
		assert!(
			calls.contains(&"target 0 @0.05 tau 0.002".to_string()),
			"{calls:?}"
		);
		// The source is stopped when the fade is done, replacing its first stop time.
		let source = &record.nodes[2];
		assert_eq!(source.stop.len(), 2);
		assert!((source.stop[1] - 0.06).abs() < 1e-12);
	}

	#[test]
	fn a_stop_after_the_end_does_nothing() {
		let mut engine = engine();
		let playback = engine.play(&voice(), 0.0).unwrap();
		engine.stop(playback, Some(playback.end_time + 1.0), None);
		let record = engine.into_graph().finish(None);
		assert_eq!(record.nodes[2].stop.len(), 1);
	}

	#[test]
	fn a_skipped_sample_voice_books_nothing_and_cannot_be_stopped() {
		let mut engine = engine();
		let params = VoiceParams {
			sample_name: Some("ghost".into()),
			nudge_time: 0.25,
			..VoiceParams::empty()
		};
		let playback = engine.play(&params, 1.0).unwrap();
		assert_eq!((playback.start_time, playback.end_time), (1.25, 1.25));
		engine.stop(playback, None, None);
		assert_eq!(engine.into_graph().finish(None).nodes.len(), 1);
	}

	#[test]
	fn a_bad_pitch_fails_with_the_reference_message() {
		let mut engine = engine();
		let params = VoiceParams {
			pitch: Some(crate::params::Pitch::Hz(0.0)),
			..VoiceParams::empty()
		};
		assert_eq!(
			engine.play(&params, 0.0).unwrap_err().message(),
			"Invalid frequency: 0"
		);
	}
}
