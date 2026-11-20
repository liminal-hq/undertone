// Books one voice on a graph, node for node as the TypeScript playVoice does
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Voice booking: [`Engine::play`], [`Engine::play_to`], and [`Engine::play_params`] (`playVoice` and
//! `playParams` in `src/engine.ts`).
//!
//! The order of the calls is the reference's, because the order nodes are made in numbers them in a recorded
//! graph: the gain stage first, then the source, the FM modulator, the filters, the phaser, then the voice's
//! placement, then its sends to the orbit buses.

use crate::effects::OrbitBus;
use crate::engine::{
	BookedVoice, Engine, EnvelopeShape, Playback, RETIRE_AFTER_SECONDS, VoiceHandle, VoiceSlot,
	number_key,
};
use crate::graph::{
	BufferId, FilterType, Graph, NodeId, NodeKind, OscillatorType, ParamId, ParamKind, Scope,
	Target,
};
use crate::master::output_channels;
use crate::math::{js_max, js_min};
use crate::noise::{NoiseColour, build_noise_buffer};
use crate::pan::connect_output;
use crate::params::{FmEnvCurve, Pitch, SoundType, VoiceParams};
use crate::pitch_curve::{CurveEvent, apply_pitch_curve, build_pitch_curve};
use crate::waves::Waveform;
use std::sync::Arc;
use undertone_pattern::Result;
use undertone_pattern::js::number_to_string;
use undertone_pattern::pitch::note_to_frequency;

const DEFAULT_OSCILLATOR_FREQUENCY: f64 = 440.0;
const MAX_NOISE_BUFFER_SECONDS: f64 = 2.0; // longer gates loop the buffer instead of growing it
const STOP_TAIL_SECONDS: f64 = 0.02; // headroom past the last ramp so the ramp completes before stop()
const DEFAULT_ORBIT: f64 = 0.0;
const DEFAULT_SAMPLE_BASE_NOTE: &str = "c4"; // the pitch a sample registered without a base note is assumed to sound at
const PHASER_STAGE_COUNT: usize = 4; // series allpass filters; more stages, deeper notches
const PHASER_CENTER_HZ: f64 = 1000.0;
const PHASER_DEPTH_HZ: f64 = 600.0; // how far the LFO swings each stage's frequency around the centre
const EXP_RAMP_FLOOR: f64 = 1e-4; // lowest level an exponential envelope ramps to; effectively silent
const CUT_FADE_SECONDS: f64 = 0.005; // fast enough to feel like a choke, slow enough not to click

/// Which ramp an envelope uses.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ramp {
	Linear,
	Exponential,
}

/// Schedules an attack, decay, and release envelope on a parameter, ramping between `base` and `peak` rather
/// than assuming 0 is the floor (`scheduleEnvelope`): gain envelopes use a base of 0, filter envelopes use the
/// resting cutoff. Without `gate_end` the shape is percussive (the release starts as soon as the decay lands);
/// with it, the envelope holds at its sustain level until the gate closes, which gives pattern events their
/// note length. An exponential envelope floors its levels just above silence, since an exponential ramp is
/// undefined at or below 0.
#[allow(clippy::too_many_arguments)]
fn schedule_envelope<G: Graph>(
	graph: &mut G,
	param: ParamId,
	start: f64,
	base: f64,
	peak: f64,
	attack: f64,
	decay: f64,
	sustain_fraction: f64,
	release: f64,
	gate_end: Option<f64>,
	curve: Ramp,
) -> EnvelopeShape {
	let sustain_value = base + (peak - base) * sustain_fraction;
	let level = |v: f64| {
		if curve == Ramp::Exponential {
			js_max(v, EXP_RAMP_FLOOR)
		} else {
			v
		}
	};
	let ramp = |graph: &mut G, v: f64, t: f64| match curve {
		Ramp::Exponential => graph.exponential_ramp_to_value_at_time(param, level(v), t),
		Ramp::Linear => graph.linear_ramp_to_value_at_time(param, v, t),
	};

	graph.set_value_at_time(param, level(base), start);

	let attack_end = start + attack;
	if attack > 0.0 {
		ramp(graph, peak, attack_end);
	} else {
		graph.set_value_at_time(param, level(peak), start);
	}

	let decay_end = attack_end + decay;
	if decay > 0.0 {
		ramp(graph, sustain_value, decay_end);
	} else {
		graph.set_value_at_time(param, level(sustain_value), decay_end);
	}

	let release_start = match gate_end {
		Some(gate) => js_max(decay_end, gate),
		None => decay_end,
	};
	if release_start > decay_end {
		graph.set_value_at_time(param, level(sustain_value), release_start);
	}

	let release_end = release_start + release;
	if release > 0.0 {
		ramp(graph, base, release_end);
	}
	EnvelopeShape {
		start,
		base,
		peak,
		attack_end,
		decay_end,
		sustain_value,
		release_start,
		release_end,
		release,
	}
}

