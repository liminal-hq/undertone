// RenderGraph: a Graph that renders the booked nodes to samples, in any block size
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`RenderGraph`], the in-house renderer: a [`Graph`] that makes samples from what the engine books.
//!
//! The engine books voices on a [`Graph`] (see [`crate::graph`]). [`LogGraph`](crate::graph::LogGraph) writes
//! the booking down; `RenderGraph` plays it, the way an `OfflineAudioContext` does: it keeps the nodes, their
//! connections, and their parameter automation, and turns them into planar `f32` blocks of the destination's
//! channels. Output is deterministic: the same booking gives the same samples on every machine and with every
//! block size, because the graph is always run in fixed quanta of [`RENDER_QUANTUM`] frames (Web Audio's
//! render quantum) and a block of any other size is cut from them.
//!
//! ```
//! use undertone_engine::graph::{Graph, NodeKind, ParamKind};
//! use undertone_engine::render_graph::RenderGraph;
//!
//! // One second of a 440 Hz sine at half level, in stereo, through a gain node.
//! let mut graph = RenderGraph::new(48_000.0, 2, 48_000);
//! let osc = graph.create_node(NodeKind::Oscillator);
//! let gain = graph.create_node(NodeKind::Gain);
//! let level = graph.param(gain, ParamKind::Gain);
//! graph.set_value_at_time(level, 0.5, 0.0);
//! graph.connect_node(osc, gain);
//! graph.connect_node(gain, graph.destination());
//! graph.start(osc, 0.0);
//!
//! let channels = graph.render_all();
//! assert_eq!(channels.len(), 2);
//! assert_eq!(channels[0].len(), 48_000);
//! let peak = channels[0].iter().fold(0.0_f32, |m, s| m.max(s.abs()));
//! assert!((peak - 0.5).abs() < 0.01);
//! ```
//!
//! # What is rendered
//!
//! Every node the [`Graph`] trait can create: oscillators (the four types and periodic waves), buffer
//! sources, gain, biquad filters, delays (feedback through the graph is supported), the convolver, the stereo
//! panner, the channel merger, the wave shaper, the dynamics compressor, and the destination, with Web Audio's
//! channel up-mix and down-mix rules on every connection. Parameters follow the specification's automation
//! timeline (set, linear and exponential ramps, `setTarget`, cancel), are evaluated for every frame, and can
//! be driven by other nodes' signals (an LFO into a filter, an FM modulator into a frequency).
//!
//! # Differences from a browser
//!
//! The renderer follows the Web Audio specification, but a browser's own code is not reproduced, so the
//! sample values differ in the places below. The conformance corpus compares summaries within tolerances for
//! this reason (see `docs/rust-migration/CONFORMANCE.md`). Nothing here has been listened to.
//!
//! - **Oscillators** are band-limited by wave tables (one per third of an octave of pitch, linearly
//!   interpolated), as browsers do, but the table sizes, the band edges, and so the exact partials near
//!   Nyquist are this crate's own. The built-in types are not normalised, a custom wave is (unless it was
//!   made with normalisation disabled); a browser may normalise the built-ins too, which would change the
//!   level of a square or sawtooth by up to about 1 dB (to be checked against a browser render).
//! - **The dynamics compressor** implements the algorithm the specification and browsers share (a saturating
//!   soft-knee curve, a 6 ms pre-delay so the gain reduction is in place before the loud sample arrives, a
//!   detector that releases over a few milliseconds, an attack that reaches the target in the attack time,
//!   and automatic makeup gain), but its release is a single constant rate rather than the browsers'
//!   adaptive curve. The look-ahead details therefore differ, and so do the peaks it lets through.
//! - **Biquad filters** use the specification's coefficients for every type except the low-pass and
//!   high-pass resonance, which uses the parameterisation browsers use (the dB `Q` is the height of the
//!   resonant peak), so a given `Q` in decibels matches a browser rather than the specification text.
//! - **The convolver** convolves exactly (partitioned FFT) and normalises the impulse response as the
//!   specification says, but it does not cross-fade when the buffer changes: the old tail is dropped.
//! - **Wave shapers** with oversampling add the latency of their anti-aliasing filters (16 frames).
//! - **A `setTarget` followed by a ramp** starts the ramp from the target's start value, not from the curve.
//! - **Cycles** are only allowed through a delay; a cycle without one is muted at one node. A delay inside
//!   a cycle has a minimum delay of one quantum, as in the specification.
//! - **Samples** are `f32`, as in a browser; filter and compressor state is kept in `f64`.
//!
//! # Streaming
//!
//! [`RenderGraph::render_block`] fills a block of any length; call it again for the next. The booking calls of
//! the [`Graph`] trait may be made between blocks (a windowed render does this); a change takes effect from
//! the next whole quantum. [`Graph::current_time`] is the start of the next quantum to render.

mod compressor;
mod convolver;
mod delay;
mod fft;
mod filter;
mod mix;
mod oscillator;
mod shaper;
mod source;
mod timeline;

#[cfg(test)]
mod tests;

use crate::graph::{
	BufferId, ChannelCountMode, ChannelInterpretation, FilterType, Graph, NodeId, NodeKind,
	OscillatorType, Oversample, ParamId, ParamKind, Target, WaveId,
};
use crate::math::{cos, sin};
use compressor::Compressor;
use convolver::Convolver;
use delay::DelayLine;
use filter::Biquad;
use mix::{QUANTUM, mix_add};
use oscillator::WaveTables;
use shaper::Shaper;
use source::SourceState;
use std::collections::VecDeque;
use timeline::Timeline;

