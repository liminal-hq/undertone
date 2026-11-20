// RecordGraph: a Graph that records the engine's Web Audio calls as fixed-width numeric records to replay in JavaScript
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`RecordGraph`], the [`Graph`] the main module's engine books on (RF-26): every call becomes one record of
//! [`WIDTH`] numbers in a flat `f64` list, which the Web Audio backend (`packages/undertone/src/webaudio.ts`) replays
//! on the caller's `AudioContextLike` as the same calls in the same order, so the graph it builds is the one the
//! TypeScript engine builds. The format is section 12 of `docs/rust-migration/results/M6-BOUNDARY.md`.
//!
//! - **A record** is `[op, a, b, c, d, e]`: the op code ([`Op`]) and up to five operands; unused operands are 0.
//! - **Ids are numbers.** A node is its index in creation order (0 is the destination; an id the host adopted with
//!   [`RecordGraph::adopt`] is a node the host made itself), a buffer or curve its index among the buffers, a periodic
//!   wave its index among the waves. Enumerations (node kinds, parameters, oscillator and filter types, oversampling,
//!   channel modes) are small integers whose names are [`NAMES`], so the replayer never hard-codes them.
//! - **Sample data travels beside the records,** in one `f32` list: an audio buffer's channels one after another, a
//!   curve's samples, a wave's real then imaginary coefficients, each at the offset its record names. An audio buffer's
//!   samples are written by the engine after `createBuffer`, so they are copied into the side list when the records
//!   are taken ([`RecordGraph::take`]), never before.
//! - **Releases:** a voice's nodes and buffers are named once in [`Op::Release`] and [`Op::ReleaseBuffer`] records when
//!   the engine retires them (and a buffer the engine no longer needs, such as a replaced impulse response), so the
//!   replayer can drop its references and its tables stay as small as the sounding voices. Web Audio sees no call for
//!   them (the browser collects a finished node itself).

use std::collections::BTreeMap;

use undertone::engine::effects::DELAY_MAX_SECONDS;
use undertone::engine::graph::{
	Automation, BufferId, ChannelCountMode, ChannelInterpretation, FilterType, Graph, NodeId,
	NodeKind, OscillatorType, Oversample, ParamId, ParamKind, Scope, Target, WaveId,
};

/// Numbers in one record.
pub const WIDTH: usize = 6;

/// The op codes of a record, in the order of [`NAMES`]' `ops` list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Op {
	/// `[0, node, kind, argument]`: `ctx.create<Kind>()`, with the argument a merger's `createChannelMerger(inputs)` and a
	/// delay's `createDelay(maxDelayTime)` take (0 for the others).
	Create,
	/// `[1, node, param, value, time]`: `setValueAtTime`.
	Set,
	/// `[2, node, param, value, time]`: `linearRampToValueAtTime`.
	Linear,
	/// `[3, node, param, value, time]`: `exponentialRampToValueAtTime`.
	Exponential,
	/// `[4, node, param, value, time, timeConstant]`: `setTargetAtTime`.
	Target,
	/// `[5, node, param, time]`: `cancelScheduledValues`.
	Cancel,
	/// `[6, node, type]`: `oscillator.type = type`.
	OscillatorType,
	/// `[7, node, wave]`: `oscillator.setPeriodicWave(wave)`.
	PeriodicWave,
	/// `[8, node, type]`: `filter.type = type`.
	FilterType,
	/// `[9, node, buffer]`: `node.buffer = buffer` (a buffer source or a convolver), `-1` for `null`.
	Buffer,
	/// `[10, node, loop]`: `source.loop = loop` (1 or 0).
	Loop,
	/// `[11, node, curve]`: `shaper.curve = curve`, `-1` for `null`.
	Curve,
	/// `[12, node, oversample]`: `shaper.oversample = oversample`.
	Oversample,
	/// `[13, node, count]`: `node.channelCount = count`.
	ChannelCount,
	/// `[14, node, mode]`: `node.channelCountMode = mode`.
	ChannelCountMode,
	/// `[15, node, interpretation]`: `node.channelInterpretation = interpretation`.
	ChannelInterpretation,
	/// `[16, from, to, param, output, input]`: `from.connect(to[.param], output, input)`; `param` is `-1` for the node's input.
	Connect,
	/// `[17, node]`: `node.disconnect()`.
	Disconnect,
	/// `[18, node, when]`: `source.start(when)`.
	Start,
	/// `[19, node, when]`: `source.stop(when)`.
	Stop,
	/// `[20, buffer, channels, length, sampleRate, offset]`: `ctx.createBuffer(channels, length, sampleRate)`, then each
	/// channel's `getChannelData(c).set(...)` from the side data at `offset + c * length`.
	CreateBuffer,
	/// `[21, buffer, length, offset]`: a `Float32Array` curve of `length` samples from the side data.
	CreateCurve,
	/// `[22, wave, length, offset, disableNormalization]`: `ctx.createPeriodicWave(real, imag, { disableNormalization })`,
	/// `real` and then `imag` (`length` each) from the side data.
	CreateWave,
	/// `[23, node]`: the engine retired the node; the replayer may forget it (no Web Audio call).
	Release,
	/// `[24, buffer]`: the engine retired the buffer (a voice's noise, a replaced impulse response); the replayer may
	/// forget it (no Web Audio call).
	ReleaseBuffer,
}