fn noise_colour(sound_type: Option<SoundType>) -> Option<NoiseColour> {
	match sound_type {
		Some(SoundType::White) => Some(NoiseColour::White),
		Some(SoundType::Pink) => Some(NoiseColour::Pink),
		Some(SoundType::Brown) => Some(NoiseColour::Brown),
		_ => None,
	}
}

fn frequency_of(pitch: &Pitch) -> Result<f64> {
	match pitch {
		Pitch::Name(name) => note_to_frequency(name.as_str()),
		Pitch::Hz(hz) => note_to_frequency(*hz),
	}
}

impl<G: Graph> Engine<G> {
	/// Whether booking `params` books nothing: a sample voice whose buffer is not available (the name is not
	/// registered, or registered but its PCM has not been handed over yet). It is the one place that rule
	/// lives, so anything that must know which voices will really sound, such as an offline render's room-size
	/// look-ahead, asks here. Unlike booking, asking does not warn about an unregistered name (the reference's
	/// look-ahead does, through the same lookup); the booking of the voice does.
	pub fn is_voice_skipped(&self, params: &VoiceParams) -> bool {
		params.sample_name.as_deref().is_some_and(|name| {
			let key = self.samples.lookup_key(name, params.sample_bank.as_deref());
			!(self.sample_buffers.contains_key(&key) || self.samples.entry_data(&key).is_some())
		})
	}

	/// The graph buffer of a sample (`getSampleBuffer`): the one this engine already made from it, else one
	/// made now from the registry. `None` skips the voice: an unregistered name warns once (until the registry
	/// is cleared), and a registered name whose PCM has not arrived is skipped silently and noted for the host
	/// to decode ([`Engine::take_requested_samples`]).
	fn sample_buffer(&mut self, name: &str, bank: Option<&str>) -> Option<BufferId> {
		let key = self.samples.lookup_key(name, bank);
		if let Some(buffer) = self.sample_buffers.get(&key) {
			return Some(*buffer);
		}
		if !self.samples.has_entry(&key) {
			if self.samples.first_warning(&key) {
				self.warnings.give(
					format!("sample:{key}"),
					format!(
						"undertone: sample \"{key}\" is not registered \u{2014} voice skipped. Call registerSample() first."
					),
				);
			}
			return None;
		}
		let Some(data) = self.samples.entry_data(&key).map(Arc::clone) else {
			if !self.requested_samples.contains(&key) {
				self.requested_samples.push(key);
			}
			return None;
		};
		let buffer =
			self.graph
				.create_buffer(data.channels.len() as u32, data.frames(), data.sample_rate);
		for (channel, samples) in data.channels.iter().enumerate() {
			self.graph
				.buffer_channel_mut(buffer, channel as u32)
				.copy_from_slice(samples);
		}
		self.sample_buffers.insert(key, buffer);
		Some(buffer)
	}

