// The argument sweeps of the maths comparison: the same sets as `math_sweep.ts`, in the same order
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The sets are generated from integers by the same arithmetic in Rust and in `math_sweep.ts`, so
//! both sides evaluate the functions at identical doubles.

use std::f64::consts::PI;
use undertone_engine::math::Maths;
use undertone_engine::math::gains::{pan_law_gains, pan_law_scale, surround_gains};
use undertone_engine::math::waves::{
	LfoShape, ShapedWave, WaveTable, autopan_wave_table, shaped_wave_table,
};

fn table_values(table: &WaveTable, out: &mut Vec<f64>) {
	out.extend(table.real.iter().map(|x| f64::from(*x)));
	out.extend(table.imag.iter().map(|x| f64::from(*x)));
}

/// Every set, as `(name, values)`, evaluated with the back-end `M`.
pub fn sweep<M: Maths>() -> Vec<(&'static str, Vec<f64>)> {
	let mut sets: Vec<(&'static str, Vec<f64>)> = Vec::new();
	let wave_args: Vec<f64> = (1..=64)
		.flat_map(|k| (0..4096).map(move |n| (2.0 * PI * f64::from(k) * f64::from(n)) / 4096.0))
		.collect();
	sets.push(("sin.wave", wave_args.iter().map(|x| M::sin(*x)).collect()));
	sets.push(("cos.wave", wave_args.iter().map(|x| M::cos(*x)).collect()));
	let uniform: Vec<f64> = (-100_000..=100_000).map(|i| f64::from(i) * 0.001).collect();
	sets.push(("sin.uniform", uniform.iter().map(|x| M::sin(*x)).collect()));
	sets.push(("cos.uniform", uniform.iter().map(|x| M::cos(*x)).collect()));
	let pan_args: Vec<f64> = (-1000..=1000)
		.map(|i| ((f64::from(i) / 1000.0 + 1.0) * PI) / 4.0)
		.collect();
	sets.push(("sin.pan", pan_args.iter().map(|x| M::sin(*x)).collect()));
	sets.push(("cos.pan", pan_args.iter().map(|x| M::cos(*x)).collect()));
	let phase_args: Vec<f64> = (1..=64)
		.flat_map(|k| (0..1000).map(move |j| 2.0 * PI * f64::from(k) * (f64::from(j) / 1000.0)))
		.collect();
	sets.push(("sin.phase", phase_args.iter().map(|x| M::sin(*x)).collect()));
	sets.push(("cos.phase", phase_args.iter().map(|x| M::cos(*x)).collect()));
	sets.push((
		"sin.tri",
		(1..=64)
			.map(|k| M::sin((f64::from(k) * PI) / 2.0))
			.collect(),
	));
	sets.push((
		"acos.unit",
		(0..=10_000)
			.map(|i| M::acos(f64::from(i) / 10_000.0))
			.collect(),
	));
	sets.push((
		"exp.uniform",
		(-20_000..=20_000)
			.map(|i| M::exp(f64::from(i) / 1000.0))
			.collect(),
	));
	let decay_rate = -M::ln(0.001);
	sets.push((
		"exp.ir",
		(0..132_300)
			.map(|i| M::exp(-decay_rate * (f64::from(i) / 132_300.0)))
			.collect(),
	));
	sets.push((
		"ln.unit",
		(1..=10_000).map(|i| M::ln(f64::from(i) / 1000.0)).collect(),
	));
	sets.push((
		"pow.law",
		(0..=6000)
			.map(|i| M::pow(10.0, (-f64::from(i) / 1000.0) / 20.0))
			.collect(),
	));
	sets.push((
		"pow.db",
		(0..=12_000)
			.map(|i| M::pow(10.0, (-f64::from(i) / 100.0) / 20.0))
			.collect(),
	));
	sets.push((
		"pow.pitch",
		(0..=12_800)
			.map(|i| M::pow(2.0, (f64::from(i) / 100.0 - 69.0) / 12.0))
			.collect(),
	));
	sets.push((
		"pow.cents",
		(-6000..=6000)
			.map(|i| M::pow(2.0, (f64::from(i) / 10.0) / 1200.0))
			.collect(),
	));
	sets.push((
		"pow.square",
		(1..=64).map(|k| M::pow(PI * f64::from(k), 2.0)).collect(),
	));
	sets.push((
		"pow.sign",
		(1..=64).map(|k| M::pow(-1.0, f64::from(k))).collect(),
	));

	let mut shaped = Vec::new();
	for wave in [
		ShapedWave::HalfSine,
		ShapedWave::AbsSine,
		ShapedWave::PulseSine,
	] {
		table_values(&shaped_wave_table::<M>(wave), &mut shaped);
	}
	sets.push(("wave.shaped", shaped));
	let mut autopan = Vec::new();
	for lfo in [LfoShape::Sine, LfoShape::Triangle, LfoShape::Square] {
		for phase in [0.125, 0.25, 0.3, 0.5, 0.7] {
			table_values(&autopan_wave_table::<M>(lfo, phase), &mut autopan);
		}
	}
	sets.push(("wave.autopan", autopan));

	let mut pan_gains = Vec::new();
	for law in [-6.0, -4.5, -3.0, -1.0, 0.0] {
		for i in -100..=100 {
			let gains = pan_law_gains::<M>(f64::from(i) / 100.0, law);
			pan_gains.push(gains.left);
			pan_gains.push(gains.right);
		}
	}
	sets.push(("gain.pan", pan_gains));
	sets.push((
		"gain.scale",
		(0..=600)
			.map(|i| pan_law_scale::<M>(-f64::from(i) / 100.0))
			.collect(),
	));
	let mut surround = Vec::new();
	for i in -720..=720 {
		surround.extend(surround_gains::<M>(f64::from(i) * 0.5).expect("a finite angle"));
	}
	sets.push(("gain.surround", surround));
	sets
}
