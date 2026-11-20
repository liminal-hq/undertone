// The audio graph an engine books voices on, as a trait, with a recorder that writes the layer 3 format
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The [`Graph`] trait: the Web Audio calls the TypeScript engine makes on its context, as a Rust trait.
//!
//! The engine books a voice by creating nodes, setting their fields, scheduling automation on their
//! parameters, connecting them, and starting and stopping the sources. The TypeScript does that on a Web
//! Audio context; here the same calls go through [`Graph`], so one booking can drive different back-ends:
//!
//! - [`LogGraph`] records every call in the layer 3 corpus format ([`GraphRecord`]), which is how the booking
//!   is checked against the TypeScript reference, byte for byte.
//! - [`RenderGraph`](crate::render_graph::RenderGraph), the in-house renderer, implements it to make samples.
//! - A Web Audio bridge can implement it to play through a browser.
//!
//! Nodes, parameters, buffers, and periodic waves are named by small `Copy` handles ([`NodeId`], [`ParamId`],
//! [`BufferId`], [`WaveId`]) that the graph hands out, so booking code holds no borrows into the graph and
//! needs no lifetimes. Times are in seconds on the context's clock, as `f64`, exactly as in JavaScript. The
//! module needs only `alloc`.
//!
//! ```
//! use undertone_engine::graph::{Graph, LogGraph, NodeKind, OscillatorType, ParamKind};
//!
//! let mut graph = LogGraph::new(44_100.0, 2);
//! let osc = graph.create_node(NodeKind::Oscillator);
//! let gain = graph.create_node(NodeKind::Gain);
//! graph.set_oscillator_type(osc, OscillatorType::Triangle);
//! let frequency = graph.param(osc, ParamKind::Frequency);
//! graph.set_value_at_time(frequency, 220.0, 0.0);
//! let level = graph.param(gain, ParamKind::Gain);
//! graph.set_value_at_time(level, 0.0, 0.0);
//! graph.linear_ramp_to_value_at_time(level, 0.3, 0.01);
//! graph.connect_node(osc, gain);
//! graph.connect_node(gain, graph.destination());
//! graph.start(osc, 0.0);
//! graph.stop(osc, 0.72);
//!
//! let record = graph.finish(None);
//! assert_eq!(record.counts, [("destination".into(), 1), ("oscillator".into(), 1), ("gain".into(), 1), ("total".into(), 3)]);
//! assert!(record.to_json("").contains(r#"{"id":"n2","kind":"gain","params":{"gain":["set 0 @0","lin 0.3 @0.01"]},"to":["n0"]}"#));
//! ```

mod log;
mod number;

pub use log::{
	BufferKind, BufferRecord, ChannelSummary, GraphRecord, Heard, LogGraph, NodeRecord,
	RecordValue, WaveRecord,
};
pub use number::{nine_digits_json, nine_digits_text};

/// A node of a [`Graph`]. Node `0` is always the destination, and nodes are numbered in creation order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(u32);

impl NodeId {
	/// The handle for the node at `index` in creation order. A [`Graph`] implementation makes these in
	/// [`Graph::create_node`]; the destination is index `0`, so a graph numbers the nodes it creates from `1`.
	pub const fn new(index: u32) -> Self {
		Self(index)
	}
}

impl NodeId {
	/// The node's position in creation order: `0` is the destination.
	pub const fn index(self) -> usize {
		self.0 as usize
	}
}

/// A parameter of a node (`gain`, `frequency`, and so on). Get one with [`Graph::param`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ParamId {
	node: NodeId,
	kind: ParamKind,
}

impl ParamId {
	/// The parameter `kind` of `node`. A [`Graph`] implementation makes these in [`Graph::param`].
	pub const fn new(node: NodeId, kind: ParamKind) -> Self {
		Self { node, kind }
	}

	/// The node the parameter belongs to.
	pub fn node(self) -> NodeId {
		self.node
	}

	/// Which parameter of the node it is.
	pub fn kind(self) -> ParamKind {
		self.kind
	}
}