	/// Books one voice at `start_time` (seconds on the graph's clock) to the engine's output.
	///
	/// # Errors
	///
	/// A pitch that is not a note name or not a finite frequency above zero fails with the reference's
	/// message. A room size whose reverb would be longer than 60 seconds (`MAX_BUFFER_SECONDS`,
	/// a deliberate bound the TypeScript does not have; its `createBuffer` throws a `RangeError` for what
	/// it cannot allocate), or that is infinite or not a number, fails with a message naming the room, and
	/// so does a noise buffer of such a length. Nodes made before the failure stay on the graph, as they do
	/// in the reference.
	pub fn play(&mut self, params: &VoiceParams, start_time: f64) -> Result<Playback> {
		self.play_to(self.output, params, start_time)
	}

	/// Books every voice of `voices` at `when` (default: the graph's clock now), each offset by its own nudge
	/// (`playParams`). The playbacks come back in order; a host that wants one handle covers them with the
	/// earliest start and the latest end.
	pub fn play_params(
		&mut self,
		voices: &[VoiceParams],
		when: Option<f64>,
	) -> Result<Vec<Playback>> {
		let when = when.unwrap_or_else(|| self.graph.current_time());
		voices.iter().map(|voice| self.play(voice, when)).collect()
	}

	/// Like [`Engine::play`], to another output node than the engine's: a game's own mix bus, say. Orbit buses
	/// and cut groups are per output, as the reference keys them.
	///
	/// # Errors
	///
	/// As [`Engine::play`].
	pub fn play_to(
		&mut self,
		output: NodeId,
		params: &VoiceParams,
		start_time: f64,
	) -> Result<Playback> {
		let sample = match params.sample_name.as_deref() {
			Some(name) => match self.sample_buffer(name, params.sample_bank.as_deref()) {
				Some(buffer) => Some(buffer),
				None => {
					let skipped_at = js_max(start_time + params.nudge_time, 0.0);
					return Ok(Playback {
						start_time: skipped_at,
						end_time: skipped_at,
						voice: None,
					});
				}
			},
			None => None,
		};

		// Everything the voice makes on the graph is one scope, retired once the voice is over.
		self.graph.begin_scope();
		let booked = self.book_voice(output, params, start_time, sample);
		let scope = self.graph.end_scope();
		match booked {
			Ok(playback) => {
				if scope != Scope::NONE
					&& let Some(voice) = playback
						.voice
						.and_then(|handle| self.voices[handle.slot].voice.as_mut())
				{
					voice.scope = scope;
				}
				Ok(playback)
			}
			Err(error) => {
				// The nodes made before the failure stay on the graph, never started; give them back soon.
				if scope != Scope::NONE {
					self.retiring.push((js_max(start_time, 0.0), scope));
				}
				Err(error)
			}
		}
	}

