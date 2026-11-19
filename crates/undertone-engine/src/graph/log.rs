// LogGraph: a Graph that records every call and writes it in the layer 3 corpus format
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`LogGraph`] and the serde-free [`GraphRecord`] it produces.
//!
//! The record follows the TypeScript recorder (`conformance/recorder/graph.ts`, `describeGraph`) exactly:
//! nodes numbered in creation order with `n0` the destination, fields that differ from a fresh node's, the
//! automation of each parameter as call strings, buffers and periodic waves numbered in the order the nodes
//! first mention them. [`GraphRecord::to_json`] writes the `graph` object of a corpus case byte for byte.

use super::number::{exact_json, nine_digits_json, nine_digits_text};
use super::{
	Automation, BufferId, ChannelCountMode, ChannelInterpretation, FilterType, Graph, NodeId,
	NodeKind, OscillatorType, Oversample, ParamId, ParamKind, Target, WaveId,
};
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

/// The square root, exact in IEEE arithmetic on every back-end.
fn sqrt(value: f64) -> f64 {
	#[cfg(feature = "libm")]
	{
		libm::sqrt(value)
	}
	#[cfg(not(feature = "libm"))]
	{
		value.sqrt()
	}
}

/// A field value of a node as it is stored while recording.
#[derive(Debug, Clone, PartialEq)]
enum Field {
	/// `undefined` or `null`: never written.
	Unset,
	Text(&'static str),
	Number(f64),
	Bool(bool),
	Buffer(BufferId),
	Wave(WaveId),
}

/// A field a node has, with the value a fresh node of its class has (a field equal to it is not written).
#[derive(Debug, Clone)]
struct Slot {
	key: &'static str,
	value: Field,
	default: Field,
}

impl Slot {
	fn new(key: &'static str, default: Field) -> Self {
		Self {
			key,
			value: default.clone(),
			default,
		}
	}
}

#[derive(Debug, Clone)]
struct Connection {
	target: Target,
	output: u32,
	input: u32,
}

#[derive(Debug, Clone)]
struct LogNode {
	/// `None` for the destination.
	kind: Option<NodeKind>,
	fields: Vec<Slot>,
	params: Vec<(ParamKind, Vec<String>)>,
	started: Vec<f64>,
	stopped: Vec<f64>,
	/// The convolver's buffers with the context time each was given at.
	history: Vec<(f64, Option<BufferId>)>,
	disconnects: u32,
	connections: Vec<Connection>,
}

fn kind_name(kind: Option<NodeKind>) -> &'static str {
	match kind {
		None => "destination",
		Some(NodeKind::Oscillator) => "oscillator",
		Some(NodeKind::Gain) => "gain",
		Some(NodeKind::BiquadFilter) => "filter",
		Some(NodeKind::StereoPanner) => "panner",
		Some(NodeKind::ChannelMerger { .. }) => "merger",
		Some(NodeKind::BufferSource) => "bufferSource",
		Some(NodeKind::Convolver) => "convolver",
		Some(NodeKind::Delay) => "delay",
		Some(NodeKind::DynamicsCompressor) => "compressor",
		Some(NodeKind::WaveShaper) => "waveShaper",
	}
}

