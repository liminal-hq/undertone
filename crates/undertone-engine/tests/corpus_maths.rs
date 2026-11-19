// Checks the engine's maths against the gain and wave numbers recorded in the layer 3 placement cases
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The maths-only part of the layer 3 corpus runner: the pan-law gains, the pan-law path, the
//! autopan scale, and the autopan wave tables of `conformance/cases/3/placement.json`, computed
//! with each [`Maths`] back-end and compared at nine significant digits, the corpus's precision.
//! The graph itself (nodes, connections, envelopes) arrives with the engine's own runner.

use undertone_engine::math::gains::{
	PanEventKind, PanPoint, build_pan_path, pan_law_gains, pan_law_path, pan_law_scale,
};
use undertone_engine::math::waves::{LfoShape, WaveTable, autopan_wave_table};
use undertone_engine::math::{Maths, Native};

const PLACEMENT: &str = concat!(
	env!("CARGO_MANIFEST_DIR"),
	"/../../conformance/cases/3/placement.json"
);

/// A number rounded to nine significant digits, the way the recorder prints it.
fn nine(x: f64) -> f64 {
	format!("{x:.8e}").parse().expect("a rounded number parses")
}

/// A recorded number: `-0` is written `{"$num":"-0"}`, everything else as JavaScript prints it.
fn recorded(token: &str) -> f64 {
	let token = token.trim();
	if token.contains("-0\"") {
		-0.0
	} else {
		token.parse().unwrap_or_else(|_| panic!("number {token}"))
	}
}

fn same(a: f64, b: f64) -> bool {
	a.to_bits() == b.to_bits()
}

fn cases() -> Vec<(String, String)> {
	let text = std::fs::read_to_string(PLACEMENT).expect("the placement corpus file");
	text.split("\"id\": \"placement-")
		.skip(1)
		.map(|chunk| {
			let id = chunk.split('"').next().unwrap().to_string();
			(id, chunk.to_string())
		})
		.collect()
}

fn case(id: &str) -> String {
	cases()
		.into_iter()
		.find(|(name, _)| name == id)
		.unwrap_or_else(|| panic!("case {id}"))
		.1
}

/// The call strings of a gain node's `gain` param, for every gain node with its target list.
fn gain_nodes(chunk: &str) -> Vec<(String, Vec<String>, String)> {
	let mergers: Vec<String> = chunk
		.lines()
		.filter(|line| line.contains("\"kind\":\"merger\""))
		.map(|line| {
			line.split("\"id\":\"")
				.nth(1)
				.unwrap()
				.split('"')
				.next()
				.unwrap()
				.to_string()
		})
		.collect();
	let mut nodes = Vec::new();
	for line in chunk
		.lines()
		.filter(|line| line.contains("\"kind\":\"gain\""))
	{
		let Some(params) = line.split("\"gain\":[").nth(1) else {
			continue;
		};
		let calls: Vec<String> = params
			.split(']')
			.next()
			.unwrap()
			.split('"')
			.skip(1)
			.step_by(2)
			.map(String::from)
			.collect();
		let id = line
			.split("\"id\":\"")
			.nth(1)
			.unwrap()
			.split('"')
			.next()
			.unwrap()
			.to_string();
		let to = line
			.split("\"to\":[\"")
			.nth(1)
			.unwrap_or("")
			.split('"')
			.next()
			.unwrap_or("")
			.to_string();
		let side = if mergers.contains(&to) {
			"left"
		} else if mergers.iter().any(|m| to == format!("{m} out 0 in 1")) {
			"right"
		} else {
			"other"
		};
		nodes.push((id, calls, side.to_string()));
	}
	nodes
}

fn number_after(score: &str, key: &str) -> Option<f64> {
	let marker = format!("\\\"{key}\\\":");
	let rest = score.split(&marker).nth(1)?;
	rest.split([',', '}']).next()?.parse().ok()
}

fn call_value(call: &str) -> f64 {
	call.split_whitespace().nth(1).unwrap().parse().unwrap()
}

fn call_time(call: &str) -> f64 {
	call.split('@').nth(1).unwrap().parse().unwrap()
}

/// The pan-law gains of every voice that books them, in every placement case (28 numbers in the
/// pan-law cases and the 12-voice playground example).
fn pan_law_gains_match<M: Maths>() {
	let mut voices_checked = 0;
	for (id, chunk) in cases() {
		let scores: Vec<&str> = chunk
			.lines()
			.filter(|line| line.trim_start().starts_with("\"v") && line.contains(" @"))
			.collect();
		let expected: Vec<(f64, f64)> = scores
			.iter()
			.filter(|line| {
				!line.contains("channelGains")
					&& !line.contains("autopan")
					&& !line.contains("panPath")
					&& !line.contains("\\\"pan\\\":[")
			})
			.filter_map(|line| {
				let pan = number_after(line, "pan")?;
				let law = number_after(line, "panLaw")?;
				// The engine keeps the plain panner for a law of exactly -3 dB, and clamps to -6..0.
				(law != -3.0).then(|| {
					let gains = pan_law_gains::<M>(pan, law.clamp(-6.0, 0.0));
					(gains.left, gains.right)
				})
			})
			.collect();
		if expected.is_empty() || id.contains("path") {
			continue;
		}
		let nodes = gain_nodes(&chunk);
		let left: Vec<f64> = nodes
			.iter()
			.filter(|(_, calls, side)| side == "left" && calls.len() == 1)
			.map(|(_, calls, _)| call_value(&calls[0]))
			.collect();
		let right: Vec<f64> = nodes
			.iter()
			.filter(|(_, calls, side)| side == "right" && calls.len() == 1)
			.map(|(_, calls, _)| call_value(&calls[0]))
			.collect();
		assert_eq!(left.len(), expected.len(), "{id}: left gain nodes");
		assert_eq!(right.len(), expected.len(), "{id}: right gain nodes");
		for (index, (l, r)) in expected.iter().enumerate() {
			assert!(
				same(nine(*l), left[index]),
				"{id} voice {index}: left {} against {}",
				nine(*l),
				left[index]
			);
			assert!(
				same(nine(*r), right[index]),
				"{id} voice {index}: right {} against {}",
				nine(*r),
				right[index]
			);
			voices_checked += 1;
		}
	}
	assert_eq!(
		voices_checked, 14,
		"the corpus holds 14 voices with a law other than -3 dB"
	);
}