	/// Books the voice's nodes (the part of [`Engine::play_to`] inside the voice's scope).
	fn book_voice(
		&mut self,
		output: NodeId,
		params: &VoiceParams,
		start_time: f64,
		sample: Option<BufferId>,
	) -> Result<Playback> {
		// Clamp to the graph's origin: real parameters and sources throw on negative times.
		let voice_start = js_max(start_time + params.nudge_time, 0.0);
		// A gate is only meaningful when there is a sustain level to hold; with sustain 0 the voice is silent
		// after its decay, so holding (and keeping the nodes alive for the whole event) would be waste.
		let gate_end = match params.duration {
			Some(duration) if params.sustain > 0.0 => Some(voice_start + duration),
			_ => None,
		};

		let gain_node = self.graph.create_node(NodeKind::Gain);
		let gain_param = self.graph.param(gain_node, ParamKind::Gain);
		let gain_envelope = schedule_envelope(
			&mut self.graph,
			gain_param,
			voice_start,
			0.0,
			params.gain_level * params.velocity.unwrap_or(1.0),
			params.attack,
			params.decay,
			params.sustain,
			params.release,
			gate_end,
			Ramp::Linear,
		);
		let gain_release_end = gain_envelope.end();

		let mut filter_release_end = gain_release_end;
		let mut fm_modulator: Option<NodeId> = None;

		let colour = noise_colour(params.sound_type);
		let source = if sample.is_some() || colour.is_some() {
			self.graph.create_node(NodeKind::BufferSource)
		} else {
			self.graph.create_node(NodeKind::Oscillator)
		};

		if let Some(buffer) = sample {
			// A recorded sample plays at the speed that moves its base note to the event's pitch, and does not
			// loop (a long gate holds the voice, it does not repeat the recording).
			self.graph.set_buffer(source, Some(buffer));
			let rate = match &params.pitch {
				Some(pitch) => {
					let base = self
						.samples
						.get_sample_base_note(
							params.sample_name.as_deref().unwrap_or_default(),
							params.sample_bank.as_deref(),
						)
						.cloned()
						.unwrap_or_else(|| Pitch::Name(DEFAULT_SAMPLE_BASE_NOTE.into()));
					frequency_of(pitch)? / frequency_of(&base)?
				}
				None => 1.0,
			};
			let playback_rate = self.graph.param(source, ParamKind::PlaybackRate);
			self.graph
				.set_value_at_time(playback_rate, rate, voice_start);
		} else if let Some(colour) = colour {
			// Cap the synchronously generated buffer and loop it for longer gates, rather than allocating
			// multi-second buffers for every cycle of a slow looped noise pattern.
			let audible_seconds = js_max(gain_release_end - voice_start, 0.05);
			let buffer_duration = js_min(audible_seconds, MAX_NOISE_BUFFER_SECONDS);
			let mut random = self.context_random(&format!(
				"noise|{}|{}",
				colour.name(),
				number_to_string(start_time)
			));
			let buffer = build_noise_buffer(&mut self.graph, colour, buffer_duration, &mut random)?;
			self.graph.set_buffer(source, Some(buffer));
			self.graph
				.set_loop(source, audible_seconds > buffer_duration);
		} else {
			if let Some(waveform) = params.sound_type.and_then(Waveform::from_sound_type) {
				self.shaped_waves.apply(&mut self.graph, source, waveform);
			}
			let target_freq = match &params.pitch {
				Some(pitch) => frequency_of(pitch)?,
				None => DEFAULT_OSCILLATOR_FREQUENCY,
			};
			let curve = build_pitch_curve(params, voice_start, &mut self.warnings);
			let frequency = self.graph.param(source, ParamKind::Frequency);
			apply_pitch_curve(&mut self.graph, frequency, target_freq, &curve);
			if params.fm_index.is_some_and(|index| index > 0.0) {
				fm_modulator =
					Some(self.connect_fm(source, target_freq, &curve, params, voice_start));
			}
		}

		let mut tail = source;

		if let Some(cutoff) = params.filter_cutoff {
			let filter = self.graph.create_node(NodeKind::BiquadFilter);
			self.graph.set_filter_type(filter, FilterType::Lowpass);
			let frequency = self.graph.param(filter, ParamKind::Frequency);
			filter_release_end = schedule_envelope(
				&mut self.graph,
				frequency,
				voice_start,
				cutoff,
				cutoff + params.filter_env_amount,
				params.filter_attack,
				params.filter_decay,
				params.filter_sustain,
				params.filter_release,
				gate_end,
				Ramp::Linear,
			)
			.end();
			self.graph.connect_node(tail, filter);
			tail = filter;
		}

		// Neither insert below has its own envelope, so the filter's release end is already final here: safe to
		// compute the voice's end now and reuse it for the phaser's LFO stop time and the source's own stop.
		let voice_end = js_max(gain_release_end, filter_release_end) + STOP_TAIL_SECONDS;

		if let Some(cutoff) = params.hpf_cutoff {
			let hpf = self.graph.create_node(NodeKind::BiquadFilter);
			self.graph.set_filter_type(hpf, FilterType::Highpass);
			let frequency = self.graph.param(hpf, ParamKind::Frequency);
			self.graph.set_value_at_time(frequency, cutoff, voice_start);
			self.graph.connect_node(tail, hpf);
			tail = hpf;
		}

		let mut stoppables = vec![source];
		if let Some(modulator) = fm_modulator {
			stoppables.push(modulator);
		}
		if let Some(rate) = params.phaser_rate {
			tail = self.connect_phaser(tail, rate, voice_start, voice_end, &mut stoppables);
		}

		self.graph.connect_node(tail, gain_node);

		let available = output_channels(&self.graph, output) as usize;
		let placed = connect_output(
			&mut self.graph,
			&mut self.warnings,
			output,
			available,
			gain_node,
			params,
			voice_start,
			voice_end,
			&mut stoppables,
		);
		self.connect_effect_sends(output, placed.node, params, voice_start)?;

		self.graph.start(source, voice_start);
		self.graph.stop(source, voice_end);
		if let Some(modulator) = fm_modulator {
			self.graph.start(modulator, voice_start);
			self.graph.stop(modulator, voice_end);
		}

		self.drop_finished_voices();
		let handle = self.keep_voice(BookedVoice {
			end: voice_end,
			gain: gain_param,
			envelope: gain_envelope,
			stoppables,
			pan_paths: placed.pan_paths,
			scope: Scope::NONE,
		});
		let playback = Playback {
			start_time: voice_start,
			end_time: voice_end,
			voice: Some(handle),
		};
		if let Some(group) = params.cut_group {
			self.claim_cut_group(output, group, playback);
		}
		Ok(playback)
	}