/// The renderer's block length in frames: Web Audio's render quantum. The graph always runs in blocks of this
/// many frames, whatever size the caller asks for.
pub const RENDER_QUANTUM: usize = QUANTUM;

/// The most channels any node handles.
const MAX_NODE_CHANNELS: usize = 32;

/// What a node does, with the state it keeps between quanta.
#[derive(Debug, Clone)]
enum Proc {
	/// The destination: its input is the output.
	Destination,
	Oscillator(OscState),
	BufferSource(SourceState),
	Gain,
	Panner,
	Merger,
	Biquad(Biquad),
	Delay(DelayLine),
	Convolver(Box<Convolver>),
	Compressor(Compressor),
	Shaper(Shaper),
}

#[derive(Debug, Clone)]
struct OscState {
	wave: OscWave,
	phase: f64,
	start: Option<u64>,
	stop: Option<u64>,
	finished: bool,
}

#[derive(Debug, Clone, Copy)]
enum OscWave {
	Basic(OscillatorType),
	Custom(WaveId),
}

fn basic_index(kind: OscillatorType) -> usize {
	match kind {
		OscillatorType::Sine => 0,
		OscillatorType::Square => 1,
		OscillatorType::Sawtooth => 2,
		OscillatorType::Triangle => 3,
	}
}

/// One automatable parameter: its timeline and the values of the quantum being rendered.
#[derive(Debug, Clone)]
struct Param {
	kind: ParamKind,
	timeline: Timeline,
	default: f64,
	min: f64,
	max: f64,
	values: Vec<f64>,
	/// Whether `values` is one number for the whole quantum.
	constant: bool,
	/// The summed signals connected to the parameter.
	modulation: Vec<f32>,
	modulated: bool,
}

impl Param {
	fn new(kind: ParamKind, default: f64, min: f64, max: f64) -> Self {
		Self {
			kind,
			timeline: Timeline::new(default),
			default,
			min,
			max,
			values: vec![default; QUANTUM],
			constant: true,
			modulation: vec![0.0; QUANTUM],
			modulated: false,
		}
	}

	fn evaluate(&mut self, frame: u64, sample_rate: f64) {
		let flat = self.timeline.fill(frame, sample_rate, &mut self.values);
		if self.modulated {
			for (value, extra) in self.values.iter_mut().zip(&self.modulation) {
				*value += f64::from(*extra);
			}
		}
		let (min, max, default) = (self.min, self.max, self.default);
		for value in &mut self.values {
			*value = if value.is_nan() {
				default
			} else {
				value.clamp(min, max)
			};
		}
		self.constant = flat && !self.modulated;
	}
}

#[derive(Debug, Clone, Copy)]
struct Connection {
	target: Target,
	output: u32,
	input: u32,
}

#[derive(Debug, Clone, Copy)]
struct Edge {
	from: usize,
	input: usize,
}

#[derive(Debug, Clone, Copy)]
struct ParamEdge {
	from: usize,
	kind: ParamKind,
}

/// One node of the graph. Kept small, because a quantum moves the node being rendered out of the list while it
/// runs (so the nodes it reads can be borrowed); the signal blocks live behind pointers.
#[derive(Debug, Clone)]
struct Node {
	kind: Option<NodeKind>,
	proc: Proc,
	count: usize,
	mode: ChannelCountMode,
	speakers: bool,
	connections: Vec<Connection>,
	edges_in: Vec<Edge>,
	param_edges: Vec<ParamEdge>,
	params: Vec<Param>,
	in_channels: usize,
	out_channels: usize,
	input: Vec<f32>,
	out: Vec<f32>,
	/// Whether `out` is exactly silent in the quantum last rendered (the block itself is not read then).
	silent: bool,
	/// A node in a cycle that has no delay: it is muted.
	muted: bool,
	/// A delay in a cycle, which is read at the start of the quantum and written at the end.
	cycle_delay: bool,
}

impl Node {
	fn placeholder() -> Self {
		Self {
			kind: None,
			proc: Proc::Destination,
			count: 0,
			mode: ChannelCountMode::Max,
			speakers: true,
			connections: Vec::new(),
			edges_in: Vec::new(),
			param_edges: Vec::new(),
			params: Vec::new(),
			in_channels: 0,
			out_channels: 0,
			input: Vec::new(),
			out: Vec::new(),
			silent: true,
			muted: false,
			cycle_delay: false,
		}
	}
}

/// A buffer the graph stores: audio, or a wave-shaper curve.
#[derive(Debug, Clone)]
enum Stored {
	Audio {
		sample_rate: f64,
		channels: Vec<Vec<f32>>,
	},
	Curve(Vec<f32>),
}

#[derive(Debug, Clone)]
struct Wave {
	real: Vec<f64>,
	imag: Vec<f64>,
	normalise: bool,
	tables: Option<WaveTables>,
}

/// A [`Graph`] that renders what the engine books to samples. See the [module documentation](self).
#[derive(Debug, Clone)]
pub struct RenderGraph {
	sample_rate: f64,
	channels: usize,
	max_channels: usize,
	length_frames: u64,
	/// Frames handed out by `render_block` so far.
	produced: u64,
	/// The first frame of the next quantum to render.
	frame: u64,
	nodes: Vec<Node>,
	buffers: Vec<Stored>,
	waves: Vec<Wave>,
	basic: [Option<WaveTables>; 4],
	order: Vec<usize>,
	late: Vec<usize>,
	dirty: bool,
	/// The quantum last rendered, planar, `channels` wide.
	staged: Vec<f32>,
	/// How many frames of `staged` were handed out; a full quantum means it is used up.
	staged_used: usize,
}