impl LogNode {
	fn new(kind: Option<NodeKind>, channels: u32) -> Self {
		let fields = match kind {
			None => vec![
				// A fresh destination has two channels, whatever this one was made with.
				Slot {
					key: "channelCount",
					value: Field::Number(f64::from(channels)),
					default: Field::Number(2.0),
				},
				Slot::new("channelInterpretation", Field::Text("speakers")),
			],
			Some(NodeKind::Oscillator) => vec![
				Slot::new("type", Field::Text("sine")),
				Slot::new("wave", Field::Unset),
			],
			Some(NodeKind::BiquadFilter) => vec![Slot::new("type", Field::Text("lowpass"))],
			Some(NodeKind::BufferSource) => vec![
				Slot::new("buffer", Field::Unset),
				Slot::new("loop", Field::Bool(false)),
			],
			Some(NodeKind::WaveShaper) => vec![
				Slot::new("curve", Field::Unset),
				Slot::new("oversample", Field::Text("none")),
			],
			Some(_) => Vec::new(),
		};
		let names: &[ParamKind] = match kind {
			Some(NodeKind::Oscillator) => &[ParamKind::Frequency],
			Some(NodeKind::Gain) => &[ParamKind::Gain],
			Some(NodeKind::BiquadFilter) => &[ParamKind::Frequency, ParamKind::Q],
			Some(NodeKind::StereoPanner) => &[ParamKind::Pan],
			Some(NodeKind::BufferSource) => &[ParamKind::PlaybackRate],
			Some(NodeKind::Delay) => &[ParamKind::DelayTime],
			Some(NodeKind::DynamicsCompressor) => &[
				ParamKind::Threshold,
				ParamKind::Knee,
				ParamKind::Ratio,
				ParamKind::Attack,
				ParamKind::Release,
			],
			_ => &[],
		};
		Self {
			kind,
			fields,
			params: names.iter().map(|name| (*name, Vec::new())).collect(),
			started: Vec::new(),
			stopped: Vec::new(),
			history: Vec::new(),
			disconnects: 0,
			connections: Vec::new(),
		}
	}

	/// Sets a field in place, or adds it after the fields the class declares (as an assignment to a new
	/// JavaScript property does).
	fn set(&mut self, key: &'static str, value: Field) {
		match self.fields.iter_mut().find(|slot| slot.key == key) {
			Some(slot) => slot.value = value,
			None => self.fields.push(Slot {
				key,
				value,
				default: Field::Unset,
			}),
		}
	}

	fn expect(&self, what: &str, ok: bool) {
		assert!(ok, "{what} is not valid on a {} node", kind_name(self.kind));
	}
}

#[derive(Debug, Clone)]
enum StoredBuffer {
	Audio {
		sample_rate: f64,
		channels: Vec<Vec<f32>>,
	},
	Curve(Vec<f32>),
}

#[derive(Debug, Clone)]
struct StoredWave {
	real: Vec<f32>,
	imag: Vec<f32>,
	disable_normalization: bool,
}

/// A [`Graph`] that does no audio: it records what the engine did, for comparison with the corpus.
///
/// ```
/// use undertone_engine::graph::{Graph, LogGraph, NodeKind, ParamKind};
///
/// let mut graph = LogGraph::new(44_100.0, 2);
/// let panner = graph.create_node(NodeKind::StereoPanner);
/// let pan = graph.param(panner, ParamKind::Pan);
/// graph.set_value_at_time(pan, 0.5, 0.0);
/// graph.connect_node(panner, graph.destination());
///
/// let record = graph.finish(None);
/// assert_eq!(record.nodes[1].kind, "panner");
/// assert_eq!(record.nodes[1].params[0].1, ["set 0.5 @0"]);
/// assert_eq!(record.nodes[1].to, ["n0"]);
/// ```
#[derive(Debug, Clone)]
pub struct LogGraph {
	sample_rate: f64,
	max_channels: u32,
	time: f64,
	nodes: Vec<LogNode>,
	buffers: Vec<StoredBuffer>,
	waves: Vec<StoredWave>,
}

impl LogGraph {
	/// A graph whose destination has `channels` channels (and can have no more), at `sample_rate` hertz.
	pub fn new(sample_rate: f64, channels: u32) -> Self {
		Self::with_max_channels(sample_rate, channels, channels)
	}

	/// A graph whose destination currently has `channels` channels and can have up to `max_channels`.
	pub fn with_max_channels(sample_rate: f64, channels: u32, max_channels: u32) -> Self {
		Self {
			sample_rate,
			max_channels,
			time: 0.0,
			nodes: vec![LogNode::new(None, channels)],
			buffers: Vec::new(),
			waves: Vec::new(),
		}
	}

	/// Sets the context's clock, which [`Graph::current_time`] reports and a convolver notes when its buffer is set.
	pub fn set_current_time(&mut self, seconds: f64) {
		self.time = seconds;
	}

	fn node(&mut self, id: NodeId) -> &mut LogNode {
		&mut self.nodes[id.index()]
	}