	/// Forgets the voices whose end (release tail included) is before the graph's clock, so a long session
	/// does not keep a record for every voice it ever booked. Each freed slot has its generation raised, so
	/// an old [`Playback`] for it is ignored by [`Engine::stop`].
	///
	/// The current voice of each cut group is always kept: a voice booked later with an earlier start still
	/// chokes at the holder's onset, as it would without this, so the list stays bounded by the live voices
	/// plus one per cut group.
	fn drop_finished_voices(&mut self) {
		let now = self.graph.current_time();
		let holders: Vec<VoiceHandle> = self
			.cut_groups
			.values()
			.filter_map(|playback| playback.voice)
			.collect();
		for (index, slot) in self.voices.iter_mut().enumerate() {
			let finished = slot.voice.as_ref().is_some_and(|voice| voice.end < now);
			let held = holders
				.iter()
				.any(|handle| handle.engine == self.id && handle.slot == index);
			if finished && !held {
				if let Some(voice) = slot.voice.take()
					&& voice.scope != Scope::NONE
				{
					self.retiring.push((voice.end, voice.scope));
				}
				slot.generation += 1;
				self.free_slots.push(index);
			}
		}
		self.retire_due(now);
	}

	/// Tells the graph to retire the nodes of every voice that ended more than [`RETIRE_AFTER_SECONDS`] ago.
	fn retire_due(&mut self, now: f64) {
		let graph = &mut self.graph;
		self.retiring.retain(|(end, scope)| {
			if end + RETIRE_AFTER_SECONDS < now {
				graph.retire_scope(*scope);
				false
			} else {
				true
			}
		});
	}

	/// Keeps a booked voice in the slab, in a freed slot when there is one, and returns its handle.
	fn keep_voice(&mut self, voice: BookedVoice) -> VoiceHandle {
		let slot = match self.free_slots.pop() {
			Some(slot) => slot,
			None => {
				self.voices.push(VoiceSlot {
					generation: 0,
					voice: None,
				});
				self.voices.len() - 1
			}
		};
		self.voices[slot].voice = Some(voice);
		VoiceHandle {
			engine: self.id,
			slot,
			generation: self.voices[slot].generation,
		}
	}