impl RenderGraph {
	/// A graph that renders `length_frames` frames of `channels` channels at `sample_rate` hertz, with only the
	/// destination in it. The destination's maximum channel count is `channels`.
	///
	/// # Panics
	///
	/// Panics if `sample_rate` is not positive and finite, or `channels` is not between 1 and 32.
	pub fn new(sample_rate: f64, channels: u32, length_frames: u64) -> Self {
		assert!(
			sample_rate.is_finite() && sample_rate > 0.0,
			"sample rate must be positive"
		);
		assert!(
			(1..=MAX_NODE_CHANNELS as u32).contains(&channels),
			"channels must be 1 to {MAX_NODE_CHANNELS}"
		);
		let channels = channels as usize;
		let mut destination = Node::placeholder();
		destination.count = channels;
		destination.mode = ChannelCountMode::Explicit;
		destination.silent = false;
		Self {
			sample_rate,
			channels,
			max_channels: channels,
			length_frames,
			produced: 0,
			frame: 0,
			nodes: vec![destination],
			buffers: Vec::new(),
			waves: Vec::new(),
			basic: [None, None, None, None],
			order: Vec::new(),
			late: Vec::new(),
			dirty: true,
			staged: vec![0.0; channels * QUANTUM],
			staged_used: QUANTUM,
		}
	}

	/// Placeholder until the sample rate is checked.
	pub fn try_new(
		sample_rate: f64,
		channels: u32,
		length_frames: u64,
	) -> undertone_pattern::Result<Self> {
		Ok(Self::new(sample_rate, channels, length_frames))
	}

	/// How many frames the render is to make in all.
	pub fn length_frames(&self) -> u64 {
		self.length_frames
	}

	/// Changes the length of the render (a booking learns how long the piece is as it goes).
	pub fn set_length_frames(&mut self, length_frames: u64) {
		self.length_frames = length_frames;
	}

	/// How many frames have been handed out so far.
	pub fn frames_rendered(&self) -> u64 {
		self.produced
	}

	/// The number of channels `render_block` fills.
	pub fn channels(&self) -> usize {
		self.channels
	}

	/// Renders the next frames into `out`, one slice per channel, all of the same length. Returns how many
	/// frames were written, which is fewer than the slices hold only at the end of the render (the rest of the
	/// slices is left alone).
	///
	/// ```
	/// use undertone_engine::graph::{Graph, NodeKind};
	/// use undertone_engine::render_graph::RenderGraph;
	///
	/// let mut graph = RenderGraph::new(48_000.0, 1, 300);
	/// let osc = graph.create_node(NodeKind::Oscillator);
	/// graph.connect_node(osc, graph.destination());
	/// graph.start(osc, 0.0);
	///
	/// // Blocks of any size: the same samples as one call for all 300 frames.
	/// let mut block = vec![0.0_f32; 100];
	/// let mut heard = Vec::new();
	/// for _ in 0..3 {
	///     assert_eq!(graph.render_block(&mut [block.as_mut_slice()]), 100);
	///     heard.extend_from_slice(&block);
	/// }
	/// assert_eq!(graph.render_block(&mut [block.as_mut_slice()]), 0, "the render is over");
	/// assert!(heard.iter().any(|s| s.abs() > 0.5));
	/// ```
	///
	/// # Panics
	///
	/// Panics if `out` does not have one slice per channel, or the slices differ in length.
	pub fn render_block(&mut self, out: &mut [&mut [f32]]) -> usize {
		assert_eq!(out.len(), self.channels, "one slice per channel");
		let wanted = out[0].len();
		assert!(
			out.iter().all(|c| c.len() == wanted),
			"slices of one length"
		);
		let mut written = 0;
		while written < wanted && self.produced < self.length_frames {
			if self.staged_used == QUANTUM {
				self.render_quantum();
			}
			let take = (QUANTUM - self.staged_used)
				.min(wanted - written)
				.min((self.length_frames - self.produced) as usize);
			for (channel, slice) in out.iter_mut().enumerate() {
				let from = channel * QUANTUM + self.staged_used;
				slice[written..written + take].copy_from_slice(&self.staged[from..from + take]);
			}
			self.staged_used += take;
			written += take;
			self.produced += take as u64;
		}
		written
	}

	/// Renders everything that is left of the render and returns it, one `Vec` per channel.
	pub fn render_all(&mut self) -> Vec<Vec<f32>> {
		let remaining = (self.length_frames - self.produced.min(self.length_frames)) as usize;
		let mut channels = vec![vec![0.0_f32; remaining]; self.channels];
		let mut slices: Vec<&mut [f32]> = channels.iter_mut().map(Vec::as_mut_slice).collect();
		let written = self.render_block(&mut slices);
		debug_assert_eq!(written, remaining);
		channels
	}

	fn frame_for(&self, when: f64) -> u64 {
		if when.is_nan() || when <= 0.0 {
			return 0;
		}
		let frame = (when * self.sample_rate - 1e-6).ceil();
		if frame >= u64::MAX as f64 {
			u64::MAX
		} else if frame < 0.0 {
			0
		} else {
			frame as u64
		}
	}

	fn node_mut(&mut self, id: NodeId) -> &mut Node {
		&mut self.nodes[id.index()]
	}

	fn nyquist(&self) -> f64 {
		self.sample_rate / 2.0
	}