/// The names behind the numbers of a record, for the replayer: one list per enumeration, indexed by the number.
pub struct Names {
	/// The op codes, as [`Op`] names them (camelCase).
	pub ops: &'static [&'static str],
	/// The node kinds of [`Op::Create`]: the `ctx` factory names without `create`.
	pub kinds: &'static [&'static str],
	/// The parameters of the automation records and of [`Op::Connect`].
	pub params: &'static [&'static str],
	/// Oscillator types.
	pub oscillator_types: &'static [&'static str],
	/// Filter types.
	pub filter_types: &'static [&'static str],
	/// Wave-shaper oversampling.
	pub oversample: &'static [&'static str],
	/// Channel count modes.
	pub channel_count_modes: &'static [&'static str],
	/// Channel interpretations.
	pub channel_interpretations: &'static [&'static str],
}

/// The names of every number a record holds.
pub static NAMES: Names = Names {
	ops: &[
		"create",
		"set",
		"linear",
		"exponential",
		"target",
		"cancel",
		"oscillatorType",
		"periodicWave",
		"filterType",
		"buffer",
		"loop",
		"curve",
		"oversample",
		"channelCount",
		"channelCountMode",
		"channelInterpretation",
		"connect",
		"disconnect",
		"start",
		"stop",
		"createBuffer",
		"createCurve",
		"createWave",
		"release",
		"releaseBuffer",
	],
	kinds: &[
		"Oscillator",
		"Gain",
		"BiquadFilter",
		"StereoPanner",
		"ChannelMerger",
		"BufferSource",
		"Convolver",
		"Delay",
		"DynamicsCompressor",
		"WaveShaper",
	],
	params: &[
		"frequency",
		"gain",
		"Q",
		"pan",
		"delayTime",
		"threshold",
		"knee",
		"ratio",
		"attack",
		"release",
		"playbackRate",
	],
	oscillator_types: &["sine", "square", "sawtooth", "triangle"],
	filter_types: &[
		"lowpass",
		"highpass",
		"bandpass",
		"lowshelf",
		"highshelf",
		"peaking",
		"notch",
		"allpass",
	],
	oversample: &["none", "2x", "4x"],
	channel_count_modes: &["max", "clamped-max", "explicit"],
	channel_interpretations: &["speakers", "discrete"],
};

fn kind_code(kind: NodeKind) -> (f64, f64) {
	match kind {
		NodeKind::Oscillator => (0.0, 0.0),
		NodeKind::Gain => (1.0, 0.0),
		NodeKind::BiquadFilter => (2.0, 0.0),
		NodeKind::StereoPanner => (3.0, 0.0),
		NodeKind::ChannelMerger { inputs } => (4.0, f64::from(inputs)),
		NodeKind::BufferSource => (5.0, 0.0),
		NodeKind::Convolver => (6.0, 0.0),
		NodeKind::Delay => (7.0, DELAY_MAX_SECONDS),
		NodeKind::DynamicsCompressor => (8.0, 0.0),
		NodeKind::WaveShaper => (9.0, 0.0),
	}
}