	/// Stops the previous voice in `group` at the new voice's onset, then records `playback` as the group's
	/// current voice. A voice booked out of order is itself choked at the holder's onset, and the holder stays
	/// the group's owner.
	fn claim_cut_group(&mut self, output: NodeId, group: f64, playback: Playback) {
		let key = (output, number_key(group));
		let previous = self.cut_groups.get(&key).copied();
		if let Some(previous) = previous {
			if previous.start_time < playback.start_time {
				self.stop(previous, Some(playback.start_time), Some(CUT_FADE_SECONDS));
			} else if playback.start_time < previous.start_time {
				self.stop(playback, Some(previous.start_time), Some(CUT_FADE_SECONDS));
				return;
			}
		}
		self.cut_groups.insert(key, playback);
	}

	/// Adds an FM modulator to a carrier oscillator: a second oscillator at `fmHarmonicity` times the
	/// carrier's frequency feeds a depth gain whose output is added to the carrier's frequency. The depth is
	/// index times modulator frequency in hertz, so brightness follows pitch, and it follows the carrier's
	/// pitch curve exactly because all three are driven by the same ratios. An optional envelope gain shapes
	/// the depth over the note. The modulator still has to be started and stopped with the carrier's window.
	fn connect_fm(
		&mut self,
		carrier: NodeId,
		carrier_hz: f64,
		curve: &[CurveEvent],
		params: &VoiceParams,
		voice_start: f64,
	) -> NodeId {
		let harmonicity = params.fm_harmonicity.unwrap_or(1.0);
		let index = params.fm_index.unwrap_or(0.0);

		let modulator = self.graph.create_node(NodeKind::Oscillator);
		let wave = params
			.fm_wave
			.map_or(Waveform::Native(OscillatorType::Sine), Waveform::from);
		self.shaped_waves.apply(&mut self.graph, modulator, wave);
		let modulator_frequency = self.graph.param(modulator, ParamKind::Frequency);
		apply_pitch_curve(
			&mut self.graph,
			modulator_frequency,
			carrier_hz * harmonicity,
			curve,
		);

		let depth = self.graph.create_node(NodeKind::Gain);
		let depth_gain = self.graph.param(depth, ParamKind::Gain);
		apply_pitch_curve(
			&mut self.graph,
			depth_gain,
			carrier_hz * harmonicity * index,
			curve,
		);
		self.graph.connect_node(modulator, depth);

		let carrier_frequency = self.graph.param(carrier, ParamKind::Frequency);
		let has_envelope = params.fm_attack.is_some()
			|| params.fm_decay.is_some()
			|| params.fm_sustain.is_some()
			|| params.fm_release.is_some();
		if has_envelope {
			// A decay with no sustain falls toward silence; otherwise the depth holds.
			let sustain =
				params
					.fm_sustain
					.unwrap_or(if params.fm_decay.is_some() { 0.0 } else { 1.0 });
			let envelope = self.graph.create_node(NodeKind::Gain);
			let envelope_gain = self.graph.param(envelope, ParamKind::Gain);
			schedule_envelope(
				&mut self.graph,
				envelope_gain,
				voice_start,
				0.0,
				1.0,
				params.fm_attack.unwrap_or(0.0),
				params.fm_decay.unwrap_or(0.0),
				sustain,
				params.fm_release.unwrap_or(0.0),
				// The modulator holds for the gate on its own sustain, independent of the carrier's.
				match params.duration {
					Some(duration) if sustain > 0.0 => Some(voice_start + duration),
					_ => None,
				},
				match params.fm_env_curve.unwrap_or(FmEnvCurve::Exp) {
					FmEnvCurve::Exp => Ramp::Exponential,
					FmEnvCurve::Lin => Ramp::Linear,
				},
			);
			self.graph.connect_node(depth, envelope);
			self.graph
				.connect(envelope, Target::Param(carrier_frequency), 0, 0);
		} else {
			self.graph
				.connect(depth, Target::Param(carrier_frequency), 0, 0);
		}
		modulator
	}