	fn params_for(&self, kind: NodeKind) -> Vec<Param> {
		let nyquist = self.nyquist();
		let huge = f64::from(f32::MAX);
		match kind {
			NodeKind::Oscillator => {
				vec![Param::new(ParamKind::Frequency, 440.0, -nyquist, nyquist)]
			}
			NodeKind::Gain => vec![Param::new(ParamKind::Gain, 1.0, -huge, huge)],
			NodeKind::BiquadFilter => vec![
				Param::new(ParamKind::Frequency, 350.0, 0.0, nyquist),
				Param::new(ParamKind::Q, 1.0, -huge, huge),
			],
			NodeKind::StereoPanner => vec![Param::new(ParamKind::Pan, 0.0, -1.0, 1.0)],
			NodeKind::BufferSource => vec![Param::new(ParamKind::PlaybackRate, 1.0, -huge, huge)],
			NodeKind::Delay => vec![Param::new(
				ParamKind::DelayTime,
				0.0,
				0.0,
				crate::effects::DELAY_MAX_SECONDS,
			)],
			NodeKind::DynamicsCompressor => vec![
				Param::new(ParamKind::Threshold, -24.0, -100.0, 0.0),
				Param::new(ParamKind::Knee, 30.0, 0.0, 40.0),
				Param::new(ParamKind::Ratio, 12.0, 1.0, 20.0),
				Param::new(ParamKind::Attack, 0.003, 0.0, 1.0),
				Param::new(ParamKind::Release, 0.25, 0.0, 1.0),
			],
			NodeKind::ChannelMerger { .. } | NodeKind::Convolver | NodeKind::WaveShaper => {
				Vec::new()
			}
		}
	}

	// ----- Planning: edges, order, channel counts -----

	/// Rebuilds everything derived from the connections: incoming edges, the order nodes run in, how many
	/// channels each node has, and the blocks and state that follow from that.
	fn prepare(&mut self) {
		let count = self.nodes.len();
		for node in &mut self.nodes {
			node.edges_in.clear();
			node.param_edges.clear();
			node.muted = false;
			node.cycle_delay = false;
		}
		for from in 0..count {
			for k in 0..self.nodes[from].connections.len() {
				let connection = self.nodes[from].connections[k];
				if connection.output != 0 {
					continue;
				}
				match connection.target {
					Target::Node(to) => self.nodes[to.index()].edges_in.push(Edge {
						from,
						input: connection.input as usize,
					}),
					Target::Param(param) => {
						self.nodes[param.node().index()]
							.param_edges
							.push(ParamEdge {
								from,
								kind: param.kind(),
							})
					}
				}
			}
		}
		self.plan_order();
		self.settle_channels();
		self.allocate();
		self.ensure_wave_tables();
		self.dirty = false;
	}

	fn plan_order(&mut self) {
		let count = self.nodes.len();
		let mut outs: Vec<Vec<usize>> = vec![Vec::new(); count];
		let mut waiting = vec![0_usize; count];
		for (to, node) in self.nodes.iter().enumerate() {
			if to == 0 {
				continue;
			}
			for edge in &node.edges_in {
				outs[edge.from].push(to);
				waiting[to] += 1;
			}
			for edge in &node.param_edges {
				outs[edge.from].push(to);
				waiting[to] += 1;
			}
		}
		let mut placed = vec![false; count];
		placed[0] = true;
		let mut queue: VecDeque<usize> = VecDeque::new();
		for (index, wait) in waiting.iter().enumerate().skip(1) {
			if *wait == 0 {
				placed[index] = true;
				queue.push_back(index);
			}
		}
		let mut order = Vec::with_capacity(count);
		let mut late = Vec::new();
		loop {
			while let Some(index) = queue.pop_front() {
				order.push(index);
				for &to in &outs[index] {
					if !placed[to] {
						waiting[to] -= 1;
						if waiting[to] == 0 {
							placed[to] = true;
							queue.push_back(to);
						}
					}
				}
			}
			if order.len() + 1 >= count {
				break;
			}
			// Stuck on a cycle: a delay in it is read first and written last; with no delay the node is muted.
			let on_cycle = |index: usize| -> bool {
				let mut seen = vec![false; count];
				let mut stack = vec![index];
				while let Some(at) = stack.pop() {
					for &to in &outs[at] {
						if to == index {
							return true;
						}
						if !placed[to] && !seen[to] {
							seen[to] = true;
							stack.push(to);
						}
					}
				}
				false
			};
			let unplaced = || (1..count).filter(|i| !placed[*i]);
			let delay = unplaced()
				.find(|i| matches!(self.nodes[*i].kind, Some(NodeKind::Delay)) && on_cycle(*i));
			let pick = delay.or_else(|| unplaced().find(|i| on_cycle(*i)));
			let Some(pick) = pick else {
				// Unreachable for a graph with a cycle; place what is left in index order rather than loop.
				let rest: Vec<usize> = unplaced().collect();
				for index in rest {
					placed[index] = true;
					order.push(index);
				}
				break;
			};
			if delay.is_some() {
				self.nodes[pick].cycle_delay = true;
				late.push(pick);
			} else {
				self.nodes[pick].muted = true;
			}
			placed[pick] = true;
			queue.push_back(pick);
		}
		self.order = order;
		self.late = late;
	}

	fn computed_input_channels(&self, index: usize) -> usize {
		let node = &self.nodes[index];
		match node.kind {
			None => self.nodes[0].count.clamp(1, self.channels),
			Some(NodeKind::Oscillator | NodeKind::BufferSource) => 0,
			Some(NodeKind::ChannelMerger { inputs }) => {
				(inputs as usize).clamp(1, MAX_NODE_CHANNELS)
			}
			Some(_) => {
				let widest = node
					.edges_in
					.iter()
					.map(|edge| self.nodes[edge.from].out_channels)
					.max()
					.unwrap_or(0)
					.max(1);
				let count = node.count.clamp(1, MAX_NODE_CHANNELS);
				match node.mode {
					ChannelCountMode::Max => widest,
					ChannelCountMode::ClampedMax => widest.min(count),
					ChannelCountMode::Explicit => count,
				}
			}
		}
		.min(MAX_NODE_CHANNELS)
	}