fn param_code(kind: ParamKind) -> f64 {
	f64::from(match kind {
		ParamKind::Frequency => 0_u8,
		ParamKind::Gain => 1,
		ParamKind::Q => 2,
		ParamKind::Pan => 3,
		ParamKind::DelayTime => 4,
		ParamKind::Threshold => 5,
		ParamKind::Knee => 6,
		ParamKind::Ratio => 7,
		ParamKind::Attack => 8,
		ParamKind::Release => 9,
		ParamKind::PlaybackRate => 10,
	})
}

/// An audio buffer whose samples the engine is still writing: kept until the records are taken.
#[derive(Debug)]
struct Pending {
	/// Where its [`Op::CreateBuffer`] record starts in the record list.
	record: usize,
	channels: Vec<Vec<f32>>,
}

/// The ids made while a scope was open.
#[derive(Debug, Default)]
struct OpenScope {
	nodes: Vec<u32>,
	buffers: Vec<u32>,
}

/// What [`RecordGraph::take`] hands over: the records and their side data.
#[derive(Debug, Default, PartialEq)]
pub struct Taken {
	/// The records, [`WIDTH`] numbers each.
	pub ops: Vec<f64>,
	/// The samples the records point into.
	pub data: Vec<f32>,
}

/// A [`Graph`] that records every call as a numeric record. See the [module documentation](self).
#[derive(Debug)]
pub struct RecordGraph {
	sample_rate: f64,
	time: f64,
	channels: u32,
	max_channels: u32,
	nodes: u32,
	buffers: u32,
	waves: u32,
	ops: Vec<f64>,
	data: Vec<f32>,
	pending: BTreeMap<u32, Pending>,
	/// Scopes still open, innermost last; `None` for a shared stretch, whose nodes belong to no scope.
	open: Vec<Option<OpenScope>>,
	/// Closed scopes not yet retired, by number.
	closed: BTreeMap<u32, OpenScope>,
	next_scope: u32,
}

impl RecordGraph {
	/// A recorder for a context of `sample_rate` hertz whose destination has `channels` channels now and can have up
	/// to `max_channels` (`ctx.destination.channelCount` and `.maxChannelCount`).
	pub fn new(sample_rate: f64, channels: u32, max_channels: u32) -> Self {
		Self {
			sample_rate,
			time: 0.0,
			channels,
			max_channels,
			nodes: 1,
			buffers: 0,
			waves: 0,
			ops: Vec::new(),
			data: Vec::new(),
			pending: BTreeMap::new(),
			open: Vec::new(),
			closed: BTreeMap::new(),
			next_scope: 1,
		}
	}

	/// Sets the context's clock (`ctx.currentTime`), which the engine reads for "now".
	pub fn set_current_time(&mut self, seconds: f64) {
		self.time = seconds;
	}

	/// Sets the destination's channel count as the host's context has it now.
	pub fn set_destination_channels(&mut self, channels: u32) {
		self.channels = channels;
	}

	/// A node id for a node the host made itself (a game's own bus given as `output`): it records nothing, and the
	/// replayer maps the id to the host's node.
	pub fn adopt(&mut self) -> NodeId {
		self.new_node()
	}

	/// Hands over the records made since the last call, with the samples of the buffers they made, and forgets them.
	pub fn take(&mut self) -> Taken {
		for (_, pending) in std::mem::take(&mut self.pending) {
			let offset = self.data.len();
			for channel in &pending.channels {
				self.data.extend_from_slice(channel);
			}
			self.ops[pending.record + 5] = offset as f64;
		}
		Taken {
			ops: std::mem::take(&mut self.ops),
			data: std::mem::take(&mut self.data),
		}
	}

	/// How many numbers of records are waiting to be taken.
	pub fn pending_len(&self) -> usize {
		self.ops.len()
	}