	/// Describes what has been recorded: the layer 3 `graph` object. `length` is the frame count of an
	/// offline render, or `None` for a realtime context.
	pub fn finish(&self, length: Option<u64>) -> GraphRecord {
		let mut describer = Describer {
			graph: self,
			buffer_ids: vec![None; self.buffers.len()],
			buffers: Vec::new(),
			wave_ids: vec![None; self.waves.len()],
			waves: Vec::new(),
		};
		let mut counts: Vec<(String, u32)> = Vec::new();
		let nodes: Vec<NodeRecord> = (0..self.nodes.len())
			.map(|index| {
				let name = kind_name(self.nodes[index].kind);
				match counts.iter_mut().find(|(kind, _)| kind == name) {
					Some((_, count)) => *count += 1,
					None => counts.push((name.to_string(), 1)),
				}
				describer.node(index)
			})
			.collect();
		counts.push(("total".to_string(), self.nodes.len() as u32));
		// Waves made but never given to an oscillator are still part of what the engine did.
		for index in 0..self.waves.len() {
			describer.wave(WaveId(index as u32));
		}
		GraphRecord {
			sample_rate: self.sample_rate,
			length,
			channels: self.destination_channels(),
			counts,
			nodes,
			buffers: describer.buffers,
			waves: describer.waves,
		}
	}
}

struct Describer<'a> {
	graph: &'a LogGraph,
	buffer_ids: Vec<Option<usize>>,
	buffers: Vec<BufferRecord>,
	wave_ids: Vec<Option<usize>>,
	waves: Vec<WaveRecord>,
}

impl Describer<'_> {
	fn buffer(&mut self, id: BufferId) -> String {
		let slot = id.0 as usize;
		let number = match self.buffer_ids[slot] {
			Some(number) => number,
			None => {
				let number = self.buffers.len();
				self.buffer_ids[slot] = Some(number);
				let record = match &self.graph.buffers[slot] {
					StoredBuffer::Curve(samples) => BufferRecord {
						id: format!("b{number}"),
						kind: BufferKind::Curve,
						length: samples.len(),
						sample_rate: None,
						channels: vec![summarise(samples)],
					},
					StoredBuffer::Audio {
						sample_rate,
						channels,
					} => BufferRecord {
						id: format!("b{number}"),
						kind: BufferKind::Audio,
						length: channels.first().map_or(0, Vec::len),
						sample_rate: Some(*sample_rate),
						channels: channels.iter().map(|data| summarise(data)).collect(),
					},
				};
				self.buffers.push(record);
				number
			}
		};
		format!("b{number}")
	}

	fn wave(&mut self, id: WaveId) -> String {
		let slot = id.0 as usize;
		let number = match self.wave_ids[slot] {
			Some(number) => number,
			None => {
				let number = self.waves.len();
				self.wave_ids[slot] = Some(number);
				let wave = &self.graph.waves[slot];
				self.waves.push(WaveRecord {
					id: format!("w{number}"),
					real: wave.real.iter().map(|v| f64::from(*v)).collect(),
					imag: wave.imag.iter().map(|v| f64::from(*v)).collect(),
					disable_normalization: wave.disable_normalization,
				});
				number
			}
		};
		format!("w{number}")
	}

	fn target_name(&self, target: Target) -> String {
		match target {
			Target::Node(node) => format!("n{}", node.index()),
			Target::Param(param) => format!("n{}.{}", param.node().index(), param.kind().name()),
		}
	}

	fn node(&mut self, index: usize) -> NodeRecord {
		let graph = self.graph;
		let node = &graph.nodes[index];
		let mut fields = Vec::new();
		for slot in &node.fields {
			let value = match &slot.value {
				Field::Unset => continue,
				// A buffer or a wave is always written, by its number.
				Field::Buffer(id) => RecordValue::Text(self.buffer(*id)),
				Field::Wave(id) => RecordValue::Text(self.wave(*id)),
				value if *value == slot.default => continue,
				Field::Text(text) => RecordValue::Text((*text).to_string()),
				Field::Number(number) => RecordValue::Number(*number),
				Field::Bool(flag) => RecordValue::Bool(*flag),
			};
			fields.push((slot.key.to_string(), value));
		}
		let params = node
			.params
			.iter()
			.filter(|(_, calls)| !calls.is_empty())
			.map(|(kind, calls)| (kind.name().to_string(), calls.clone()))
			.collect();
		// What is heard from each time on: the last buffer given at that time, the first time named "first".
		let mut heard: Vec<(Heard, Option<String>)> = Vec::new();
		if let Some((first, _)) = node.history.first() {
			for (time, buffer) in &node.history {
				let key = if time == first {
					Heard::First
				} else {
					Heard::At(*time)
				};
				let id = buffer.map(|buffer| self.buffer(buffer));
				match heard.iter_mut().find(|(known, _)| *known == key) {
					Some((_, slot)) => *slot = id,
					None => heard.push((key, id)),
				}
			}
		}
		let to = node
			.connections
			.iter()
			.map(|connection| {
				let name = self.target_name(connection.target);
				if connection.output == 0 && connection.input == 0 {
					name
				} else {
					format!("{name} out {} in {}", connection.output, connection.input)
				}
			})
			.collect();
		NodeRecord {
			id: format!("n{index}"),
			kind: kind_name(node.kind),
			fields,
			params,
			start: node.started.clone(),
			stop: node.stopped.clone(),
			heard,
			disconnects: node.disconnects,
			to,
		}
	}
}