fn pan_law_path_matches<M: Maths>() {
	let chunk = case("pan-path-law");
	let path = build_pan_path(
		&[
			PanPoint {
				pan: -1.0,
				time: 0.0,
			},
			PanPoint {
				pan: 1.0,
				time: 0.4,
			},
		],
		0.0,
	);
	let (left, right) = pan_law_path::<M>(&path, -6.0);
	let nodes = gain_nodes(&chunk);
	for (side, events) in [("left", &left), ("right", &right)] {
		let (_, calls, _) = nodes
			.iter()
			.find(|(_, calls, s)| s == side && calls.len() > 1)
			.expect("a ramped side gain");
		assert_eq!(calls.len(), events.len(), "{side}: event count");
		for (call, event) in calls.iter().zip(events.iter()) {
			let kind = if call.starts_with("set") {
				PanEventKind::Set
			} else {
				PanEventKind::Ramp
			};
			assert_eq!(kind, event.kind, "{side}: {call}");
			assert!(
				same(nine(event.value), call_value(call)),
				"{side}: {call} against {}",
				nine(event.value)
			);
			assert!(
				same(nine(event.time), call_time(call)),
				"{side}: {call} time against {}",
				nine(event.time)
			);
		}
	}
}

fn autopan_scale_matches<M: Maths>() {
	let chunk = case("autopan-law");
	let (_, calls, _) = gain_nodes(&chunk)
		.into_iter()
		.find(|(id, ..)| id == "n6")
		.unwrap();
	assert!(same(nine(pan_law_scale::<M>(-6.0)), call_value(&calls[0])));
}

fn wave_of(chunk: &str, id: &str) -> (Vec<f64>, Vec<f64>) {
	let line = chunk
		.lines()
		.find(|line| line.contains(&format!("{{\"id\":\"{id}\",\"real\"")))
		.expect("a wave");
	let list = |key: &str| -> Vec<f64> {
		let rest = line.split(&format!("\"{key}\":[")).nth(1).unwrap();
		let body = rest
			.split("],\"")
			.next()
			.unwrap()
			.split("]}")
			.next()
			.unwrap();
		body.replace("{\"$num\":\"-0\"}", "-0")
			.split(',')
			.map(recorded)
			.collect()
	};
	(list("real"), list("imag"))
}

fn check_wave(id: &str, case_id: &str, table: &WaveTable, wave: &str) {
	let (real, imag) = wave_of(&case(case_id), wave);
	assert_eq!(real.len(), table.real.len(), "{id}: harmonics");
	for (k, (corpus, mine)) in real.iter().zip(&table.real).enumerate() {
		assert!(
			same(nine(f64::from(*mine)), *corpus),
			"{id}: real[{k}] {} against {corpus}",
			nine(f64::from(*mine))
		);
	}
	for (k, (corpus, mine)) in imag.iter().zip(&table.imag).enumerate() {
		assert!(
			same(nine(f64::from(*mine)), *corpus),
			"{id}: imag[{k}] {} against {corpus}",
			nine(f64::from(*mine))
		);
	}
}

fn autopan_waves_match<M: Maths>() {
	check_wave(
		"sine 0.25",
		"autopan-phase-sine",
		&autopan_wave_table::<M>(LfoShape::Sine, 0.25),
		"w0",
	);
	check_wave(
		"triangle 0.5",
		"autopan-phase-triangle",
		&autopan_wave_table::<M>(LfoShape::Triangle, 0.5),
		"w0",
	);
	check_wave(
		"square 0.3",
		"autopan-phase-square",
		&autopan_wave_table::<M>(LfoShape::Square, 0.3),
		"w0",
	);
	for wave in ["w0", "w1", "w2", "w3"] {
		check_wave(
			"sine 0.5",
			"example-autopan-shapes",
			&autopan_wave_table::<M>(LfoShape::Sine, 0.5),
			wave,
		);
	}
}

#[test]
fn native_pan_law_gains_equal_the_corpus() {
	pan_law_gains_match::<Native>();
}

#[test]
fn native_pan_law_path_equals_the_corpus() {
	pan_law_path_matches::<Native>();
}

#[test]
fn native_autopan_scale_equals_the_corpus() {
	autopan_scale_matches::<Native>();
}

#[test]
fn native_autopan_waves_equal_the_corpus() {
	autopan_waves_match::<Native>();
}

#[cfg(feature = "libm")]
mod soft {
	use super::*;
	use undertone_engine::math::Libm;

	#[test]
	fn libm_pan_law_gains_equal_the_corpus() {
		pan_law_gains_match::<Libm>();
	}

	#[test]
	fn libm_pan_law_path_equals_the_corpus() {
		pan_law_path_matches::<Libm>();
	}

	#[test]
	fn libm_autopan_scale_equals_the_corpus() {
		autopan_scale_matches::<Libm>();
	}

	#[test]
	fn libm_autopan_waves_equal_the_corpus() {
		autopan_waves_match::<Libm>();
	}
}