	fn push(&mut self, op: Op, a: f64, b: f64, c: f64, d: f64, e: f64) {
		self.ops
			.extend_from_slice(&[f64::from(op as u8), a, b, c, d, e]);
	}

	fn node_op(&mut self, op: Op, node: NodeId, value: f64) {
		self.push(op, node.index() as f64, value, 0.0, 0.0, 0.0);
	}

	fn new_node(&mut self) -> NodeId {
		let id = self.nodes;
		self.nodes += 1;
		if let Some(Some(scope)) = self.open.last_mut() {
			scope.nodes.push(id);
		}
		NodeId::new(id)
	}

	fn new_buffer(&mut self) -> u32 {
		let id = self.buffers;
		self.buffers += 1;
		if let Some(Some(scope)) = self.open.last_mut() {
			scope.buffers.push(id);
		}
		id
	}

	fn side(&mut self, samples: &[f32]) -> f64 {
		let offset = self.data.len();
		self.data.extend_from_slice(samples);
		offset as f64
	}
}

fn optional(buffer: Option<BufferId>) -> f64 {
	buffer.map_or(-1.0, |buffer| buffer.index() as f64)
}

impl Graph for RecordGraph {
	fn sample_rate(&self) -> f64 {
		self.sample_rate
	}

	fn current_time(&self) -> f64 {
		self.time
	}

	fn destination_channels(&self) -> u32 {
		self.channels
	}

	fn destination_max_channels(&self) -> u32 {
		self.max_channels
	}

	fn create_node(&mut self, kind: NodeKind) -> NodeId {
		let node = self.new_node();
		let (code, inputs) = kind_code(kind);
		self.push(Op::Create, node.index() as f64, code, inputs, 0.0, 0.0);
		node
	}

	fn param(&self, node: NodeId, kind: ParamKind) -> ParamId {
		ParamId::new(node, kind)
	}

	fn automate(&mut self, param: ParamId, call: Automation) {
		let node = param.node().index() as f64;
		let code = param_code(param.kind());
		match call {
			Automation::Set { value, time } => self.push(Op::Set, node, code, value, time, 0.0),
			Automation::LinearRamp { value, time } => {
				self.push(Op::Linear, node, code, value, time, 0.0);
			}
			Automation::ExponentialRamp { value, time } => {
				self.push(Op::Exponential, node, code, value, time, 0.0);
			}
			Automation::Target {
				value,
				time,
				time_constant,
			} => self.push(Op::Target, node, code, value, time, time_constant),
			Automation::Cancel { time } => self.push(Op::Cancel, node, code, time, 0.0, 0.0),
		}
	}

	fn set_oscillator_type(&mut self, node: NodeId, kind: OscillatorType) {
		let code = match kind {
			OscillatorType::Sine => 0.0,
			OscillatorType::Square => 1.0,
			OscillatorType::Sawtooth => 2.0,
			OscillatorType::Triangle => 3.0,
		};
		self.node_op(Op::OscillatorType, node, code);
	}

	fn set_periodic_wave(&mut self, node: NodeId, wave: WaveId) {
		self.node_op(Op::PeriodicWave, node, wave.index() as f64);
	}

	fn set_filter_type(&mut self, node: NodeId, kind: FilterType) {
		let code = match kind {
			FilterType::Lowpass => 0.0,
			FilterType::Highpass => 1.0,
			FilterType::Bandpass => 2.0,
			FilterType::Lowshelf => 3.0,
			FilterType::Highshelf => 4.0,
			FilterType::Peaking => 5.0,
			FilterType::Notch => 6.0,
			FilterType::Allpass => 7.0,
		};
		self.node_op(Op::FilterType, node, code);
	}

	fn set_buffer(&mut self, node: NodeId, buffer: Option<BufferId>) {
		self.node_op(Op::Buffer, node, optional(buffer));
	}

	fn set_loop(&mut self, node: NodeId, looping: bool) {
		self.node_op(Op::Loop, node, f64::from(u8::from(looping)));
	}

	fn set_curve(&mut self, node: NodeId, curve: Option<BufferId>) {
		self.node_op(Op::Curve, node, optional(curve));
	}