	fn output_channels(&self, index: usize, input_channels: usize) -> usize {
		let node = &self.nodes[index];
		match (&node.proc, node.kind) {
			(Proc::Destination, _) => 0,
			(_, Some(NodeKind::Oscillator)) => 1,
			(Proc::BufferSource(state), _) => {
				match state.buffer.map(|b| &self.buffers[b.index()]) {
					Some(Stored::Audio { channels, .. }) => {
						channels.len().clamp(1, MAX_NODE_CHANNELS)
					}
					_ => 1,
				}
			}
			(Proc::Convolver(convolver), _) => convolver.output_channels(input_channels),
			(_, Some(NodeKind::StereoPanner)) => 2,
			(_, Some(NodeKind::ChannelMerger { inputs })) => {
				(inputs as usize).clamp(1, MAX_NODE_CHANNELS)
			}
			_ => input_channels,
		}
	}

	/// Works out every node's channel counts. They depend on the sources' counts, so it goes round the order
	/// until nothing changes (a cycle takes a few rounds).
	fn settle_channels(&mut self) {
		for _ in 0..8 {
			let mut changed = false;
			let mut sequence: Vec<usize> = self.order.clone();
			sequence.push(0);
			for index in sequence {
				let input = self.computed_input_channels(index);
				let output = self.output_channels(index, input);
				let node = &mut self.nodes[index];
				if node.in_channels != input || node.out_channels != output {
					node.in_channels = input;
					node.out_channels = output;
					changed = true;
				}
			}
			if !changed {
				break;
			}
		}
	}

	fn allocate(&mut self) {
		for node in &mut self.nodes {
			node.input.resize(node.in_channels * QUANTUM, 0.0);
			node.out.resize(node.out_channels * QUANTUM, 0.0);
			match &mut node.proc {
				Proc::Biquad(filter) => filter.resize(node.in_channels),
				Proc::Delay(line) => line.resize(node.in_channels),
				Proc::Convolver(convolver) => convolver.resize(node.in_channels),
				Proc::Compressor(compressor) => compressor.resize(node.in_channels),
				Proc::Shaper(shaper) => shaper.resize(node.in_channels),
				_ => {}
			}
		}
	}

	fn ensure_wave_tables(&mut self) {
		let rate = self.sample_rate;
		let mut basic_needed = [false; 4];
		let mut custom_needed = Vec::new();
		for node in &self.nodes {
			if let Proc::Oscillator(state) = &node.proc {
				match state.wave {
					OscWave::Basic(kind) => basic_needed[basic_index(kind)] = true,
					OscWave::Custom(id) => custom_needed.push(id.index()),
				}
			}
		}
		for (kind, needed) in [
			OscillatorType::Sine,
			OscillatorType::Square,
			OscillatorType::Sawtooth,
			OscillatorType::Triangle,
		]
		.into_iter()
		.zip(basic_needed)
		{
			let slot = &mut self.basic[basic_index(kind)];
			if needed && slot.is_none() {
				*slot = Some(WaveTables::basic(kind, rate));
			}
		}
		for index in custom_needed {
			let wave = &mut self.waves[index];
			if wave.tables.is_none() {
				wave.tables = Some(WaveTables::new(
					&wave.real,
					&wave.imag,
					wave.normalise,
					rate,
				));
			}
		}
	}

	// ----- Rendering -----

	fn render_quantum(&mut self) {
		if self.dirty {
			self.prepare();
		}
		let frame = self.frame;
		for position in 0..self.order.len() {
			let index = self.order[position];
			self.render_node(index, frame);
		}
		for position in 0..self.late.len() {
			let index = self.late[position];
			self.finish_late(index);
		}
		self.mix_destination();
		self.frame += QUANTUM as u64;
		self.staged_used = 0;
	}

	fn any_input_sounding(&self, node: &Node) -> bool {
		node.edges_in
			.iter()
			.any(|edge| !self.nodes[edge.from].silent)
	}

	/// Whether a node can be left out of this quantum with a silent output, without touching its state.
	fn can_skip(&self, index: usize, frame: u64) -> bool {
		let node = &self.nodes[index];
		if node.muted {
			return true;
		}
		match &node.proc {
			Proc::Oscillator(state) => {
				state.finished
					|| state
						.start
						.is_none_or(|start| start >= frame + QUANTUM as u64)
					|| state.stop.is_some_and(|stop| stop <= frame)
			}
			Proc::BufferSource(state) => !state.is_live(frame),
			Proc::Gain | Proc::Panner | Proc::Merger => !self.any_input_sounding(node),
			Proc::Biquad(filter) => !self.any_input_sounding(node) && filter.settled(),
			Proc::Delay(line) => {
				line.is_clear() && (node.cycle_delay || !self.any_input_sounding(node))
			}
			Proc::Convolver(convolver) => convolver.is_finished() && !self.any_input_sounding(node),
			Proc::Compressor(_) | Proc::Shaper(_) | Proc::Destination => false,
		}
	}

	fn render_node(&mut self, index: usize, frame: u64) {
		if self.can_skip(index, frame) {
			self.nodes[index].silent = true;
			return;
		}
		let mut node = std::mem::replace(&mut self.nodes[index], Node::placeholder());
		self.run(&mut node, frame);
		self.nodes[index] = node;
	}

