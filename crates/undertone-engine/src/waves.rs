// Gives an oscillator its waveform: a native type, or a shaped wave through a periodic wave cached per graph
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Oscillator waveforms (`setOscillatorWave` and `getShapedWave` in `src/engine.ts` and `src/waves.ts`).
//!
//! A native type (`sine`, `triangle`, `square`, `sawtooth`) is set on the oscillator directly. A shaped wave
//! (`halfsine`, `abssine`, `pulsesine`) is a band-limited periodic wave whose coefficients come from
//! [`crate::math::waves::shaped_wave_table`], made once per graph and shared by every voice that uses it.

use crate::graph::{Graph, NodeId, OscillatorType, WaveId};
use crate::math::{Active, waves::ShapedWave, waves::WaveTable, waves::shaped_wave_table};
use crate::params::{FmWave, SoundType};
use std::sync::OnceLock;

/// What an oscillator plays: a built-in wave or a shaped one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waveform {
	/// A Web Audio built-in oscillator type.
	Native(OscillatorType),
	/// A shaped wave, played through a periodic wave.
	Shaped(ShapedWave),
}

impl Waveform {
	/// The waveform of a synth sound type, or `None` for a noise colour (which is a buffer, not an oscillator).
	pub fn from_sound_type(sound_type: SoundType) -> Option<Self> {
		Some(match sound_type {
			SoundType::Sine => Self::Native(OscillatorType::Sine),
			SoundType::Triangle => Self::Native(OscillatorType::Triangle),
			SoundType::Square => Self::Native(OscillatorType::Square),
			SoundType::Sawtooth => Self::Native(OscillatorType::Sawtooth),
			SoundType::Halfsine => Self::Shaped(ShapedWave::HalfSine),
			SoundType::Abssine => Self::Shaped(ShapedWave::AbsSine),
			SoundType::Pulsesine => Self::Shaped(ShapedWave::PulseSine),
			SoundType::White | SoundType::Pink | SoundType::Brown => return None,
		})
	}
}

impl From<FmWave> for Waveform {
	fn from(wave: FmWave) -> Self {
		match wave {
			FmWave::Sine => Self::Native(OscillatorType::Sine),
			FmWave::Triangle => Self::Native(OscillatorType::Triangle),
			FmWave::Square => Self::Native(OscillatorType::Square),
			FmWave::Sawtooth => Self::Native(OscillatorType::Sawtooth),
			FmWave::Halfsine => Self::Shaped(ShapedWave::HalfSine),
			FmWave::Abssine => Self::Shaped(ShapedWave::AbsSine),
			FmWave::Pulsesine => Self::Shaped(ShapedWave::PulseSine),
		}
	}
}

fn index(wave: ShapedWave) -> usize {
	match wave {
		ShapedWave::HalfSine => 0,
		ShapedWave::AbsSine => 1,
		ShapedWave::PulseSine => 2,
	}
}

/// The coefficients of a shaped wave, computed once for the process (they depend on no graph).
fn table(wave: ShapedWave) -> &'static WaveTable {
	static TABLES: [OnceLock<WaveTable>; 3] = [OnceLock::new(), OnceLock::new(), OnceLock::new()];
	TABLES[index(wave)].get_or_init(|| shaped_wave_table::<Active>(wave))
}

/// The periodic waves one graph holds for the shaped waveforms, each made when first asked for.
#[derive(Debug, Clone, Default)]
pub(crate) struct ShapedWaves {
	waves: [Option<WaveId>; 3],
}

impl ShapedWaves {
	/// Gives `oscillator` its waveform.
	pub(crate) fn apply<G: Graph>(
		&mut self,
		graph: &mut G,
		oscillator: NodeId,
		waveform: Waveform,
	) {
		match waveform {
			Waveform::Native(kind) => graph.set_oscillator_type(oscillator, kind),
			Waveform::Shaped(shape) => {
				let slot = index(shape);
				let wave = match self.waves[slot] {
					Some(wave) => wave,
					None => {
						let table = table(shape);
						let wave = graph.create_periodic_wave(&table.real, &table.imag, false);
						self.waves[slot] = Some(wave);
						wave
					}
				};
				graph.set_periodic_wave(oscillator, wave);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::graph::{LogGraph, NodeKind};

	#[test]
	fn a_shaped_wave_is_made_once_per_graph() {
		let mut graph = LogGraph::new(44_100.0, 2);
		let mut waves = ShapedWaves::default();
		for _ in 0..2 {
			let osc = graph.create_node(NodeKind::Oscillator);
			waves.apply(&mut graph, osc, Waveform::Shaped(ShapedWave::HalfSine));
		}
		let record = graph.finish(None);
		assert_eq!(record.waves.len(), 1);
	}

	#[test]
	fn noise_has_no_waveform() {
		assert_eq!(Waveform::from_sound_type(SoundType::Pink), None);
	}
}
