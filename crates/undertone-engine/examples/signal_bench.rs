// Times signal-driven controls over a thousand scheduler windows, as src/signal.bench.ts does (never a CI gate)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The Rust twin of `src/signal.bench.ts`: `cargo run --release -p undertone-engine --example signal_bench`.
//!
//! Each row runs `s("hh*16")` with its controls through 1,000 scheduler windows of a twentieth of a cycle (100 ms at 120 bpm, 2 s cycles), the way a loop tick does: query the window, keep the onsets, give each its gate length, and resolve it to `VoiceParams`. The first table is that whole tick; the second is the query and the onset filter alone, which is the part the pattern crate owns. No benchmark dependency, and no pass mark: compare it with the TypeScript's figure from the same machine (see `docs/rust-migration/results/RF-16.md`).

use std::hint::black_box;
use std::time::Instant;
use undertone_engine::params::resolve_params;
use undertone_pattern::signal::{Shape, periodic};
use undertone_pattern::{Fraction, Pattern, Span, Value, control};

const WINDOWS: i128 = 1000;
const RUNS: u32 = 200;

/// What one loop tick does with a window, up to the voice it would book.
fn tick(pattern: &Pattern<Value>, span: Span, resolve: bool) -> usize {
	let mut voices = 0;
	for hap in pattern.query(span) {
		let Some(whole) = hap.whole else { continue };
		if whole.begin != hap.part.begin {
			continue;
		}
		if resolve {
			let seconds = (whole.end - whole.begin).to_f64() * 2.0;
			let mut patch = hap.value;
			if let Value::Map(map) = &mut patch {
				map.entry("duration".into()).or_insert(Value::Num(seconds));
			}
			black_box(resolve_params(&patch));
		}
		voices += 1;
	}
	voices
}

fn run(pattern: &Pattern<Value>, resolve: bool) -> usize {
	let window = Fraction::new(1, 20);
	let mut voices = 0;
	for i in 0..WINDOWS {
		let begin = window * Fraction::from_int(i);
		voices += tick(pattern, Span::new(begin, begin + window), resolve);
	}
	voices
}

fn row(label: &str, pattern: &Pattern<Value>) {
	let mut line = format!("{label:<42}");
	for resolve in [true, false] {
		for _ in 0..10 {
			black_box(run(pattern, resolve));
		}
		let mut times = Vec::new();
		let mut voices = 0;
		for _ in 0..RUNS {
			let start = Instant::now();
			voices = black_box(run(black_box(pattern), resolve));
			times.push(start.elapsed().as_secs_f64() * 1e3);
		}
		let mean = times.iter().sum::<f64>() / f64::from(RUNS);
		let min = times.iter().copied().fold(f64::INFINITY, f64::min);
		line.push_str(&format!("  {mean:>7.3} ms mean {min:>7.3} ms min"));
		if !resolve {
			line.push_str(&format!("  ({voices} voices)"));
		}
	}
	println!("{line}");
}

fn main() {
	let hh = || control::s("hh*16").expect("a sound pattern");
	let plain = hh();
	let numbers = hh().pan(0.2).unwrap().lpf(1600).unwrap().gain(0.4).unwrap();
	let strings = hh()
		.pan("-1 -.5 0 .5 1 .5 0 -.5")
		.unwrap()
		.lpf("800 1600 3200 1600")
		.unwrap()
		.gain(".5 .3")
		.unwrap();
	let sine2 = periodic::<Value>(Shape::Sine, true);
	let signals = hh()
		.pan(sine2.slow(4.0).unwrap())
		.unwrap()
		.lpf(undertone_pattern::signal::perlin::<Value>().range(800.0, 3200.0))
		.unwrap()
		.gain(undertone_pattern::signal::rand::<Value>().range(0.3, 0.5))
		.unwrap();
	println!(
		"hh*16 over {WINDOWS} scheduler windows, {RUNS} runs each; columns: the whole tick (query, onsets, resolve), then query and onsets only"
	);
	row("no controls", &plain);
	row("three number controls", &numbers);
	row("three string controls", &strings);
	row("three signal controls (pan, lpf, gain)", &signals);
}