/// The root mean square, peak, and first four samples of one channel.
fn summarise(samples: &[f32]) -> ChannelSummary {
	let mut sum = 0.0_f64;
	let mut peak = 0.0_f64;
	for sample in samples {
		let v = f64::from(*sample);
		sum += v * v;
		peak = peak.max(v.abs());
	}
	ChannelSummary {
		rms: if samples.is_empty() {
			0.0
		} else {
			sqrt(sum / samples.len() as f64)
		},
		peak,
		head: samples.iter().take(4).map(|v| f64::from(*v)).collect(),
	}
}

impl Graph for LogGraph {
	fn sample_rate(&self) -> f64 {
		self.sample_rate
	}

	fn current_time(&self) -> f64 {
		self.time
	}

	fn destination_channels(&self) -> u32 {
		match self.nodes[0].fields[0].value {
			Field::Number(count) => count as u32,
			_ => 2,
		}
	}

	fn destination_max_channels(&self) -> u32 {
		self.max_channels
	}

	fn create_node(&mut self, kind: NodeKind) -> NodeId {
		self.nodes.push(LogNode::new(Some(kind), 0));
		NodeId(self.nodes.len() as u32 - 1)
	}

	fn param(&self, node: NodeId, kind: ParamKind) -> ParamId {
		let record = &self.nodes[node.index()];
		assert!(
			record.params.iter().any(|(name, _)| *name == kind),
			"a {} node has no {} parameter",
			kind_name(record.kind),
			kind.name()
		);
		ParamId { node, kind }
	}

	fn automate(&mut self, param: ParamId, call: Automation) {
		let text = match call {
			Automation::Set { value, time } => {
				format!(
					"set {} @{}",
					nine_digits_text(value),
					nine_digits_text(time)
				)
			}
			Automation::LinearRamp { value, time } => {
				format!(
					"lin {} @{}",
					nine_digits_text(value),
					nine_digits_text(time)
				)
			}
			Automation::ExponentialRamp { value, time } => {
				format!(
					"exp {} @{}",
					nine_digits_text(value),
					nine_digits_text(time)
				)
			}
			Automation::Target {
				value,
				time,
				time_constant,
			} => format!(
				"target {} @{} tau {}",
				nine_digits_text(value),
				nine_digits_text(time),
				nine_digits_text(time_constant)
			),
			Automation::Cancel { time } => format!("cancel @{}", nine_digits_text(time)),
		};
		let node = self.node(param.node());
		let calls = &mut node
			.params
			.iter_mut()
			.find(|(kind, _)| *kind == param.kind())
			.expect("a ParamId names a parameter its node has")
			.1;
		calls.push(text);
	}