/// A buffer of samples: an impulse response, a noise buffer, a sample, or a wave-shaper curve. Handed out by
/// [`Graph::create_buffer`] and [`Graph::create_curve`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BufferId(u32);

impl BufferId {
	/// The handle for the buffer at `index`, in the order the graph made them.
	pub const fn new(index: u32) -> Self {
		Self(index)
	}

	/// The buffer's position in the order the graph made them.
	pub const fn index(self) -> usize {
		self.0 as usize
	}
}

/// A periodic wave, handed out by [`Graph::create_periodic_wave`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WaveId(u32);

impl WaveId {
	/// The handle for the periodic wave at `index`, in the order the graph made them.
	pub const fn new(index: u32) -> Self {
		Self(index)
	}

	/// The wave's position in the order the graph made them.
	pub const fn index(self) -> usize {
		self.0 as usize
	}
}

/// What a connection goes to: a node's input, or another node's parameter (a low-frequency oscillator driving
/// a filter's frequency).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Target {
	/// The input of a node.
	Node(NodeId),
	/// A parameter, which the connected signal modulates.
	Param(ParamId),
}

impl From<NodeId> for Target {
	fn from(node: NodeId) -> Self {
		Self::Node(node)
	}
}

impl From<ParamId> for Target {
	fn from(param: ParamId) -> Self {
		Self::Param(param)
	}
}

/// The kinds of node the engine creates. The destination exists from the start and is not made by the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NodeKind {
	/// `createOscillator()`: parameter `frequency`.
	Oscillator,
	/// `createGain()`: parameter `gain`.
	Gain,
	/// `createBiquadFilter()`: parameters `frequency` and `Q`.
	BiquadFilter,
	/// `createStereoPanner()`: parameter `pan`.
	StereoPanner,
	/// `createChannelMerger(inputs)`: the number of inputs.
	ChannelMerger {
		/// How many inputs the merger has.
		inputs: u32,
	},
	/// `createBufferSource()`: parameter `playbackRate`.
	BufferSource,
	/// `createConvolver()`.
	Convolver,
	/// `createDelay()`: parameter `delayTime`.
	Delay,
	/// `createDynamicsCompressor()`: parameters `threshold`, `knee`, `ratio`, `attack`, and `release`.
	DynamicsCompressor,
	/// `createWaveShaper()`.
	WaveShaper,
}

/// The parameters a node can have, named as Web Audio names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParamKind {
	/// `frequency` of an oscillator or a filter.
	Frequency,
	/// `gain` of a gain node.
	Gain,
	/// `Q` of a filter.
	Q,
	/// `pan` of a stereo panner.
	Pan,
	/// `delayTime` of a delay.
	DelayTime,
	/// `threshold` of a compressor.
	Threshold,
	/// `knee` of a compressor.
	Knee,
	/// `ratio` of a compressor.
	Ratio,
	/// `attack` of a compressor.
	Attack,
	/// `release` of a compressor.
	Release,
	/// `playbackRate` of a buffer source.
	PlaybackRate,
}

impl ParamKind {
	/// The Web Audio property name, which is also the key in a recorded graph.
	pub fn name(self) -> &'static str {
		match self {
			Self::Frequency => "frequency",
			Self::Gain => "gain",
			Self::Q => "Q",
			Self::Pan => "pan",
			Self::DelayTime => "delayTime",
			Self::Threshold => "threshold",
			Self::Knee => "knee",
			Self::Ratio => "ratio",
			Self::Attack => "attack",
			Self::Release => "release",
			Self::PlaybackRate => "playbackRate",
		}
	}
}

