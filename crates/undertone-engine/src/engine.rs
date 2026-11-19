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
use crate::graph::BufferId;
use crate::graph::{Graph, NodeId, ParamId, Scope};
use crate::master::{MasterBus, MasterBusOptions, create_master_bus};
use crate::math::gains::PanEvent;
use crate::samples::Samples;
use crate::surround::enable_multichannel;
use crate::warn::{Warning, Warnings};
use crate::waves::ShapedWaves;
use core::sync::atomic::{AtomicU64, Ordering};
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
	pub(crate) voice: Option<VoiceHandle>,
}

/// Which booked voice a [`Playback`] means: the engine that booked it, the slot it sits in, and the slot's
/// generation when it was booked. A handle from another engine, or for a voice whose slot was freed (and
/// perhaps reused), no longer names a voice, and [`Engine::stop`] ignores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VoiceHandle {
	pub(crate) engine: u64,
	pub(crate) slot: usize,
	pub(crate) generation: u64,
}

/// One slot of the engine's voice slab: the voice booked in it (if any) and how many voices it has held.
#[derive(Debug)]
pub(crate) struct VoiceSlot {
	pub(crate) generation: u64,
	pub(crate) voice: Option<BookedVoice>,
}

/// The next engine id: process-unique, so a handle never means a voice of another engine.
static NEXT_ENGINE_ID: AtomicU64 = AtomicU64::new(1);

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
	/// The graph nodes and buffers the voice made, to give back once it is over ([`Graph::retire_scope`]).
	pub(crate) scope: Scope,
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
	/// A process-unique id, carried by every [`Playback`] this engine hands out.
	pub(crate) id: u64,
	/// The booked voices, in a slab: a slot freed by a finished voice is reused, with its generation raised.
	pub(crate) voices: Vec<VoiceSlot>,
	pub(crate) free_slots: Vec<usize>,
	pub(crate) warnings: Warnings,
	/// The registry sample voices play from (see [`Engine::samples_mut`]).
	pub(crate) samples: Samples,
	/// The graph buffers made from registered samples, by registered key: what the reference's context has
	/// decoded. Kept when the registry is cleared, as the reference keeps it.
	pub(crate) sample_buffers: HashMap<String, BufferId>,
	/// The scopes of voices that are over, each with the time the voice ended, waiting out
	/// [`RETIRE_AFTER_SECONDS`] before the graph is told to retire them.
	pub(crate) retiring: Vec<(f64, Scope)>,
}