	fn set_oscillator_type(&mut self, node: NodeId, kind: OscillatorType) {
		let node = self.node(node);
		node.expect(
			"an oscillator type",
			node.kind == Some(NodeKind::Oscillator),
		);
		node.set("type", Field::Text(kind.name()));
	}

	fn set_periodic_wave(&mut self, node: NodeId, wave: WaveId) {
		let node = self.node(node);
		node.expect("a periodic wave", node.kind == Some(NodeKind::Oscillator));
		node.set("wave", Field::Wave(wave));
		node.set("type", Field::Text("custom"));
	}

	fn set_filter_type(&mut self, node: NodeId, kind: FilterType) {
		let node = self.node(node);
		node.expect("a filter type", node.kind == Some(NodeKind::BiquadFilter));
		node.set("type", Field::Text(kind.name()));
	}

	fn set_buffer(&mut self, node: NodeId, buffer: Option<BufferId>) {
		let time = self.time;
		let node = self.node(node);
		match node.kind {
			Some(NodeKind::BufferSource) => {
				node.set("buffer", buffer.map_or(Field::Unset, Field::Buffer));
			}
			Some(NodeKind::Convolver) => node.history.push((time, buffer)),
			_ => node.expect("a buffer", false),
		}
	}

	fn set_loop(&mut self, node: NodeId, looping: bool) {
		let node = self.node(node);
		node.expect("loop", node.kind == Some(NodeKind::BufferSource));
		node.set("loop", Field::Bool(looping));
	}

	fn set_curve(&mut self, node: NodeId, curve: Option<BufferId>) {
		let node = self.node(node);
		node.expect("a curve", node.kind == Some(NodeKind::WaveShaper));
		node.set("curve", curve.map_or(Field::Unset, Field::Buffer));
	}

	fn set_oversample(&mut self, node: NodeId, oversample: Oversample) {
		let node = self.node(node);
		node.expect("oversample", node.kind == Some(NodeKind::WaveShaper));
		node.set("oversample", Field::Text(oversample.name()));
	}

	fn set_channel_count(&mut self, node: NodeId, count: u32) {
		self.node(node)
			.set("channelCount", Field::Number(f64::from(count)));
	}

	fn set_channel_count_mode(&mut self, node: NodeId, mode: ChannelCountMode) {
		self.node(node)
			.set("channelCountMode", Field::Text(mode.name()));
	}

	fn set_channel_interpretation(&mut self, node: NodeId, interpretation: ChannelInterpretation) {
		self.node(node)
			.set("channelInterpretation", Field::Text(interpretation.name()));
	}

	fn connect(&mut self, from: NodeId, to: Target, output: u32, input: u32) {
		self.node(from).connections.push(Connection {
			target: to,
			output,
			input,
		});
	}

	fn disconnect(&mut self, node: NodeId) {
		self.node(node).disconnects += 1;
	}

	fn start(&mut self, node: NodeId, when: f64) {
		let node = self.node(node);
		node.expect(
			"start",
			matches!(
				node.kind,
				Some(NodeKind::Oscillator | NodeKind::BufferSource)
			),
		);
		node.started.push(when);
	}

	fn stop(&mut self, node: NodeId, when: f64) {
		let node = self.node(node);
		node.expect(
			"stop",
			matches!(
				node.kind,
				Some(NodeKind::Oscillator | NodeKind::BufferSource)
			),
		);
		node.stopped.push(when);
	}

	fn create_buffer(&mut self, channels: u32, length: usize, sample_rate: f64) -> BufferId {
		self.buffers.push(StoredBuffer::Audio {
			sample_rate,
			channels: vec![vec![0.0; length]; channels.max(1) as usize],
		});
		BufferId(self.buffers.len() as u32 - 1)
	}

	fn buffer_channel_mut(&mut self, buffer: BufferId, channel: u32) -> &mut [f32] {
		match &mut self.buffers[buffer.0 as usize] {
			StoredBuffer::Audio { channels, .. } => &mut channels[channel as usize],
			StoredBuffer::Curve(_) => panic!("a curve has no channels to write"),
		}
	}