/// One call of the automation interface of an `AudioParam`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Automation {
	/// `setValueAtTime(value, time)`.
	Set {
		/// The value to jump to.
		value: f64,
		/// When, in seconds.
		time: f64,
	},
	/// `linearRampToValueAtTime(value, time)`.
	LinearRamp {
		/// The value to reach.
		value: f64,
		/// When it is reached, in seconds.
		time: f64,
	},
	/// `exponentialRampToValueAtTime(value, time)`.
	ExponentialRamp {
		/// The value to reach.
		value: f64,
		/// When it is reached, in seconds.
		time: f64,
	},
	/// `setTargetAtTime(value, time, timeConstant)`: an exponential approach.
	Target {
		/// The value approached.
		value: f64,
		/// When the approach starts, in seconds.
		time: f64,
		/// The time constant of the approach, in seconds.
		time_constant: f64,
	},
	/// `cancelScheduledValues(time)`.
	Cancel {
		/// From when, in seconds, scheduled changes are dropped.
		time: f64,
	},
}

/// The `type` of an oscillator. A periodic wave sets the type to custom through [`Graph::set_periodic_wave`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OscillatorType {
	/// `"sine"`, the default.
	Sine,
	/// `"square"`.
	Square,
	/// `"sawtooth"`.
	Sawtooth,
	/// `"triangle"`.
	Triangle,
}

impl OscillatorType {
	/// The Web Audio name.
	pub fn name(self) -> &'static str {
		match self {
			Self::Sine => "sine",
			Self::Square => "square",
			Self::Sawtooth => "sawtooth",
			Self::Triangle => "triangle",
		}
	}
}

/// The `type` of a biquad filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FilterType {
	/// `"lowpass"`, the default.
	Lowpass,
	/// `"highpass"`.
	Highpass,
	/// `"bandpass"`.
	Bandpass,
	/// `"lowshelf"`.
	Lowshelf,
	/// `"highshelf"`.
	Highshelf,
	/// `"peaking"`.
	Peaking,
	/// `"notch"`.
	Notch,
	/// `"allpass"`.
	Allpass,
}

impl FilterType {
	/// The Web Audio name.
	pub fn name(self) -> &'static str {
		match self {
			Self::Lowpass => "lowpass",
			Self::Highpass => "highpass",
			Self::Bandpass => "bandpass",
			Self::Lowshelf => "lowshelf",
			Self::Highshelf => "highshelf",
			Self::Peaking => "peaking",
			Self::Notch => "notch",
			Self::Allpass => "allpass",
		}
	}
}

/// The `oversample` of a wave shaper.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Oversample {
	/// `"none"`, the default.
	None,
	/// `"2x"`.
	X2,
	/// `"4x"`.
	X4,
}

impl Oversample {
	/// The Web Audio name.
	pub fn name(self) -> &'static str {
		match self {
			Self::None => "none",
			Self::X2 => "2x",
			Self::X4 => "4x",
		}
	}
}

/// The `channelCountMode` of a node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelCountMode {
	/// `"max"`.
	Max,
	/// `"clamped-max"`.
	ClampedMax,
	/// `"explicit"`.
	Explicit,
}

impl ChannelCountMode {
	/// The Web Audio name.
	pub fn name(self) -> &'static str {
		match self {
			Self::Max => "max",
			Self::ClampedMax => "clamped-max",
			Self::Explicit => "explicit",
		}
	}
}

/// The `channelInterpretation` of a node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelInterpretation {
	/// `"speakers"`, the default of the destination.
	Speakers,
	/// `"discrete"`: channels are not mixed by layout.
	Discrete,
}

impl ChannelInterpretation {
	/// The Web Audio name.
	pub fn name(self) -> &'static str {
		match self {
			Self::Speakers => "speakers",
			Self::Discrete => "discrete",
		}
	}
}

/// A group of nodes and buffers a graph made while a scope was open ([`Graph::begin_scope`]), which it can retire
/// together ([`Graph::retire_scope`]). [`Scope::NONE`] names nothing: it is what a graph that does not retire
/// anything returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Scope {
	index: u32,
	generation: u32,
}

impl Scope {
	/// The scope that names nothing; retiring it does nothing.
	pub const NONE: Scope = Scope {
		index: 0,
		generation: 0,
	};

	/// A scope with the given index (`0` is [`Scope::NONE`]) and generation `0`, for a graph that numbers its
	/// own scopes.
	pub const fn new(index: u32) -> Self {
		Self {
			index,
			generation: 0,
		}
	}

