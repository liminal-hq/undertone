// A Graph implemented outside the crate, which proves the handle types are constructible by implementors
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! An integration test is a separate crate, so this is what a renderer, a bridge, or a worklet sees: the
//! handles must be made and read through public items only.

use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::{
	Automation, BufferId, ChannelCountMode, ChannelInterpretation, FilterType, Graph, NodeId,
	NodeKind, OscillatorType, Oversample, ParamId, ParamKind, Target, WaveId,
};
use undertone_engine::params::VoiceParams;

/// Counts what the engine does and keeps nothing else.
#[derive(Default)]
struct Counting {
	nodes: u32,
	buffers: Vec<Vec<f32>>,
	waves: u32,
	automation: usize,
	connections: usize,
}

impl Graph for Counting {
	fn sample_rate(&self) -> f64 {
		44_100.0
	}
	fn current_time(&self) -> f64 {
		0.0
	}
	fn destination_channels(&self) -> u32 {
		2
	}
	fn destination_max_channels(&self) -> u32 {
		2
	}
	fn create_node(&mut self, _kind: NodeKind) -> NodeId {
		self.nodes += 1;
		NodeId::new(self.nodes)
	}
	fn param(&self, node: NodeId, kind: ParamKind) -> ParamId {
		ParamId::new(node, kind)
	}
	fn automate(&mut self, param: ParamId, _call: Automation) {
		assert!(param.node().index() <= self.nodes as usize);
		self.automation += 1;
	}
	fn set_oscillator_type(&mut self, _node: NodeId, _kind: OscillatorType) {}
	fn set_periodic_wave(&mut self, _node: NodeId, wave: WaveId) {
		assert!(wave.index() < self.waves as usize);
	}
	fn set_filter_type(&mut self, _node: NodeId, _kind: FilterType) {}
	fn set_buffer(&mut self, _node: NodeId, buffer: Option<BufferId>) {
		assert!(buffer.is_none_or(|b| b.index() < self.buffers.len()));
	}
	fn set_loop(&mut self, _node: NodeId, _looping: bool) {}
	fn set_curve(&mut self, _node: NodeId, _curve: Option<BufferId>) {}
	fn set_oversample(&mut self, _node: NodeId, _oversample: Oversample) {}
	fn set_channel_count(&mut self, _node: NodeId, _count: u32) {}
	fn set_channel_count_mode(&mut self, _node: NodeId, _mode: ChannelCountMode) {}
	fn set_channel_interpretation(&mut self, _node: NodeId, _i: ChannelInterpretation) {}
	fn connect(&mut self, _from: NodeId, _to: Target, _output: u32, _input: u32) {
		self.connections += 1;
	}
	fn disconnect(&mut self, _node: NodeId) {}
	fn start(&mut self, _node: NodeId, _when: f64) {}
	fn stop(&mut self, _node: NodeId, _when: f64) {}
	fn create_buffer(&mut self, channels: u32, length: usize, _rate: f64) -> BufferId {
		self.buffers.push(vec![0.0; length * channels as usize]);
		BufferId::new(self.buffers.len() as u32 - 1)
	}
	fn buffer_channel_mut(&mut self, buffer: BufferId, _channel: u32) -> &mut [f32] {
		&mut self.buffers[buffer.index()]
	}
	fn create_curve(&mut self, samples: &[f32]) -> BufferId {
		self.buffers.push(samples.to_vec());
		BufferId::new(self.buffers.len() as u32 - 1)
	}
	fn create_periodic_wave(&mut self, _re: &[f32], _im: &[f32], _no_norm: bool) -> WaveId {
		self.waves += 1;
		WaveId::new(self.waves - 1)
	}
}

#[test]
fn the_engine_books_a_voice_on_a_graph_implemented_outside_the_crate() {
	let mut engine = Engine::new(Counting::default(), OutputSetup::default()).unwrap();
	let voice = VoiceParams {
		room_level: Some(0.3),
		..VoiceParams::empty()
	};
	engine.play(&voice, 0.0).unwrap();
	let graph = engine.into_graph();
	assert!(graph.nodes >= 8 && graph.automation > 0 && graph.connections > 0);
	assert_eq!(graph.buffers.len(), 1);
}

#[test]
fn handles_read_back_what_they_were_made_from() {
	assert_eq!(NodeId::new(7).index(), 7);
	assert_eq!(NodeId::new(0), NodeId::new(0));
	let param = ParamId::new(NodeId::new(3), ParamKind::Pan);
	assert_eq!((param.node().index(), param.kind()), (3, ParamKind::Pan));
	assert_eq!(BufferId::new(2).index(), 2);
	assert_eq!(WaveId::new(1).index(), 1);
}