	fn create_curve(&mut self, samples: &[f32]) -> BufferId {
		self.buffers.push(StoredBuffer::Curve(samples.to_vec()));
		BufferId(self.buffers.len() as u32 - 1)
	}

	fn create_periodic_wave(
		&mut self,
		real: &[f32],
		imag: &[f32],
		disable_normalization: bool,
	) -> WaveId {
		self.waves.push(StoredWave {
			real: real.to_vec(),
			imag: imag.to_vec(),
			disable_normalization,
		});
		WaveId(self.waves.len() as u32 - 1)
	}
}

/// What a convolver's buffer history is keyed by: the first buffer is heard from when the convolver was made.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Heard {
	/// From the start: the time the first buffer was given at, and anything given at the same time.
	First,
	/// From this time in seconds.
	At(f64),
}

/// A node field's value in a record.
#[derive(Debug, Clone, PartialEq)]
pub enum RecordValue {
	/// A string: an enum's name, or the number of a buffer (`b0`) or a wave (`w0`).
	Text(String),
	/// A number, written as it is.
	Number(f64),
	/// A boolean.
	Bool(bool),
}

/// One node of a recorded graph: its fields in the order the corpus writes them. A field that is empty is
/// left out of the JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeRecord {
	/// `n0`, `n1`, ... in creation order.
	pub id: String,
	/// `destination`, `oscillator`, `gain`, `filter`, `panner`, `merger`, `bufferSource`, `convolver`,
	/// `delay`, `compressor`, or `waveShaper`.
	pub kind: &'static str,
	/// The fields that differ from a fresh node's.
	pub fields: Vec<(String, RecordValue)>,
	/// The automation of each parameter that has any, as call strings (`set 220 @0`).
	pub params: Vec<(String, Vec<String>)>,
	/// Start times (nine significant digits when written).
	pub start: Vec<f64>,
	/// Stop times (nine significant digits when written).
	pub stop: Vec<f64>,
	/// A convolver's buffers by the time they are heard from; the buffer is `None` for `null`.
	pub heard: Vec<(Heard, Option<String>)>,
	/// How many times the node was disconnected.
	pub disconnects: u32,
	/// Where the node's output goes: `n3`, `n3.gain`, or `n3 out 0 in 1`.
	pub to: Vec<String>,
}

/// Whether a recorded buffer is audio or a wave-shaper curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferKind {
	/// A buffer made by `createBuffer`.
	Audio,
	/// A `Float32Array` used as a curve.
	Curve,
}

/// The summary of one channel of a buffer (written at nine significant digits).
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelSummary {
	/// Root mean square.
	pub rms: f64,
	/// Largest absolute sample.
	pub peak: f64,
	/// The first four samples.
	pub head: Vec<f64>,
}

/// One buffer a node uses, numbered in the order the nodes first mention it.
#[derive(Debug, Clone, PartialEq)]
pub struct BufferRecord {
	/// `b0`, `b1`, ...
	pub id: String,
	/// Audio or curve.
	pub kind: BufferKind,
	/// Frames.
	pub length: usize,
	/// The sample rate of an audio buffer.
	pub sample_rate: Option<f64>,
	/// One summary per channel (a curve has one).
	pub channels: Vec<ChannelSummary>,
}

/// One periodic wave.
#[derive(Debug, Clone, PartialEq)]
pub struct WaveRecord {
	/// `w0`, `w1`, ...
	pub id: String,
	/// The cosine coefficients.
	pub real: Vec<f64>,
	/// The sine coefficients.
	pub imag: Vec<f64>,
	/// Whether normalisation was disabled.
	pub disable_normalization: bool,
}

/// A recorded graph: the `graph` object of a layer 3 corpus case, without serde. Numbers are held as the
/// graph had them and rounded to nine significant digits when written.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphRecord {
	/// The context's sample rate.
	pub sample_rate: f64,
	/// Frames of an offline render, or `None`.
	pub length: Option<u64>,
	/// The destination's channel count.
	pub channels: u32,
	/// Nodes per kind in creation order of the first of each, then `total`.
	pub counts: Vec<(String, u32)>,
	/// Every node, the destination first.
	pub nodes: Vec<NodeRecord>,
	/// The buffers the nodes used.
	pub buffers: Vec<BufferRecord>,
	/// The periodic waves.
	pub waves: Vec<WaveRecord>,
}