	/// Sums the sources of `node` into its input block, mixing each to the node's channel count.
	fn gather(&self, node: &mut Node) {
		let channels = node.in_channels;
		node.input[..channels * QUANTUM].fill(0.0);
		let merger = matches!(node.kind, Some(NodeKind::ChannelMerger { .. }));
		for edge in &node.edges_in {
			let source = &self.nodes[edge.from];
			if source.silent {
				continue;
			}
			if merger {
				if edge.input < channels {
					let to = &mut node.input[edge.input * QUANTUM..(edge.input + 1) * QUANTUM];
					mix_add(to, 1, &source.out, source.out_channels, true);
				}
			} else {
				mix_add(
					&mut node.input,
					channels,
					&source.out,
					source.out_channels,
					node.speakers,
				);
			}
		}
	}

	/// Evaluates every parameter of `node` for the quantum, with the signals connected to it added.
	fn evaluate_params(&self, node: &mut Node, frame: u64) {
		for param in &mut node.params {
			param.modulated = false;
			for edge in node
				.param_edges
				.iter()
				.filter(|edge| edge.kind == param.kind)
			{
				let source = &self.nodes[edge.from];
				if source.silent {
					continue;
				}
				if !param.modulated {
					param.modulation.fill(0.0);
					param.modulated = true;
				}
				mix_add(
					&mut param.modulation,
					1,
					&source.out,
					source.out_channels,
					true,
				);
			}
			param.evaluate(frame, self.sample_rate);
		}
	}

	fn run(&self, node: &mut Node, frame: u64) {
		self.evaluate_params(node, frame);
		node.silent = false;
		match node.proc {
			Proc::Oscillator(_) => return self.run_oscillator(node, frame),
			Proc::BufferSource(_) => return self.run_source(node, frame),
			_ => {}
		}
		let cycle_delay = node.cycle_delay;
		if !cycle_delay {
			self.gather(node);
		}
		let silent_input = !self.any_input_sounding(node);
		let sample_rate = self.sample_rate;
		let Node {
			proc,
			input,
			out,
			params,
			in_channels,
			out_channels,
			silent,
			..
		} = node;
		let (channels, size) = (*in_channels, *in_channels * QUANTUM);
		match proc {
			Proc::Destination | Proc::Oscillator(_) | Proc::BufferSource(_) => {}
			Proc::Gain => {
				let gain = &params[0];
				for channel in 0..channels {
					let range = channel * QUANTUM..(channel + 1) * QUANTUM;
					let (from, to) = (&input[range.clone()], &mut out[range]);
					if gain.constant {
						let g = gain.values[0] as f32;
						for (o, i) in to.iter_mut().zip(from) {
							*o = *i * g;
						}
					} else {
						for ((o, i), g) in to.iter_mut().zip(from).zip(&gain.values) {
							*o = *i * *g as f32;
						}
					}
				}
			}
			Proc::Panner => run_panner(input, out, &params[0], channels),
			Proc::Merger => {
				let shared = size.min(*out_channels * QUANTUM);
				out[..shared].copy_from_slice(&input[..shared]);
			}
			Proc::Biquad(filter) => {
				let (frequency, q) = (&params[0], &params[1]);
				filter.process(
					input,
					out,
					channels,
					&frequency.values,
					&q.values,
					frequency.constant && q.constant,
					sample_rate / 2.0,
				);
			}
			Proc::Delay(line) => {
				if cycle_delay {
					line.read(&params[0].values, sample_rate, out);
				} else {
					line.process(input, silent_input, &params[0].values, sample_rate, out);
				}
				*silent = out[..*out_channels * QUANTUM].iter().all(|v| *v == 0.0);
			}
			Proc::Compressor(compressor) => {
				let [threshold, knee, ratio, attack, release] =
					[0, 1, 2, 3, 4].map(|slot| params[slot].values[0]);
				compressor.process(
					input,
					out,
					channels,
					[threshold, knee, ratio, attack, release],
				);
			}
			Proc::Shaper(shaper) => shaper.process(input, out, channels),
			Proc::Convolver(convolver) => {
				convolver.process(input, channels, silent_input, out);
				*silent = out[..*out_channels * QUANTUM].iter().all(|v| *v == 0.0);
			}
		}
	}

	fn run_oscillator(&self, node: &mut Node, frame: u64) {
		let Proc::Oscillator(state) = &mut node.proc else {
			return;
		};
		let tables = match state.wave {
			OscWave::Basic(kind) => self.basic[basic_index(kind)].as_ref(),
			OscWave::Custom(id) => self.waves[id.index()].tables.as_ref(),
		};
		let Some(tables) = tables else {
			node.silent = true;
			return;
		};
		let frequency = &node.params[0];
		let sample_rate = self.sample_rate;
		let mut band = tables.band(frequency.values[0]);
		let mut sounded = false;
		for i in 0..QUANTUM {
			let at = frame + i as u64;
			let active = state.start.is_some_and(|start| at >= start);
			if state.stop.is_some_and(|stop| at >= stop) {
				state.finished = true;
			}
			if !active || state.finished {
				node.out[i] = 0.0;
				continue;
			}
			let hertz = frequency.values[i];
			if !frequency.constant {
				band = tables.band(hertz);
			}
			node.out[i] = tables.read(band, state.phase);
			sounded = true;
			state.phase += hertz / sample_rate;
			state.phase -= state.phase.floor();
		}
		node.silent = !sounded;
	}

	fn run_source(&self, node: &mut Node, frame: u64) {
		let Proc::BufferSource(state) = &mut node.proc else {
			return;
		};
		let Some(Stored::Audio {
			sample_rate,
			channels,
		}) = state.buffer.map(|b| &self.buffers[b.index()])
		else {
			node.silent = true;
			return;
		};
		let silent = state.process(
			channels,
			*sample_rate,
			self.sample_rate,
			&node.params[0].values,
			&mut node.out,
			frame,
		);
		node.silent = silent;
	}