/// How long after a voice's end its nodes are kept before the graph retires them, in seconds: room for a filter
/// or a delay in the voice's own chain to ring out its last samples.
pub const RETIRE_AFTER_SECONDS: f64 = 0.1;

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
			id: NEXT_ENGINE_ID.fetch_add(1, Ordering::Relaxed),
			voices: Vec::new(),
			free_slots: Vec::new(),
			warnings: Warnings::default(),
			samples: Samples::default(),
			sample_buffers: HashMap::new(),
			retiring: Vec::new(),
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
	/// destination of two channels or fewer. Returns the destination's channel count afterwards. This is
	/// [`enable_multichannel`] on the engine's graph; call it before booking, as [`OutputSetup::multichannel`]
	/// does.
	pub fn enable_multichannel(&mut self) -> u32 {
		enable_multichannel(&mut self.graph)
	}

	/// How many booked voices the engine still keeps, to stop them early or to cut a group.
	pub fn voice_count(&self) -> usize {
		self.voices.len() - self.free_slots.len()
	}

	/// How many finished voices' nodes the engine is still holding before it retires them on the graph (see
	/// [`RETIRE_AFTER_SECONDS`]). Zero on a graph that retires nothing.
	pub fn retiring_count(&self) -> usize {
		self.retiring.len()
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

	/// The sample registry this engine plays sample voices from.
	pub fn samples(&self) -> &Samples {
		&self.samples
	}

	/// The sample registry, mutably: register decoded recordings here ([`Samples::register_sample`]) before
	/// booking a voice that names them. Replace it whole with `*engine.samples_mut() = samples`.
	///
	/// An engine keeps each buffer it has made from a recording (as the reference keeps what a context has
	/// decoded), so a name this engine has already played keeps its first recording when it is registered
	/// again or cleared; use a new engine for a new set of recordings.
	pub fn samples_mut(&mut self) -> &mut Samples {
		&mut self.samples
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

	/// The voice a handle names, or `None` for a handle from another engine or for a voice that was freed.
	fn booked_voice(&self, handle: VoiceHandle) -> Option<&BookedVoice> {
		if handle.engine != self.id {
			return None;
		}
		let slot = self.voices.get(handle.slot)?;
		if slot.generation != handle.generation {
			return None;
		}
		slot.voice.as_ref()
	}

	/// Stops a booked voice early: at `when` (default: the graph's clock now) with a fade (default 0.01
	/// seconds) so there is no click. A voice that has not started never sounds; one that already finished is
	/// untouched; a voice that booked nothing is left alone. Safe to call any number of times.
	///
	/// A `playback` from another engine, or for a voice the engine has since forgotten (finished voices are
	/// dropped as new ones are booked), is ignored: it cannot panic and cannot stop anything.
	///
	/// The gain holds the envelope's level at the stop and falls exponentially to silence, a pan path under
	/// way is cut short where it is, and every source is stopped when the fade is done.
	pub fn stop(&mut self, playback: Playback, when: Option<f64>, fade: Option<f64>) {
		let Some(voice) = playback.voice.and_then(|handle| self.booked_voice(handle)) else {
			return;
		};
		let now = self.graph.current_time();
		let voice = voice.clone();
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
			.field("voices", &self.voice_count())
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

	fn reverb_voice(room_size: f64) -> VoiceParams {
		VoiceParams {
			duration: Some(1.0),
			sustain: 1.0,
			room_level: Some(0.5),
			room_size,
			..VoiceParams::empty()
		}
	}

	#[test]
	fn an_infinite_room_size_is_an_error_not_a_panic() {
		let mut engine = engine();
		let error = engine.play(&reverb_voice(f64::INFINITY), 0.0).unwrap_err();
		assert!(error.message().contains("room"), "{}", error.message());
	}

	#[test]
	fn a_not_a_number_room_size_is_an_error() {
		let mut engine = engine();
		assert!(engine.play(&reverb_voice(f64::NAN), 0.0).is_err());
	}

	#[test]
	fn a_huge_room_size_is_an_error_instead_of_a_huge_allocation() {
		let mut engine = engine();
		assert!(engine.play(&reverb_voice(1.0e12), 0.0).is_err());
	}

	#[test]
	fn a_failed_room_does_not_poison_the_orbit() {
		let mut engine = engine();
		assert!(engine.play(&reverb_voice(f64::INFINITY), 0.0).is_err());
		assert!(engine.play(&reverb_voice(3.0), 0.0).is_ok());
	}

	#[test]
	fn an_infinite_delay_time_does_not_panic() {
		let mut engine = engine();
		let params = VoiceParams {
			delay_level: Some(0.5),
			delay_time: f64::INFINITY,
			..VoiceParams::empty()
		};
		let _ = engine.play(&params, 0.0);
	}

	#[test]
	fn a_playback_from_another_engine_is_a_no_op() {
		let mut a = engine();
		let mut b = engine();
		let from_a = a.play(&voice(), 0.0).unwrap();
		// B has no voices at all: an index into B's list would be out of bounds.
		b.stop(from_a, Some(0.05), None);
		assert_eq!(b.into_graph().finish(None).nodes.len(), 1);
	}

	#[test]
	fn a_playback_from_another_engine_does_not_stop_this_engines_voice() {
		let mut a = engine();
		let mut b = engine();
		let from_a = a.play(&voice(), 0.0).unwrap();
		let _from_b = b.play(&voice(), 0.0).unwrap();
		// Both are slot 0 of their engine, so only an engine id tells them apart.
		b.stop(from_a, Some(0.05), None);
		let record = b.into_graph().finish(None);
		let calls = &record.nodes[1].params[0].1;
		assert!(
			!calls.iter().any(|call| call.starts_with("cancel")),
			"{calls:?}"
		);
		assert_eq!(record.nodes[2].stop.len(), 1);
	}

	fn short_voice() -> VoiceParams {
		VoiceParams {
			duration: Some(0.01),
			sustain: 1.0,
			release: 0.01,
			..VoiceParams::empty()
		}
	}

	#[test]
	fn a_hundred_thousand_short_voices_in_sequence_keep_the_voice_list_small() {
		let mut engine = engine();
		let mut most = 0;
		for i in 0..100_000_u32 {
			let now = f64::from(i) * 0.05;
			engine.graph_mut().set_current_time(now);
			engine.play(&short_voice(), now).unwrap();
			most = most.max(engine.voice_count());
		}
		// Each voice lasts well under the 0.05 s between bookings.
		assert!(most <= 4, "the engine kept {most} voices at once");
		assert!(engine.voices.len() <= 4, "{} slots", engine.voices.len());
	}

	#[test]
	fn a_finished_voice_is_kept_until_the_clock_passes_its_end() {
		let mut engine = engine();
		let first = engine.play(&short_voice(), 0.0).unwrap();
		engine.graph_mut().set_current_time(first.end_time - 0.001);
		engine.play(&short_voice(), 0.0).unwrap();
		assert_eq!(engine.voice_count(), 2);
	}

	#[test]
	fn a_stale_playback_is_a_no_op_even_when_its_slot_is_reused() {
		let mut engine = engine();
		let first = engine.play(&short_voice(), 0.0).unwrap();
		engine.graph_mut().set_current_time(first.end_time + 1.0);
		engine.play(&short_voice(), 2.0).unwrap();
		assert_eq!(engine.voice_count(), 1);
		// The second voice sits in the first one's slot; the first handle must not reach it.
		engine.stop(first, Some(2.001), None);
		let record = engine.into_graph().finish(None);
		let second_gain = &record.nodes[4].params[0].1;
		assert!(
			!second_gain.iter().any(|call| call.starts_with("cancel")),
			"{second_gain:?}"
		);
	}

	#[test]
	fn a_cut_group_still_chokes_its_live_voice_after_older_voices_are_dropped() {
		let mut engine = engine();
		let grouped = VoiceParams {
			duration: Some(10.0),
			sustain: 1.0,
			cut_group: Some(1.0),
			..VoiceParams::empty()
		};
		engine.play(&grouped, 0.0).unwrap();
		for i in 1..50_u32 {
			let now = f64::from(i);
			engine.graph_mut().set_current_time(now);
			engine.play(&short_voice(), now).unwrap();
		}
		// The long voice is still live (it ends at 10 s plus its release) and the clock has passed it.
		engine.graph_mut().set_current_time(5.0);
		engine.play(&grouped, 5.0).unwrap();
		let record = engine.into_graph().finish(None);
		let calls = &record.nodes[1].params[0].1;
		assert!(calls.iter().any(|call| call == "cancel @5"), "{calls:?}");
	}
}