	/// A scope with the given index and generation. A graph that reuses scope numbers gives each use a new
	/// generation, so a handle kept past its scope's retirement names nothing once the number is used again.
	pub const fn with_generation(index: u32, generation: u32) -> Self {
		Self { index, generation }
	}

	/// The index a graph numbered the scope with.
	pub const fn index(self) -> u32 {
		self.index
	}

	/// The generation of the use of that index (`0` for a graph that does not reuse indices).
	pub const fn generation(self) -> u32 {
		self.generation
	}
}

/// The Web Audio calls the engine makes, as a trait. See the module documentation for the idea.
///
/// Methods that act on a node of one kind (`set_oscillator_type` on an oscillator, `start` on an oscillator or
/// a buffer source) panic in [`LogGraph`] when given another kind, since that is a mistake in the booking
/// code, not a state of the audio.
pub trait Graph {
	/// The context's sample rate in hertz (`ctx.sampleRate`).
	fn sample_rate(&self) -> f64;

	/// The context's clock in seconds (`ctx.currentTime`).
	fn current_time(&self) -> f64;

	/// The destination node (`ctx.destination`), node `0`.
	fn destination(&self) -> NodeId {
		NodeId(0)
	}

	/// The destination's channel count (`ctx.destination.channelCount`).
	fn destination_channels(&self) -> u32;

	/// The most channels the destination can have (`ctx.destination.maxChannelCount`).
	fn destination_max_channels(&self) -> u32;

	/// Creates a node, numbered after the nodes made before it.
	fn create_node(&mut self, kind: NodeKind) -> NodeId;

	/// The parameter `kind` of `node`.
	///
	/// # Panics
	///
	/// [`LogGraph`] panics if the node has no such parameter.
	fn param(&self, node: NodeId, kind: ParamKind) -> ParamId;

	/// Applies one automation call to a parameter.
	fn automate(&mut self, param: ParamId, call: Automation);

	/// `param.setValueAtTime(value, time)`.
	fn set_value_at_time(&mut self, param: ParamId, value: f64, time: f64) {
		self.automate(param, Automation::Set { value, time });
	}

	/// `param.linearRampToValueAtTime(value, time)`.
	fn linear_ramp_to_value_at_time(&mut self, param: ParamId, value: f64, time: f64) {
		self.automate(param, Automation::LinearRamp { value, time });
	}

	/// `param.exponentialRampToValueAtTime(value, time)`.
	fn exponential_ramp_to_value_at_time(&mut self, param: ParamId, value: f64, time: f64) {
		self.automate(param, Automation::ExponentialRamp { value, time });
	}

	/// `param.setTargetAtTime(value, time, timeConstant)`.
	fn set_target_at_time(&mut self, param: ParamId, value: f64, time: f64, time_constant: f64) {
		self.automate(
			param,
			Automation::Target {
				value,
				time,
				time_constant,
			},
		);
	}

	/// `param.cancelScheduledValues(time)`.
	fn cancel_scheduled_values(&mut self, param: ParamId, time: f64) {
		self.automate(param, Automation::Cancel { time });
	}

	/// `oscillator.type = type`.
	fn set_oscillator_type(&mut self, node: NodeId, kind: OscillatorType);

	/// `oscillator.setPeriodicWave(wave)`, which also makes the oscillator's type `"custom"`.
	fn set_periodic_wave(&mut self, node: NodeId, wave: WaveId);

	/// `filter.type = type`.
	fn set_filter_type(&mut self, node: NodeId, kind: FilterType);

	/// `bufferSource.buffer = buffer` or `convolver.buffer = buffer` (`None` for `null`). A convolver notes
	/// the time ([`Graph::current_time`]) the buffer was set at.
	fn set_buffer(&mut self, node: NodeId, buffer: Option<BufferId>);

	/// `bufferSource.loop = looping`.
	fn set_loop(&mut self, node: NodeId, looping: bool);