	/// The write half of a delay inside a cycle: runs after every node of the quantum has been rendered.
	fn finish_late(&mut self, index: usize) {
		let mut node = std::mem::replace(&mut self.nodes[index], Node::placeholder());
		self.gather(&mut node);
		let silent_input = !self.any_input_sounding(&node);
		if let Proc::Delay(line) = &mut node.proc {
			line.write(&node.input, silent_input);
		}
		self.nodes[index] = node;
	}

	/// Mixes the destination's input into the staged output quantum.
	fn mix_destination(&mut self) {
		let mut node = std::mem::replace(&mut self.nodes[0], Node::placeholder());
		let wanted = node.in_channels;
		node.input[..wanted * QUANTUM].fill(0.0);
		for edge in &node.edges_in {
			let source = &self.nodes[edge.from];
			if !source.silent {
				mix_add(
					&mut node.input,
					wanted,
					&source.out,
					source.out_channels,
					node.speakers,
				);
			}
		}
		self.staged.fill(0.0);
		let shared = wanted.min(self.channels);
		self.staged[..shared * QUANTUM].copy_from_slice(&node.input[..shared * QUANTUM]);
		node.silent = false;
		self.nodes[0] = node;
	}
}

/// The stereo panner's equal-power law for a mono or stereo input.
fn run_panner(input: &[f32], out: &mut [f32], pan: &Param, channels: usize) {
	let stereo = channels == 2;
	for i in 0..QUANTUM {
		let position = pan.values[if pan.constant { 0 } else { i }];
		let (left, right);
		if stereo {
			let (l, r) = (input[i], input[QUANTUM + i]);
			if position <= 0.0 {
				let angle = (position + 1.0) * core::f64::consts::FRAC_PI_2;
				left = l + r * cos(angle) as f32;
				right = r * sin(angle) as f32;
			} else {
				let angle = position * core::f64::consts::FRAC_PI_2;
				left = l * cos(angle) as f32;
				right = r + l * sin(angle) as f32;
			}
		} else {
			let angle = (position + 1.0) * core::f64::consts::FRAC_PI_4;
			let m = input[i];
			left = m * cos(angle) as f32;
			right = m * sin(angle) as f32;
		}
		out[i] = left;
		out[QUANTUM + i] = right;
	}
}

impl Graph for RenderGraph {
	fn sample_rate(&self) -> f64 {
		self.sample_rate
	}

	fn current_time(&self) -> f64 {
		self.frame as f64 / self.sample_rate
	}

	fn destination_channels(&self) -> u32 {
		self.nodes[0].count as u32
	}

	fn destination_max_channels(&self) -> u32 {
		self.max_channels as u32
	}

	fn create_node(&mut self, kind: NodeKind) -> NodeId {
		let mut node = Node::placeholder();
		node.kind = Some(kind);
		node.params = self.params_for(kind);
		node.silent = true;
		let (count, mode) = match kind {
			NodeKind::StereoPanner | NodeKind::Convolver | NodeKind::DynamicsCompressor => {
				(2, ChannelCountMode::ClampedMax)
			}
			NodeKind::ChannelMerger { .. } => (1, ChannelCountMode::Explicit),
			_ => (2, ChannelCountMode::Max),
		};
		node.count = count;
		node.mode = mode;
		node.proc = match kind {
			NodeKind::Oscillator => Proc::Oscillator(OscState {
				wave: OscWave::Basic(OscillatorType::Sine),
				phase: 0.0,
				start: None,
				stop: None,
				finished: false,
			}),
			NodeKind::BufferSource => Proc::BufferSource(SourceState::new()),
			NodeKind::Gain => Proc::Gain,
			NodeKind::StereoPanner => Proc::Panner,
			NodeKind::ChannelMerger { .. } => Proc::Merger,
			NodeKind::BiquadFilter => Proc::Biquad(Biquad::new()),
			NodeKind::Delay => Proc::Delay(DelayLine::new(
				crate::effects::DELAY_MAX_SECONDS,
				self.sample_rate,
			)),
			NodeKind::Convolver => Proc::Convolver(Box::new(Convolver::new())),
			NodeKind::DynamicsCompressor => Proc::Compressor(Compressor::new(self.sample_rate)),
			NodeKind::WaveShaper => Proc::Shaper(Shaper::new()),
		};
		self.nodes.push(node);
		self.dirty = true;
		NodeId::new(self.nodes.len() as u32 - 1)
	}

	fn param(&self, node: NodeId, kind: ParamKind) -> ParamId {
		let record = &self.nodes[node.index()];
		assert!(
			record.params.iter().any(|param| param.kind == kind),
			"the node has no {} parameter",
			kind.name()
		);
		ParamId::new(node, kind)
	}

	fn automate(&mut self, param: ParamId, call: crate::graph::Automation) {
		use crate::graph::Automation;
		let node = self.node_mut(param.node());
		let slot = node
			.params
			.iter_mut()
			.find(|slot| slot.kind == param.kind())
			.expect("a ParamId names a parameter its node has");
		match call {
			Automation::Set { value, time } => slot.timeline.set_value(value, time),
			Automation::LinearRamp { value, time } => slot.timeline.linear_ramp(value, time),
			Automation::ExponentialRamp { value, time } => {
				slot.timeline.exponential_ramp(value, time);
			}
			Automation::Target {
				value,
				time,
				time_constant,
			} => slot.timeline.set_target(value, time, time_constant),
			Automation::Cancel { time } => slot.timeline.cancel(time),
		}
	}