	/// Inserts a four-stage series allpass phaser: one LFO drives every stage's frequency together through a
	/// shared depth gain, so the notches sweep in lockstep rather than independently. Returns the new tail.
	fn connect_phaser(
		&mut self,
		input: NodeId,
		rate_hz: f64,
		voice_start: f64,
		voice_end: f64,
		stoppables: &mut Vec<NodeId>,
	) -> NodeId {
		let lfo = self.graph.create_node(NodeKind::Oscillator);
		self.graph.set_oscillator_type(lfo, OscillatorType::Sine);
		let lfo_frequency = self.graph.param(lfo, ParamKind::Frequency);
		self.graph
			.set_value_at_time(lfo_frequency, rate_hz, voice_start);

		let depth = self.graph.create_node(NodeKind::Gain);
		let depth_gain = self.graph.param(depth, ParamKind::Gain);
		self.graph
			.set_value_at_time(depth_gain, PHASER_DEPTH_HZ, voice_start);
		self.graph.connect_node(lfo, depth);

		let mut tail = input;
		for _ in 0..PHASER_STAGE_COUNT {
			let stage = self.graph.create_node(NodeKind::BiquadFilter);
			self.graph.set_filter_type(stage, FilterType::Allpass);
			let frequency = self.graph.param(stage, ParamKind::Frequency);
			self.graph
				.set_value_at_time(frequency, PHASER_CENTER_HZ, voice_start);
			self.graph.connect(depth, Target::Param(frequency), 0, 0);
			self.graph.connect_node(tail, stage);
			tail = stage;
		}

		self.graph.start(lfo, voice_start);
		self.graph.stop(lfo, voice_end);
		stoppables.push(lfo);
		tail
	}

	/// Routes `final_node` through a fresh send gain at `level`, into `target`.
	fn connect_send(&mut self, final_node: NodeId, target: NodeId, level: f64, voice_start: f64) {
		let send = self.graph.create_node(NodeKind::Gain);
		let send_gain = self.graph.param(send, ParamKind::Gain);
		self.graph.set_value_at_time(send_gain, level, voice_start);
		self.graph.connect_node(final_node, send);
		self.graph.connect_node(send, target);
	}

	/// Makes the bus of `orbit` on `output` the first time it is needed, and returns its key.
	fn ensure_orbit_bus(&mut self, output: NodeId, orbit: f64) -> (NodeId, u64) {
		let key = (output, number_key(orbit));
		if !self.buses.contains_key(&key) {
			// The bus outlives the voice that first needs it: its nodes belong to no voice's scope.
			self.graph.begin_shared();
			let bus = OrbitBus::create(&mut self.graph, output);
			self.graph.end_shared();
			self.buses.insert(key, bus);
		}
		key
	}

	/// The shared reverb and delay bus of an orbit, made the first time it is asked for (`getOrbitBus`). `output`
	/// is where the wet signal goes (the engine's output when `None`): a bus belongs to one output and one orbit
	/// number, as voices find it. The returned [`OrbitBus`] is a copy that names the bus's two inputs
	/// ([`OrbitBus::reverb_input`], [`OrbitBus::delay_input`]) so a host can feed them from its own nodes; configure
	/// the bus with [`Engine::set_orbit_room_size`] and [`Engine::set_orbit_delay`].
	///
	/// ```
	/// use undertone_engine::engine::{Engine, OutputSetup};
	/// use undertone_engine::graph::LogGraph;
	///
	/// let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default())?;
	/// let bus = engine.orbit_bus(2.0, None);
	/// // Asking again finds the same bus.
	/// assert_eq!(engine.orbit_bus(2.0, None).reverb_input, bus.reverb_input);
	/// assert_ne!(engine.orbit_bus(3.0, None).reverb_input, bus.reverb_input);
	/// # Ok::<(), undertone_pattern::Error>(())
	/// ```
	pub fn orbit_bus(&mut self, orbit: f64, output: Option<NodeId>) -> OrbitBus {
		let output = output.unwrap_or(self.output);
		let key = self.ensure_orbit_bus(output, orbit);
		self.buses[&key].clone()
	}