	fn set_oversample(&mut self, node: NodeId, oversample: Oversample) {
		let code = match oversample {
			Oversample::None => 0.0,
			Oversample::X2 => 1.0,
			Oversample::X4 => 2.0,
		};
		self.node_op(Op::Oversample, node, code);
	}

	fn set_channel_count(&mut self, node: NodeId, count: u32) {
		if node == self.destination() {
			self.channels = count;
		}
		self.node_op(Op::ChannelCount, node, f64::from(count));
	}

	fn set_channel_count_mode(&mut self, node: NodeId, mode: ChannelCountMode) {
		let code = match mode {
			ChannelCountMode::Max => 0.0,
			ChannelCountMode::ClampedMax => 1.0,
			ChannelCountMode::Explicit => 2.0,
		};
		self.node_op(Op::ChannelCountMode, node, code);
	}

	fn set_channel_interpretation(&mut self, node: NodeId, interpretation: ChannelInterpretation) {
		let code = match interpretation {
			ChannelInterpretation::Speakers => 0.0,
			ChannelInterpretation::Discrete => 1.0,
		};
		self.node_op(Op::ChannelInterpretation, node, code);
	}

	fn connect(&mut self, from: NodeId, to: Target, output: u32, input: u32) {
		let (node, param) = match to {
			Target::Node(node) => (node, -1.0),
			Target::Param(param) => (param.node(), param_code(param.kind())),
		};
		self.push(
			Op::Connect,
			from.index() as f64,
			node.index() as f64,
			param,
			f64::from(output),
			f64::from(input),
		);
	}

	fn disconnect(&mut self, node: NodeId) {
		self.node_op(Op::Disconnect, node, 0.0);
	}

	fn start(&mut self, node: NodeId, when: f64) {
		self.node_op(Op::Start, node, when);
	}

	fn stop(&mut self, node: NodeId, when: f64) {
		self.node_op(Op::Stop, node, when);
	}

	fn create_buffer(&mut self, channels: u32, length: usize, sample_rate: f64) -> BufferId {
		let id = self.new_buffer();
		let channels = channels.max(1);
		let record = self.ops.len();
		self.push(
			Op::CreateBuffer,
			f64::from(id),
			f64::from(channels),
			length as f64,
			sample_rate,
			0.0,
		);
		self.pending.insert(
			id,
			Pending {
				record,
				channels: vec![vec![0.0; length]; channels as usize],
			},
		);
		BufferId::new(id)
	}

	fn buffer_channel_mut(&mut self, buffer: BufferId, channel: u32) -> &mut [f32] {
		// The engine fills a buffer straight after making it, before the records are taken; a buffer already handed
		// over (or a channel it does not have) has nothing left to write.
		match self
			.pending
			.get_mut(&(buffer.index() as u32))
			.and_then(|pending| pending.channels.get_mut(channel as usize))
		{
			Some(samples) => samples,
			None => &mut [],
		}
	}

	fn create_curve(&mut self, samples: &[f32]) -> BufferId {
		let id = self.new_buffer();
		let offset = self.side(samples);
		self.push(
			Op::CreateCurve,
			f64::from(id),
			samples.len() as f64,
			offset,
			0.0,
			0.0,
		);
		BufferId::new(id)
	}

	fn create_periodic_wave(
		&mut self,
		real: &[f32],
		imag: &[f32],
		disable_normalization: bool,
	) -> WaveId {
		let id = self.waves;
		self.waves += 1;
		let offset = self.side(real);
		self.side(imag);
		self.push(
			Op::CreateWave,
			f64::from(id),
			real.len() as f64,
			offset,
			f64::from(u8::from(disable_normalization)),
			0.0,
		);
		WaveId::new(id)
	}

	fn begin_scope(&mut self) {
		self.open.push(Some(OpenScope::default()));
	}

	fn end_scope(&mut self) -> Scope {
		match self.open.pop() {
			Some(Some(scope)) => {
				let number = self.next_scope;
				self.next_scope = self.next_scope.wrapping_add(1).max(1);
				self.closed.insert(number, scope);
				Scope::new(number)
			}
			_ => Scope::NONE,
		}
	}