	/// `waveShaper.curve = curve`.
	fn set_curve(&mut self, node: NodeId, curve: Option<BufferId>);

	/// `waveShaper.oversample = oversample`.
	fn set_oversample(&mut self, node: NodeId, oversample: Oversample);

	/// `node.channelCount = count`.
	fn set_channel_count(&mut self, node: NodeId, count: u32);

	/// `node.channelCountMode = mode`.
	fn set_channel_count_mode(&mut self, node: NodeId, mode: ChannelCountMode);

	/// `node.channelInterpretation = interpretation`.
	fn set_channel_interpretation(&mut self, node: NodeId, interpretation: ChannelInterpretation);

	/// `from.connect(to, output, input)`.
	fn connect(&mut self, from: NodeId, to: Target, output: u32, input: u32);

	/// `from.connect(to)`: output `0` to input `0` of another node.
	fn connect_node(&mut self, from: NodeId, to: NodeId) {
		self.connect(from, Target::Node(to), 0, 0);
	}

	/// `node.disconnect()`.
	fn disconnect(&mut self, node: NodeId);

	/// `source.start(when)`, for an oscillator or a buffer source.
	fn start(&mut self, node: NodeId, when: f64);

	/// `source.stop(when)`, for an oscillator or a buffer source.
	fn stop(&mut self, node: NodeId, when: f64);

	/// `ctx.createBuffer(channels, length, sample_rate)`: a buffer of silence to fill with
	/// [`Graph::buffer_channel_mut`].
	fn create_buffer(&mut self, channels: u32, length: usize, sample_rate: f64) -> BufferId;

	/// The samples of one channel of an audio buffer (`buffer.getChannelData(channel)`).
	///
	/// # Panics
	///
	/// [`LogGraph`] panics if the buffer is a curve or the channel does not exist.
	fn buffer_channel_mut(&mut self, buffer: BufferId, channel: u32) -> &mut [f32];

	/// A `Float32Array` of samples to use as a wave-shaper curve.
	fn create_curve(&mut self, samples: &[f32]) -> BufferId;

	/// `ctx.createPeriodicWave(real, imag, { disableNormalization })`.
	fn create_periodic_wave(
		&mut self,
		real: &[f32],
		imag: &[f32],
		disable_normalization: bool,
	) -> WaveId;

	/// Starts a scope: the nodes and buffers made until the matching [`Graph::end_scope`] belong to it, so
	/// they can be retired together once a voice is over. Scopes nest; a node belongs to the innermost one.
	///
	/// Web Audio has nothing like this (a finished voice's nodes are garbage collected), so the default does
	/// nothing, and a graph that records or replays calls ([`LogGraph`], a bridge to a browser context) keeps
	/// everything. A graph that owns its nodes ([`RenderGraph`](crate::render_graph::RenderGraph)) uses it to
	/// give a finished voice's nodes and buffers back, so a long-running scheduler does not grow without bound.
	fn begin_scope(&mut self) {}

	/// Ends the innermost scope and names it, to retire later with [`Graph::retire_scope`].
	fn end_scope(&mut self) -> Scope {
		Scope::NONE
	}

	/// Starts a stretch of work whose nodes and buffers are shared (an orbit's reverb and delay, which outlive
	/// the voice that first needed them): whatever is made until [`Graph::end_shared`] belongs to no scope and
	/// is never retired.
	fn begin_shared(&mut self) {}

	/// Ends the stretch of shared work.
	fn end_shared(&mut self) {}

	/// Retires every node and buffer made in `scope`: they are disconnected, drop what they hold, and their
	/// numbers may be given to nodes and buffers made later. The engine retires a voice's scope only once the
	/// voice is over and never touches its nodes again; retiring [`Scope::NONE`], or a scope that was already
	/// retired, does nothing.
	fn retire_scope(&mut self, scope: Scope) {
		let _ = scope;
	}

	/// Retires one buffer the graph no longer needs (an impulse response a convolver has copied). Does
	/// nothing by default.
	fn retire_buffer(&mut self, buffer: BufferId) {
		let _ = buffer;
	}
}
