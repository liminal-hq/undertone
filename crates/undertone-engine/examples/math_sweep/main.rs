// Dumps and compares the engine's maths over dense sweeps, for the R9 maths-determinism spike
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `math_sweep dump <native|libm> <file>` writes every sweep value, one per line; `math_sweep
//! compare <reference> <other>` prints, per set, the largest absolute and relative differences,
//! the RMS difference, and how many values differ at nine significant digits. The reference file
//! can come from `math_sweep.ts` (JavaScriptCore, run by bun) or from another dump.

mod sets;

use sets::sweep;
use std::fmt::Write as _;
use undertone_engine::math::Native;

fn nine(x: f64) -> f64 {
	format!("{x:.8e}").parse().expect("a rounded number parses")
}

fn read(path: &str) -> Vec<f64> {
	std::fs::read_to_string(path)
		.unwrap_or_else(|e| panic!("{path}: {e}"))
		.lines()
		.map(|line| {
			line.parse()
				.unwrap_or_else(|_| panic!("{path}: number {line}"))
		})
		.collect()
}

fn main() {
	let args: Vec<String> = std::env::args().collect();
	match args.get(1).map(String::as_str) {
		Some("dump") => {
			let values: Vec<(&'static str, Vec<f64>)> = match args[2].as_str() {
				"native" => sweep::<Native>(),
				#[cfg(feature = "libm")]
				"libm" => sweep::<undertone_engine::math::Libm>(),
				other => panic!("unknown back-end {other} (libm needs --features libm)"),
			};
			let mut text = String::new();
			for (_, set) in &values {
				for x in set {
					writeln!(text, "{x}").unwrap();
				}
			}
			std::fs::write(&args[3], text).expect("write the dump");
		}
		Some("compare") => compare(&read(&args[2]), &read(&args[3])),
		_ => eprintln!("usage: math_sweep dump <native|libm> <file> | compare <a> <b>"),
	}
}

fn compare(a: &[f64], b: &[f64]) {
	let layout = sweep::<Native>();
	let total: usize = layout.iter().map(|(_, s)| s.len()).sum();
	assert_eq!(a.len(), total, "first file length");
	assert_eq!(b.len(), total, "second file length");
	println!("| set | values | max abs | max rel | RMS | differ at 9 digits | bit-different |");
	println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
	let mut at = 0;
	for (name, set) in &layout {
		let (x, y) = (&a[at..at + set.len()], &b[at..at + set.len()]);
		at += set.len();
		let (mut max_abs, mut max_rel, mut squares, mut nines, mut bits) =
			(0.0_f64, 0.0_f64, 0.0, 0, 0);
		for (p, q) in x.iter().zip(y) {
			let diff = (p - q).abs();
			if p.to_bits() != q.to_bits() {
				bits += 1;
			}
			if nine(*p).to_bits() != nine(*q).to_bits() {
				nines += 1;
			}
			max_abs = max_abs.max(diff);
			let scale = p.abs().max(q.abs());
			if scale > 0.0 {
				max_rel = max_rel.max(diff / scale);
			}
			squares += diff * diff;
		}
		let rms = (squares / set.len() as f64).sqrt();
		println!(
			"| {name} | {} | {max_abs:.3e} | {max_rel:.3e} | {rms:.3e} | {nines} | {bits} |",
			set.len()
		);
	}
}