	fn begin_shared(&mut self) {
		self.open.push(None);
	}

	fn end_shared(&mut self) {
		self.open.pop();
	}

	fn retire_scope(&mut self, scope: Scope) {
		if let Some(scope) = self.closed.remove(&scope.index()) {
			for node in scope.nodes {
				self.push(Op::Release, f64::from(node), 0.0, 0.0, 0.0, 0.0);
			}
			for buffer in scope.buffers {
				self.push(Op::ReleaseBuffer, f64::from(buffer), 0.0, 0.0, 0.0, 0.0);
			}
		}
	}

	fn retire_buffer(&mut self, buffer: BufferId) {
		self.push(Op::ReleaseBuffer, buffer.index() as f64, 0.0, 0.0, 0.0, 0.0);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn records_are_fixed_width_and_buffers_are_copied_when_taken() {
		let mut graph = RecordGraph::new(48_000.0, 2, 2);
		let osc = graph.create_node(NodeKind::Oscillator);
		let gain = graph.create_node(NodeKind::ChannelMerger { inputs: 3 });
		let level = graph.param(osc, ParamKind::Frequency);
		graph.set_target_at_time(level, 1.0, 2.0, 3.0);
		let buffer = graph.create_buffer(2, 2, 8_000.0);
		graph
			.buffer_channel_mut(buffer, 1)
			.copy_from_slice(&[0.5, -0.5]);
		graph.connect(
			osc,
			Target::Param(ParamId::new(gain, ParamKind::Gain)),
			0,
			1,
		);
		let taken = graph.take();
		assert_eq!(taken.ops.len(), 5 * WIDTH);
		assert_eq!(&taken.ops[0..4], &[0.0, 1.0, 0.0, 0.0]);
		assert_eq!(&taken.ops[6..10], &[0.0, 2.0, 4.0, 3.0]);
		assert_eq!(&taken.ops[12..18], &[4.0, 1.0, 0.0, 1.0, 2.0, 3.0]);
		assert_eq!(&taken.ops[18..24], &[20.0, 0.0, 2.0, 2.0, 8_000.0, 0.0]);
		assert_eq!(&taken.ops[24..30], &[16.0, 1.0, 2.0, 1.0, 0.0, 1.0]);
		assert_eq!(taken.data, [0.0, 0.0, 0.5, -0.5]);
		assert_eq!(graph.take(), Taken::default());
		assert!(graph.buffer_channel_mut(buffer, 0).is_empty());
	}

	#[test]
	fn a_retired_scope_releases_its_nodes_and_shared_work_belongs_to_none() {
		let mut graph = RecordGraph::new(48_000.0, 2, 2);
		graph.begin_scope();
		let voice = graph.create_node(NodeKind::Gain);
		graph.begin_shared();
		let bus = graph.create_node(NodeKind::Delay);
		graph.end_shared();
		let noise = graph.create_buffer(1, 1, 8_000.0);
		let scope = graph.end_scope();
		graph.take();
		graph.retire_scope(scope);
		graph.retire_scope(scope);
		let taken = graph.take();
		assert_eq!(
			taken.ops,
			[
				23.0,
				voice.index() as f64,
				0.0,
				0.0,
				0.0,
				0.0,
				24.0,
				noise.index() as f64,
				0.0,
				0.0,
				0.0,
				0.0
			]
		);
		assert_ne!(voice, bus);
	}

	#[test]
	fn the_names_cover_every_code() {
		assert_eq!(NAMES.ops.len(), Op::ReleaseBuffer as usize + 1);
		assert_eq!(NAMES.kinds.len(), 10);
		assert_eq!(NAMES.params.len(), 11);
		assert_eq!(ParamKind::PlaybackRate.name(), NAMES.params[10]);
		for (code, kind) in [OscillatorType::Sine, OscillatorType::Triangle]
			.iter()
			.enumerate()
		{
			assert_eq!(NAMES.oscillator_types[code * 3], kind.name());
		}
	}
}
