// Shared per-orbit reverb and delay buses, made when a voice first sends to an orbit
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Orbit buses (`src/effects.ts`): the reverb and the delay a voice's `room` and `delay` sends feed.
//!
//! Every voice that sends to the same (output, orbit) pair shares one convolver and one delay line, which is
//! what makes fifteen or twenty simultaneous voices affordable. The room size and the delay settings are
//! last-writer-wins across the voices that share the orbit, which is why a track gives each distinct room size
//! its own orbit number.
//!
//! The reverb's impulse response is procedural: exponentially decaying noise, the standard textbook
//! algorithmic-reverb technique, two channels (a per-channel response decorrelates left and right for a wider
//! tail). Its noise comes from a seeded source keyed by the seed, the orbit, and the room size, so it depends
//! on nothing else: not on the order voices are booked in, nor on when the response is rebuilt.

use crate::graph::{BufferId, Graph, NodeId, NodeKind, ParamId, ParamKind};
use crate::math::{exp, js_max, ln};
use crate::noise::frame_count;
use undertone_pattern::random::SeededRandom;

const ROOM_SIZE_MIN_SECONDS: f64 = 0.3;
const ROOM_SIZE_MAX_SECONDS: f64 = 4.0;
const ROOM_SIZE_REFERENCE_RANGE: f64 = 9.0; // roomSize 1..10 spans 9 units
const IR_CHANNELS: u32 = 2;
const IR_DECAY_FLOOR: f64 = 0.001; // the envelope reaches this fraction of full scale by the buffer's end

/// How long the reverb tail of a room size is, in seconds.
///
/// The linear mapping only targets sizes in 1 to 10; below about 1.27 it would extrapolate past zero, which
/// would collapse the response to a near-empty buffer, so the output (not just the input) is floored at the
/// shortest documented room.
///
/// ```
/// use undertone_engine::effects::room_size_to_seconds;
/// assert_eq!(room_size_to_seconds(1.0), 0.3);
/// assert_eq!(room_size_to_seconds(-5.0), 0.3);
/// assert!((room_size_to_seconds(10.0) - 4.0).abs() < 1e-12);
/// ```
pub fn room_size_to_seconds(size: f64) -> f64 {
	let seconds = ROOM_SIZE_MIN_SECONDS
		+ ((size - 1.0) * (ROOM_SIZE_MAX_SECONDS - ROOM_SIZE_MIN_SECONDS))
			/ ROOM_SIZE_REFERENCE_RANGE;
	js_max(seconds, ROOM_SIZE_MIN_SECONDS)
}

/// Makes a synthetic reverb impulse response of `seconds`: exponentially decaying noise in two channels.
pub fn build_impulse_response<G: Graph>(
	graph: &mut G,
	seconds: f64,
	random: &mut SeededRandom,
) -> BufferId {
	let sample_rate = graph.sample_rate();
	let length = frame_count(sample_rate, seconds);
	let buffer = graph.create_buffer(IR_CHANNELS, length, sample_rate);
	let decay_rate = -ln(IR_DECAY_FLOOR);
	for channel in 0..IR_CHANNELS {
		let data = graph.buffer_channel_mut(buffer, channel);
		for (i, sample) in data.iter_mut().take(length).enumerate() {
			let envelope = exp(-decay_rate * (i as f64 / length as f64));
			*sample = ((random.next_value() * 2.0 - 1.0) * envelope) as f32;
		}
	}
	buffer
}

/// One orbit's reverb and delay on a graph.
#[derive(Debug, Clone)]
pub struct OrbitBus {
	/// Send a voice's reverb-wet signal here.
	pub reverb_input: NodeId,
	/// Send a voice's delay-wet signal here.
	pub delay_input: NodeId,
	pub(crate) convolver: NodeId,
	pub(crate) delay_time: ParamId,
	pub(crate) feedback_gain: ParamId,
	pub(crate) last_room_size: Option<f64>,
	pub(crate) last_delay_time: Option<f64>,
	pub(crate) last_delay_feedback: Option<f64>,
}