	/// Sets the room size of an orbit's bus (`OrbitBus.setRoomSize`), regenerating its impulse response only when
	/// the size differs from what is loaded. The response is made from the engine's seed, the orbit, and the size,
	/// as a voice's `roomsize` makes it, so it is repeatable.
	///
	/// # Errors
	///
	/// A room that cannot be made (not a number, or over 60 seconds) fails with a message naming the room, and
	/// leaves the bus as it was.
	pub fn set_orbit_room_size(
		&mut self,
		orbit: f64,
		output: Option<NodeId>,
		size: f64,
	) -> Result<()> {
		let output = output.unwrap_or(self.output);
		let key = self.ensure_orbit_bus(output, orbit);
		let mut bus = self.buses.remove(&key).expect("the bus was just made");
		let mut made = Ok(());
		if bus.last_room_size != Some(size) {
			let mut random = self.keyed_random(&format!(
				"ir|{}|{}",
				number_to_string(orbit),
				number_to_string(size)
			));
			self.graph.begin_shared();
			made = bus.set_room_size(&mut self.graph, size, &mut random);
			self.graph.end_shared();
		}
		self.buses.insert(key, bus);
		made
	}

	/// Sets the delay time (seconds) and feedback of an orbit's bus (`OrbitBus.setDelay`), from the graph's clock
	/// now. A value the bus already has is not set again.
	pub fn set_orbit_delay(
		&mut self,
		orbit: f64,
		output: Option<NodeId>,
		time: f64,
		feedback: f64,
	) {
		let output = output.unwrap_or(self.output);
		let key = self.ensure_orbit_bus(output, orbit);
		let when = self.graph.current_time();
		let mut bus = self.buses.remove(&key).expect("the bus was just made");
		bus.set_delay(&mut self.graph, time, feedback, when);
		self.buses.insert(key, bus);
	}

	/// Sends the finished voice to its orbit's shared reverb and delay buses when room or delay levels are
	/// set. The sends are after placement, so the wet signal follows pan and channels as the dry signal does.
	/// With neither level set there is no orbit bus lookup at all.
	fn connect_effect_sends(
		&mut self,
		output: NodeId,
		final_node: NodeId,
		params: &VoiceParams,
		voice_start: f64,
	) -> Result<()> {
		let room = params.room_level.filter(|level| *level > 0.0);
		let delay = params.delay_level.filter(|level| *level > 0.0);
		if room.is_none() && delay.is_none() {
			return Ok(());
		}

		let orbit = params.orbit.unwrap_or(DEFAULT_ORBIT);
		let key = self.ensure_orbit_bus(output, orbit);
		let mut bus = self.buses.remove(&key).expect("the bus was just made");

		if let Some(level) = room {
			// The response depends only on the seed, the orbit, and the room size (never on booking order).
			if bus.last_room_size != Some(params.room_size) {
				let mut random = self.keyed_random(&format!(
					"ir|{}|{}",
					number_to_string(orbit),
					number_to_string(params.room_size)
				));
				self.graph.begin_shared();
				let made = bus.set_room_size(&mut self.graph, params.room_size, &mut random);
				self.graph.end_shared();
				if let Err(error) = made {
					self.buses.insert(key, bus);
					return Err(error);
				}
			}
			self.connect_send(final_node, bus.reverb_input, level, voice_start);
		}

		if let Some(level) = delay {
			let when = js_max(voice_start, self.graph.current_time());
			bus.set_delay(
				&mut self.graph,
				params.delay_time,
				params.delay_feedback,
				when,
			);
			self.connect_send(final_node, bus.delay_input, level, voice_start);
		}
		self.buses.insert(key, bus);
		Ok(())
	}
}