fn json_string(text: &str) -> String {
	let mut out = String::from("\"");
	for c in text.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

fn json_list<T>(items: &[T], each: impl Fn(&T) -> String) -> String {
	let parts: Vec<String> = items.iter().map(each).collect();
	format!("[{}]", parts.join(","))
}

fn node_json(node: &NodeRecord) -> String {
	let mut out = format!(
		"{{\"id\":{},\"kind\":{}",
		json_string(&node.id),
		json_string(node.kind)
	);
	if !node.fields.is_empty() {
		let fields: Vec<String> = node
			.fields
			.iter()
			.map(|(key, value)| {
				let value = match value {
					RecordValue::Text(text) => json_string(text),
					RecordValue::Number(number) => exact_json(*number),
					RecordValue::Bool(flag) => flag.to_string(),
				};
				format!("{}:{value}", json_string(key))
			})
			.collect();
		out.push_str(&format!(",\"fields\":{{{}}}", fields.join(",")));
	}
	if !node.params.is_empty() {
		let params: Vec<String> = node
			.params
			.iter()
			.map(|(key, calls)| {
				format!(
					"{}:{}",
					json_string(key),
					json_list(calls, |c| json_string(c))
				)
			})
			.collect();
		out.push_str(&format!(",\"params\":{{{}}}", params.join(",")));
	}
	if !node.start.is_empty() {
		out.push_str(&format!(
			",\"start\":{}",
			json_list(&node.start, |t| nine_digits_json(*t))
		));
	}
	if !node.stop.is_empty() {
		out.push_str(&format!(
			",\"stop\":{}",
			json_list(&node.stop, |t| nine_digits_json(*t))
		));
	}
	if !node.heard.is_empty() {
		let heard = json_list(&node.heard, |(time, id)| {
			let time = match time {
				Heard::First => json_string("first"),
				Heard::At(time) => nine_digits_json(*time),
			};
			let id = id
				.as_deref()
				.map_or_else(|| "null".to_string(), json_string);
			format!("[{time},{id}]")
		});
		out.push_str(&format!(",\"heard\":{heard}"));
	}
	if node.disconnects > 0 {
		out.push_str(&format!(",\"disconnects\":{}", node.disconnects));
	}
	if !node.to.is_empty() {
		out.push_str(&format!(
			",\"to\":{}",
			json_list(&node.to, |t| json_string(t))
		));
	}
	out.push('}');
	out
}

fn summary_json(summary: &ChannelSummary) -> String {
	format!(
		"{{\"rms\":{},\"peak\":{},\"head\":{}}}",
		nine_digits_json(summary.rms),
		nine_digits_json(summary.peak),
		json_list(&summary.head, |v| nine_digits_json(*v))
	)
}

fn buffer_json(buffer: &BufferRecord) -> String {
	let kind = match buffer.kind {
		BufferKind::Audio => "audio",
		BufferKind::Curve => "curve",
	};
	let rate = buffer.sample_rate.map_or_else(String::new, |rate| {
		format!(",\"sampleRate\":{}", exact_json(rate))
	});
	format!(
		"{{\"id\":{},\"kind\":\"{kind}\",\"length\":{}{rate},\"channels\":{}}}",
		json_string(&buffer.id),
		buffer.length,
		json_list(&buffer.channels, summary_json)
	)
}

fn wave_json(wave: &WaveRecord) -> String {
	format!(
		"{{\"id\":{},\"real\":{},\"imag\":{},\"disableNormalization\":{}}}",
		json_string(&wave.id),
		json_list(&wave.real, |v| nine_digits_json(*v)),
		json_list(&wave.imag, |v| nine_digits_json(*v)),
		wave.disable_normalization
	)
}

/// A list with one element per line, as the corpus writes `nodes`, `buffers`, and `waves`.
fn lines(items: &[String], indent: &str) -> String {
	if items.is_empty() {
		return "[]".to_string();
	}
	let inner = format!("{indent}  ");
	let body: Vec<String> = items.iter().map(|item| format!("{inner}{item}")).collect();
	format!("[\n{}\n{indent}]", body.join(",\n"))
}

impl GraphRecord {
	/// The `graph` object as the corpus file writes it, byte for byte.
	///
	/// `indent` is the indentation of the line the object's key is on: its opening brace follows the key
	/// there, its fields are two spaces further in, and its closing brace is at `indent`. In a corpus file
	/// the `graph` key of a case is indented six spaces. Pass `""` for a stand-alone object.
	pub fn to_json(&self, indent: &str) -> String {
		let inner = format!("{indent}  ");
		let counts: Vec<String> = self
			.counts
			.iter()
			.map(|(kind, count)| format!("{}:{count}", json_string(kind)))
			.collect();
		let nodes: Vec<String> = self.nodes.iter().map(node_json).collect();
		let buffers: Vec<String> = self.buffers.iter().map(buffer_json).collect();
		let waves: Vec<String> = self.waves.iter().map(wave_json).collect();
		let length = self
			.length
			.map_or_else(|| "null".to_string(), |frames| frames.to_string());
		let entries = [
			format!("\"sampleRate\": {}", exact_json(self.sample_rate)),
			format!("\"length\": {length}"),
			format!("\"channels\": {}", self.channels),
			format!("\"counts\": {{{}}}", counts.join(",")),
			format!("\"nodes\": {}", lines(&nodes, &inner)),
			format!("\"buffers\": {}", lines(&buffers, &inner)),
			format!("\"waves\": {}", lines(&waves, &inner)),
		];
		let body: Vec<String> = entries
			.iter()
			.map(|entry| format!("{inner}{entry}"))
			.collect();
		format!("{{\n{}\n{indent}}}", body.join(",\n"))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn buffers_are_numbered_as_nodes_first_mention_them() {
		let mut graph = LogGraph::new(48_000.0, 2);
		let unused = graph.create_buffer(1, 4, 48_000.0);
		let ir = graph.create_buffer(2, 3, 48_000.0);
		graph
			.buffer_channel_mut(ir, 0)
			.copy_from_slice(&[0.5, -0.5, 0.0]);
		let curve = graph.create_curve(&[-1.0, 0.0, 1.0]);
		let shaper = graph.create_node(NodeKind::WaveShaper);
		graph.set_curve(shaper, Some(curve));
		graph.set_oversample(shaper, Oversample::X2);
		let convolver = graph.create_node(NodeKind::Convolver);
		graph.set_buffer(convolver, Some(ir));
		graph.set_current_time(2.0);
		graph.set_buffer(convolver, None);
		let _ = unused;

		let record = graph.finish(Some(96_000));
		assert_eq!(
			record.buffers.len(),
			2,
			"a buffer no node mentions is not written"
		);
		assert_eq!(record.buffers[0].id, "b0");
		assert_eq!(record.buffers[0].kind, BufferKind::Curve);
		assert_eq!(record.buffers[1].kind, BufferKind::Audio);
		assert_eq!(record.buffers[1].channels[0].peak, 0.5);
		assert_eq!(record.buffers[1].channels[1].rms, 0.0);
		assert_eq!(
			record.nodes[1].fields,
			[
				("curve".to_string(), RecordValue::Text("b0".to_string())),
				(
					"oversample".to_string(),
					RecordValue::Text("2x".to_string())
				),
			]
		);
		assert_eq!(
			record.nodes[2].heard,
			[
				(Heard::First, Some("b1".to_string())),
				(Heard::At(2.0), None)
			]
		);
		let json = record.to_json("");
		assert!(
			json.contains(r#""heard":[["first","b1"],[2,null]]"#),
			"{json}"
		);
		assert!(json.contains(r#""length": 96000"#), "{json}");
	}

	#[test]
	#[should_panic(expected = "has no gain parameter")]
	fn a_parameter_a_node_lacks_is_a_mistake() {
		let mut graph = LogGraph::new(44_100.0, 2);
		let panner = graph.create_node(NodeKind::StereoPanner);
		graph.param(panner, ParamKind::Gain);
	}
}
