// Prints how long Pattern::query takes on typical trees, for profiling (never a CI gate)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A microbenchmark with no dependencies: `cargo run --release -p undertone-pattern --example query_timings`.
//!
//! Each row queries one tree over cycles 0 to 4, many times, and prints the time per query and per hap. The figures are for comparing one build with another on one machine, not a pass mark.

use std::hint::black_box;
use std::time::Instant;
use undertone_pattern::{Fraction, Pattern, Span, cat, mini, pure, seq, stack};

fn bench(label: &str, pattern: &Pattern<f64>, from: Fraction, to: Fraction) {
	let span = Span::new(from, to);
	let haps = pattern.query(span).len();
	let runs = 2000;
	for _ in 0..200 {
		black_box(pattern.query(black_box(span)));
	}
	let start = Instant::now();
	for _ in 0..runs {
		black_box(pattern.query(black_box(span)));
	}
	let each = start.elapsed().as_secs_f64() / f64::from(runs);
	println!(
		"{label:<34} {haps:>5} haps   {:>9.2} us a query   {:>7.1} ns a hap",
		each * 1e6,
		each * 1e9 / haps.max(1) as f64
	);
}

/// Times one closure over many runs, in nanoseconds a call.
fn ns(label: &str, mut f: impl FnMut() -> Fraction) {
	for _ in 0..10_000 {
		black_box(f());
	}
	let runs = 2_000_000;
	let start = Instant::now();
	for _ in 0..runs {
		black_box(f());
	}
	println!(
		"  {label:<30} {:>7.1} ns",
		start.elapsed().as_secs_f64() * 1e9 / f64::from(runs)
	);
}

/// The cost of the fraction operations a query is made of, so a profile can say where a hap's time goes.
fn primitives() {
	println!("fraction primitives (small values):");
	let (a, b) = (
		black_box(Fraction::new(5, 12)),
		black_box(Fraction::new(7, 8)),
	);
	let (i, j) = (
		black_box(Fraction::from_int(3)),
		black_box(Fraction::from_int(4)),
	);
	ns("Fraction::new(n, d)", || {
		Fraction::new(black_box(18), black_box(24))
	});
	ns("integer + integer", || i + j);
	ns("fraction + fraction", || a + b);
	ns("fraction * fraction", || a * b);
	ns("fraction / fraction", || a / b);
	ns("integer * fraction", || i * b);
	ns("min of two", || a.min(b));
	ns("sam of a fraction", || black_box(a).sam());
	let mut x = 0;
	let t = Instant::now();
	for k in 0..2_000_000 {
		x += usize::from(black_box(a) < black_box(Fraction::new(k % 7, 8)));
	}
	println!(
		"  compare (incl. new)            {:>7.1} ns   ({x})",
		t.elapsed().as_secs_f64() * 1e9 / 2e6
	);
}

fn main() {
	let whole = |a: i128, b: i128| (Fraction::from_int(a), Fraction::from_int(b));
	let (a, b) = whole(0, 1);
	let (c, d) = whole(0, 4);
	let thirds = (Fraction::new(1, 3), Fraction::new(7, 4));
	let steps = |n: usize| seq((0..n).map(|i| pure(i as f64)).collect());

	println!(
		"build: {}",
		if cfg!(debug_assertions) {
			"debug"
		} else {
			"release"
		}
	);
	primitives();
	println!("queries:");
	bench("pure, 4 cycles", &pure(1.0), c, d);
	bench("seq of 32, 1 cycle", &steps(32), a, b);
	bench("seq of 32, 4 cycles", &steps(32), c, d);
	bench("seq of 32, 1/3 to 7/4", &steps(32), thirds.0, thirds.1);
	bench(
		"seq of 32 fast 2, 1 cycle",
		&steps(32).fast(2.0).unwrap(),
		a,
		b,
	);
	bench("seq of 32 rev, 1 cycle", &steps(32).rev(), a, b);
	bench(
		"seq of 7 slow 3, 4 cycles",
		&steps(7).slow(3.0).unwrap(),
		c,
		d,
	);
	bench(
		"cat of 4 seqs of 8, 4 cycles",
		&cat((0..4).map(|_| steps(8)).collect()),
		c,
		d,
	);
	bench(
		"stack of 4 seqs of 8, 1 cycle",
		&stack((0..4).map(|_| steps(8)).collect()),
		a,
		b,
	);
	bench(
		"euclid 5 8 on seq of 4, 4 cycles",
		&steps(4).euclid(5.0, 8.0, 0.0).unwrap(),
		c,
		d,
	);
	bench(
		"every 2 rev of 16, 4 cycles",
		&steps(16).every(2.0, |p| p.rev()).unwrap(),
		c,
		d,
	);
	let nested = mini::parse("a*2 [b c]@3 <d e f>(3,8) [g h]!2 i", |w| Ok(w.len() as f64)).unwrap();
	bench("mini: a*2 [b c]@3 <..>(3,8) ...", &nested, c, d);
	let chain = steps(16)
		.fast(2.0)
		.unwrap()
		.rev()
		.slow(2.0)
		.unwrap()
		.every(3.0, |p| p.fast(2.0).unwrap())
		.unwrap();
	bench("chain fast rev slow every, 4 cycles", &chain, c, d);
}