/// The longest delay the bus's delay line can hold, in seconds: generous headroom past the 0.1 to 0.35 s the
/// sample songs use.
pub const DELAY_MAX_SECONDS: f64 = 5.0;

impl OrbitBus {
	/// Makes the bus's nodes on `graph`, wet signals going to `output`. Creation order is the reference's:
	/// reverb input, convolver, delay input, delay line, delay output, feedback.
	pub(crate) fn create<G: Graph>(graph: &mut G, output: NodeId) -> Self {
		let reverb_input = graph.create_node(NodeKind::Gain);
		let convolver = graph.create_node(NodeKind::Convolver);
		graph.connect_node(reverb_input, convolver);
		graph.connect_node(convolver, output);

		let delay_input = graph.create_node(NodeKind::Gain);
		let delay_node = graph.create_node(NodeKind::Delay);
		let delay_output = graph.create_node(NodeKind::Gain);
		let feedback = graph.create_node(NodeKind::Gain);
		graph.connect_node(delay_input, delay_node);
		graph.connect_node(delay_node, delay_output);
		graph.connect_node(delay_output, output);
		graph.connect_node(delay_node, feedback);
		graph.connect_node(feedback, delay_node);
		Self {
			reverb_input,
			delay_input,
			convolver,
			delay_time: graph.param(delay_node, ParamKind::DelayTime),
			feedback_gain: graph.param(feedback, ParamKind::Gain),
			last_room_size: None,
			last_delay_time: None,
			last_delay_feedback: None,
		}
	}

	/// Regenerates the shared impulse response when `size` differs from what is loaded. Regenerating is real
	/// work, so a voice that asks for the room the bus already has costs nothing.
	pub(crate) fn set_room_size<G: Graph>(
		&mut self,
		graph: &mut G,
		size: f64,
		random: &mut SeededRandom,
	) {
		if self.last_room_size == Some(size) {
			return;
		}
		self.last_room_size = Some(size);
		let buffer = build_impulse_response(graph, room_size_to_seconds(size), random);
		graph.set_buffer(self.convolver, Some(buffer));
	}

	/// Updates the shared delay time and feedback when they differ from what is set. The change lands at
	/// `when`, so a booked voice's delay takes effect at its onset rather than when it was scheduled.
	pub(crate) fn set_delay<G: Graph>(
		&mut self,
		graph: &mut G,
		time: f64,
		feedback: f64,
		when: f64,
	) {
		if self.last_delay_time != Some(time) {
			self.last_delay_time = Some(time);
			graph.set_value_at_time(self.delay_time, time, when);
		}
		if self.last_delay_feedback != Some(feedback) {
			self.last_delay_feedback = Some(feedback);
			graph.set_value_at_time(self.feedback_gain, feedback, when);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::graph::LogGraph;
	use undertone_pattern::random::seeded_random;

	#[test]
	fn the_default_room_is_the_recorded_length() {
		// roomSize 3 at 44100 Hz: the corpus records 49490 frames.
		let mut graph = LogGraph::new(44_100.0, 2);
		let buffer = build_impulse_response(
			&mut graph,
			room_size_to_seconds(3.0),
			&mut seeded_random("ir"),
		);
		assert_eq!(graph.buffer_channel_mut(buffer, 0).len(), 49_490);
		assert_eq!(graph.buffer_channel_mut(buffer, 1).len(), 49_490);
	}

	#[test]
	fn the_response_decays() {
		let mut graph = LogGraph::new(1000.0, 2);
		let buffer = build_impulse_response(&mut graph, 1.0, &mut seeded_random("ir"));
		let data = graph.buffer_channel_mut(buffer, 0);
		let peak = |part: &[f32]| part.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
		assert!(peak(&data[..100]) > peak(&data[900..]) * 10.0);
	}
}