	fn set_oscillator_type(&mut self, node: NodeId, kind: OscillatorType) {
		let node = self.node_mut(node);
		let Proc::Oscillator(state) = &mut node.proc else {
			panic!("an oscillator type is not valid on this node");
		};
		state.wave = OscWave::Basic(kind);
		self.dirty = true;
	}

	fn set_periodic_wave(&mut self, node: NodeId, wave: WaveId) {
		let node = self.node_mut(node);
		let Proc::Oscillator(state) = &mut node.proc else {
			panic!("a periodic wave is not valid on this node");
		};
		state.wave = OscWave::Custom(wave);
		self.dirty = true;
	}

	fn set_filter_type(&mut self, node: NodeId, kind: FilterType) {
		let Proc::Biquad(filter) = &mut self.node_mut(node).proc else {
			panic!("a filter type is not valid on this node");
		};
		filter.kind = kind;
	}

	fn set_buffer(&mut self, node: NodeId, buffer: Option<BufferId>) {
		let (rate, stored) = (self.sample_rate, buffer.map(|b| &self.buffers[b.index()]));
		let node = &mut self.nodes[node.index()];
		match &mut node.proc {
			Proc::BufferSource(state) => state.buffer = buffer,
			Proc::Convolver(convolver) => match stored {
				Some(Stored::Audio {
					sample_rate,
					channels,
				}) => convolver.set_response(Some(channels), *sample_rate, rate),
				_ => convolver.set_response(None, rate, rate),
			},
			_ => panic!("a buffer is not valid on this node"),
		}
		self.dirty = true;
	}

	fn set_loop(&mut self, node: NodeId, looping: bool) {
		let node = self.node_mut(node);
		let Proc::BufferSource(state) = &mut node.proc else {
			panic!("loop is not valid on this node");
		};
		state.looping = looping;
	}

	fn set_curve(&mut self, node: NodeId, curve: Option<BufferId>) {
		let samples = curve.map(|b| match &self.buffers[b.index()] {
			Stored::Curve(samples) => samples.clone(),
			Stored::Audio { channels, .. } => channels[0].clone(),
		});
		let Proc::Shaper(shaper) = &mut self.node_mut(node).proc else {
			panic!("a curve is not valid on this node");
		};
		shaper.set_curve(samples);
	}

	fn set_oversample(&mut self, node: NodeId, oversample: Oversample) {
		let Proc::Shaper(shaper) = &mut self.node_mut(node).proc else {
			panic!("oversample is not valid on this node");
		};
		shaper.set_oversample(oversample);
		self.dirty = true;
	}

	fn set_channel_count(&mut self, node: NodeId, count: u32) {
		let max = if node.index() == 0 {
			self.max_channels
		} else {
			MAX_NODE_CHANNELS
		};
		self.node_mut(node).count = (count as usize).clamp(1, max);
		self.dirty = true;
	}

	fn set_channel_count_mode(&mut self, node: NodeId, mode: ChannelCountMode) {
		self.node_mut(node).mode = mode;
		self.dirty = true;
	}

	fn set_channel_interpretation(&mut self, node: NodeId, interpretation: ChannelInterpretation) {
		self.node_mut(node).speakers = interpretation == ChannelInterpretation::Speakers;
	}

	fn connect(&mut self, from: NodeId, to: Target, output: u32, input: u32) {
		let connection = Connection {
			target: to,
			output,
			input,
		};
		let node = self.node_mut(from);
		// Connecting the same pair twice does nothing, as in Web Audio.
		let same = |c: &Connection| c.target == to && c.output == output && c.input == input;
		if !node.connections.iter().any(same) {
			node.connections.push(connection);
			self.dirty = true;
		}
	}

	fn disconnect(&mut self, node: NodeId) {
		self.node_mut(node).connections.clear();
		self.dirty = true;
	}

	fn start(&mut self, node: NodeId, when: f64) {
		let frame = self.frame_for(when);
		match &mut self.node_mut(node).proc {
			Proc::Oscillator(state) => state.start = Some(frame),
			Proc::BufferSource(state) => state.start = Some(frame),
			_ => panic!("start is not valid on this node"),
		}
	}

	fn stop(&mut self, node: NodeId, when: f64) {
		let frame = self.frame_for(when);
		match &mut self.node_mut(node).proc {
			Proc::Oscillator(state) => state.stop = Some(frame),
			Proc::BufferSource(state) => state.stop = Some(frame),
			_ => panic!("stop is not valid on this node"),
		}
	}

	fn create_buffer(&mut self, channels: u32, length: usize, sample_rate: f64) -> BufferId {
		self.buffers.push(Stored::Audio {
			sample_rate,
			channels: vec![vec![0.0; length]; channels.max(1) as usize],
		});
		BufferId::new(self.buffers.len() as u32 - 1)
	}

	fn buffer_channel_mut(&mut self, buffer: BufferId, channel: u32) -> &mut [f32] {
		match &mut self.buffers[buffer.index()] {
			Stored::Audio { channels, .. } => &mut channels[channel as usize],
			Stored::Curve(_) => panic!("a curve has no channels to write"),
		}
	}

	fn create_curve(&mut self, samples: &[f32]) -> BufferId {
		self.buffers.push(Stored::Curve(samples.to_vec()));
		BufferId::new(self.buffers.len() as u32 - 1)
	}

	fn create_periodic_wave(
		&mut self,
		real: &[f32],
		imag: &[f32],
		disable_normalization: bool,
	) -> WaveId {
		self.waves.push(Wave {
			real: real.iter().map(|v| f64::from(*v)).collect(),
			imag: imag.iter().map(|v| f64::from(*v)).collect(),
			normalise: !disable_normalization,
			tables: None,
		});
		WaveId::new(self.waves.len() as u32 - 1)
	}
}
