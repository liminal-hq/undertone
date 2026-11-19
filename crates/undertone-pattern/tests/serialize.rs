// Serialises pattern trees, rebuilds them on another thread, and checks every query and sample equal
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The off-main-thread check of RF-16 (formerly R11): can a tree with signals in it be queried somewhere other than where it was built?
//!
//! Each tree is serialised, the text is moved to a new thread (`std::thread`), the tree is rebuilt there, and both copies answer 1,000 queries of varied spans and 500 `sample_at` points. The haps and values are compared as their `Debug` text, which prints every `f64` exactly (and compares `NaN` as equal to itself), so a one-bit difference fails. The trees come from the corpus `signals` programs of layers 1 and 2, from every other corpus program as a lighter round trip, from hand-built trees that use every node a signal tree can hold, and from random programs.

mod common;

use common::interpret::{Failure, Pat, interpret};
use common::json::{self, Json};
use proptest::prelude::*;
use proptest::test_runner::TestRunner;
use std::sync::Arc;
use undertone_pattern::random::Seed;
use undertone_pattern::signal::{self, Shape, periodic};
use undertone_pattern::{
	Fraction, Hap, Pattern, Query, Span, Value, arrange, cat, control, pure, seq, silence, stack,
	timecat,
};

// --- The check ---------------------------------------------------------------------------------

/// How many windows the heavy tests ask of each tree: `clamp(PROPTEST_CASES / 10, 20, 1000)`, so the default of 10,000 cases (pushes to `main`) asks the full 1,000 and a pull request's `PROPTEST_CASES=1000` asks 100. The full numbers are the default; the variable only makes a run cheaper. The samples are half as many.
fn heavy_windows() -> usize {
	let cases: usize = std::env::var("PROPTEST_CASES")
		.ok()
		.and_then(|c| c.parse().ok())
		.unwrap_or(10_000);
	(cases / 10).clamp(20, 1000)
}

/// A small deterministic generator, so both threads ask the same questions and a failure repeats.
struct Lcg(u64);

impl Lcg {
	fn next(&mut self, bound: u64) -> u64 {
		self.0 = self
			.0
			.wrapping_mul(6_364_136_223_846_793_005)
			.wrapping_add(1_442_695_040_888_963_407);
		(self.0 >> 33) % bound
	}
}

/// `count` spans of varied begin, length, and denominator, from -6 cycles to 12, up to 5 cycles long.
fn windows(count: usize) -> Vec<Span> {
	let mut rng = Lcg(0x5eed);
	(0..count)
		.map(|_| {
			let d = 1 + rng.next(12) as i128;
			let begin = Fraction::new(rng.next(18 * d as u64) as i128 - 6 * d, d);
			let length = Fraction::new(1 + rng.next(5 * d as u64) as i128, d);
			Span::new(begin, begin + length)
		})
		.collect()
}

/// `count` instants, negative time included.
fn instants(count: usize) -> Vec<Fraction> {
	let mut rng = Lcg(0xfeed);
	(0..count)
		.map(|_| {
			let d = 1 + rng.next(16) as i128;
			Fraction::new(rng.next(20 * d as u64) as i128 - 8 * d, d)
		})
		.collect()
}

/// What a pattern answers to the questions: each window's haps and each instant's value, as exact text.
fn answers<T: undertone_pattern::Wire>(
	pattern: &Pattern<T>,
	spans: &[Span],
	points: &[Fraction],
) -> (Vec<String>, Vec<String>) {
	let mut out: Vec<Hap<T>> = Vec::new();
	let haps = spans
		.iter()
		.map(|span| {
			out.clear();
			pattern.query_into(*span, &mut out);
			// The plain query, then the checked one, errors included.
			format!("{out:?}\u{1}{:?}", pattern.try_query(*span))
		})
		.collect();
	let samples = points
		.iter()
		.map(|t| format!("{:?}", pattern.sample_at(*t)))
		.collect();
	(haps, samples)
}

/// What one tree gave: how many haps and samples were compared.
#[derive(Default, Clone, Copy)]
struct Compared {
	haps: usize,
	samples: usize,
}

/// Serialises `pattern`, rebuilds it on another thread, and compares the answers of both. Panics on any difference.
fn same_on_another_thread<T: undertone_pattern::Wire>(
	name: &str,
	pattern: &Pattern<T>,
	window_count: usize,
	sample_count: usize,
) -> Compared {
	let text = pattern
		.serialize()
		.unwrap_or_else(|e| panic!("{name}: {e}"));
	let (spans, points) = (windows(window_count), instants(sample_count));
	let there = {
		let (text, spans, points) = (text.clone(), spans.clone(), points.clone());
		std::thread::spawn(move || {
			let rebuilt = Pattern::<T>::deserialize(&text).expect("the text rebuilds");
			let hash = rebuilt.structural_hash();
			(answers(&rebuilt, &spans, &points), hash)
		})
		.join()
		.unwrap_or_else(|_| panic!("{name}: the other thread panicked"))
	};
	let (here, hash) = (answers(pattern, &spans, &points), pattern.structural_hash());
	assert_eq!(hash, there.1, "{name}: the rebuilt tree hashes differently");
	for (i, (a, b)) in here.0.iter().zip(&there.0.0).enumerate() {
		assert_eq!(a, b, "{name}: window {i} ({:?}) differs\n{text}", spans[i]);
	}
	for (i, (a, b)) in here.1.iter().zip(&there.0.1).enumerate() {
		assert_eq!(a, b, "{name}: sample at {} differs\n{text}", points[i]);
	}
	// Writing the rebuilt tree gives the same text, so the form is canonical.
	let again = Pattern::<T>::deserialize(&text)
		.unwrap()
		.serialize()
		.unwrap();
	assert_eq!(again, text, "{name}: the text is not canonical");
	Compared {
		haps: here
			.0
			.iter()
			.map(|w| {
				w.split('\u{1}')
					.next()
					.unwrap_or("")
					.matches("Hap {")
					.count()
			})
			.sum::<usize>(),
		samples: here.1.len(),
	}
}

// --- The corpus --------------------------------------------------------------------------------

fn corpus_files(layer: u32) -> Vec<(String, Json)> {
	let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
		.join(format!("../../conformance/cases/{layer}"));
	let mut paths: Vec<_> = std::fs::read_dir(dir)
		.expect("the corpus directory exists")
		.map(|e| e.unwrap().path())
		.filter(|p| p.extension().is_some_and(|x| x == "json"))
		.collect();
	paths.sort();
	paths
		.into_iter()
		.map(|p| {
			let group = p.file_stem().unwrap().to_string_lossy().into_owned();
			let text = std::fs::read_to_string(&p).unwrap();
			(group, json::parse(&text).expect("the corpus file is JSON"))
		})
		.collect()
}

/// Every corpus program of a group that builds a pattern, with its case id.
fn programs(file: &Json) -> Vec<(String, Pat)> {
	file.get("cases")
		.and_then(Json::as_arr)
		.unwrap()
		.iter()
		.filter_map(|case| {
			let id = case.get("id").and_then(Json::as_str)?.to_string();
			match interpret(case.get("program")?) {
				Ok(pattern) => Some((id, pattern)),
				Err(Failure::Error(_) | Failure::Uncovered(_)) => None,
			}
		})
		.collect()
}

#[test]
fn the_signals_corpus_programs_answer_the_same_on_another_thread() {
	let heavy = heavy_windows();
	let mut trees = 0;
	let mut refused = Vec::new();
	let mut total = Compared::default();
	for layer in [1, 2] {
		for (group, file) in corpus_files(layer) {
			if group != "signals" {
				continue;
			}
			for (id, pattern) in programs(&file) {
				match pattern.serialize() {
					Ok(_) => {
						let c = same_on_another_thread(&id, &pattern, heavy, heavy / 2);
						total.haps += c.haps;
						total.samples += c.samples;
						trees += 1;
					}
					Err(e) => {
						assert!(e.message().contains("Custom"), "{id}: {e}");
						refused.push(id);
					}
				}
			}
		}
	}
	println!(
		"signals corpus: {trees} trees rebuilt on another thread, {heavy} windows and {} samples each, {} haps and {} samples compared, none differed; {} refused (Custom): {refused:?}",
		heavy / 2,
		total.haps,
		total.samples,
		refused.len()
	);
	assert!(trees >= 100, "only {trees} trees were checked");
}

#[test]
fn every_corpus_program_round_trips() {
	// 20 windows and 500 samples by default (heavy / 50, 25 samples a window), 10 and 250 on a pull request.
	let light = (heavy_windows() / 50).max(10);
	println!(
		"round trip of the other corpus groups: {light} windows and {} samples each",
		light * 25
	);
	let mut trees = 0;
	let mut refused = 0;
	for layer in [1, 2] {
		for (group, file) in corpus_files(layer) {
			if group == "signals" {
				continue;
			}
			for (id, pattern) in programs(&file) {
				match pattern.serialize() {
					Ok(_) => {
						same_on_another_thread(
							&format!("{group}/{id}"),
							&pattern,
							light,
							light * 25,
						);
						trees += 1;
					}
					Err(e) => {
						assert!(e.message().contains("Custom"), "{group}/{id}: {e}");
						refused += 1;
					}
				}
			}
		}
	}
	println!("other corpus groups: {trees} trees round-tripped, {refused} refused (Custom)");
	assert!(trees > 100);
}

// --- Hand-built trees ---------------------------------------------------------------------------

fn sine() -> Pattern<f64> {
	periodic(Shape::Sine, false)
}

#[test]
fn every_signal_and_combinator_crosses() {
	let heavy = heavy_windows();
	let mut trees: Vec<(&str, Pattern<f64>)> = Vec::new();
	for name in [
		"sine", "cosine", "saw", "isaw", "tri", "square", "sine2", "cosine2", "saw2", "isaw2",
		"tri2", "square2", "rand", "rand2", "perlin", "brand",
	] {
		trees.push((name, signal::by_name(name).unwrap()));
	}
	trees.push(("irand", signal::irand(8.0).unwrap()));
	trees.push(("brandBy", signal::brand_by(0.3).unwrap()));
	trees.push(("choose", signal::choose(vec![1.0, 2.5, -7.0]).unwrap()));
	let seeded = signal::rand::<f64>().seed(Seed::Str("kick drum \u{1f941}".into()));
	trees.push(("seed string", seeded.unwrap()));
	trees.push((
		"seed number",
		signal::perlin::<f64>().seed(Seed::Num(1.5)).unwrap(),
	));
	trees.push(("segment", sine().segment(5.0).unwrap()));
	trees.push(("fractional segment", sine().segment(2.5).unwrap()));
	trees.push(("range", sine().range(200.0, 2000.0)));
	trees.push(("range2", periodic(Shape::Tri, true).range2(-1.0, 3.0)));
	trees.push(("rangex", sine().rangex(100.0, 8000.0).unwrap()));
	trees.push(("round", sine().range(0.0, 10.0).round()));
	trees.push(("floor", sine().range(-5.0, 5.0).floor()));
	trees.push(("add sub mul div numbers", {
		sine()
			.fmap(undertone_pattern::MapFn::Add(1.0))
			.range(0.0, 3.0)
	}));
	trees.push((
		"add two signals",
		sine().arith(undertone_pattern::ArithOp::Add, &signal::rand()),
	));
	trees.push((
		"sub",
		sine().arith(undertone_pattern::ArithOp::Sub, &signal::perlin()),
	));
	trees.push((
		"mul",
		sine().arith(undertone_pattern::ArithOp::Mul, &pure(3.0)),
	));
	trees.push((
		"div by zero",
		sine().arith(undertone_pattern::ArithOp::Div, &pure(0.0)),
	));
	trees.push(("fast slow", sine().fast(3.0).unwrap().slow(1.5).unwrap()));
	trees.push(("rev", sine().rev().segment(4.0).unwrap()));
	trees.push((
		"every",
		sine().every(3.0, |p| p.rev().fast(2.0).unwrap()).unwrap(),
	));
	trees.push(("euclid", sine().euclid(3.0, 8.0, 2.0).unwrap()));
	trees.push(("cat", cat(vec![sine(), pure(0.5), signal::rand()])));
	trees.push(("seq", seq(vec![sine(), silence(), signal::perlin().rev()])));
	trees.push((
		"stack",
		stack(vec![pure(0.25), sine(), periodic(Shape::Saw, false)]),
	));
	trees.push((
		"timecat",
		timecat(vec![
			(1.0, sine()),
			(2.0, pure(0.25)),
			(0.5, signal::rand()),
		])
		.unwrap(),
	));
	trees.push((
		"arrange",
		arrange(vec![(2.0, sine()), (1.0, pure(0.0)), (3.0, signal::rand())]).unwrap(),
	));
	trees.push((
		"deep",
		cat(vec![
			seq(vec![
				periodic(Shape::Saw, false)
					.range(0.0, 1.0)
					.segment(4.0)
					.unwrap(),
				pure(2.0),
			])
			.every(2.0, |p| p.rev())
			.unwrap(),
			stack(vec![sine().fast(2.0).unwrap(), signal::brand()]),
		])
		.fast(1.5)
		.unwrap(),
	));
	let mut compared = Compared::default();
	for (name, tree) in &trees {
		let c = same_on_another_thread(name, tree, heavy, heavy / 2);
		compared.haps += c.haps;
		compared.samples += c.samples;
	}
	println!(
		"{} hand-built f64 trees, {heavy} windows and {} samples each: {} haps and {} samples compared, none differed",
		trees.len(),
		heavy / 2,
		compared.haps,
		compared.samples
	);
}

#[test]
fn controls_and_voices_cross() {
	let heavy = heavy_windows();
	println!(
		"controls and voices: {heavy} windows and {} samples each",
		heavy / 2
	);
	let note = |s: &str| control::note(s).unwrap();
	let lfo = periodic::<Value>(Shape::Sine, false).range(200.0, 2000.0);
	let trees: Vec<(&str, Pattern<Value>)> = vec![
		("lpf with a signal", note("c3*4").lpf(&lfo).unwrap()),
		(
			"pan with a rand",
			note("c4*8")
				.pan(signal::rand::<Value>().range2(-1.0, 1.0))
				.unwrap(),
		),
		(
			"every on a control",
			note("c3 e3")
				.gain(0.5)
				.unwrap()
				.every(2.0, |p| p.rev())
				.unwrap(),
		),
		(
			"scale",
			control::n("0 2 4*2").unwrap().scale("C4:minor").unwrap(),
		),
		(
			"sound and bank",
			control::s("bd*2 sd").unwrap().bank("tr909"),
		),
		(
			"pan path",
			note("c4").pan_path(&[-1.0, 1.0, 0.0], None).unwrap(),
		),
		(
			"pitch steps",
			note("c4*2").pitch_steps(&[0.0, 7.0, 12.0], None).unwrap(),
		),
		("jux", note("c4*4").jux(|p| p.lpf(&lfo).unwrap()).unwrap()),
		(
			"choose into a control",
			note("c4*4")
				.pan(
					signal::choose(vec![Value::Num(-1.0), Value::Num(0.0), Value::Num(1.0)])
						.unwrap(),
				)
				.unwrap(),
		),
	];
	for (name, tree) in &trees {
		same_on_another_thread(name, tree, heavy, heavy / 2);
	}
	// Strings, maps, lists, and booleans as values.
	let rich = Value::Map(
		[
			("name".into(), Value::Str("a b:c".into())),
			(
				"flags".into(),
				Value::List(vec![Value::Bool(true), Value::Undefined]),
			),
		]
		.into(),
	);
	same_on_another_thread(
		"a map value",
		&cat(vec![pure(rich), pure(Value::Num(2.0))]),
		100,
		500,
	);
}

struct Clock;
impl Query<f64> for Clock {
	fn query(&self, span: Span, out: &mut Vec<Hap<f64>>) {
		out.push(Hap {
			whole: None,
			part: span,
			value: span.begin.to_f64(),
		});
	}
	fn sample(&self, t: Fraction) -> Option<f64> {
		Some(t.to_f64())
	}
	fn has_sampler(&self) -> bool {
		true
	}
}

#[test]
fn custom_and_foreign_leaves_are_refused_wherever_they_sit() {
	let custom = Pattern::custom(Arc::new(Clock));
	for tree in [
		custom.clone(),
		custom.fast(2.0).unwrap(),
		stack(vec![sine(), cat(vec![pure(1.0), custom.range(0.0, 1.0)])]),
		sine().fmap_with(|v: &f64| v * 2.0),
		sine()
			.euclid(3.0, 8.0, 0.0)
			.unwrap()
			.arith(undertone_pattern::ArithOp::Add, &custom),
	] {
		let e = tree.serialize().unwrap_err();
		assert!(e.message().contains("Custom"), "{e}");
		assert!(e.message().contains("cannot leave"), "{e}");
	}
	let table = Arc::new(undertone_pattern::ForeignTable::<f64>::new());
	let foreign = table.pattern(table.register(Arc::new(Clock)));
	let e = seq(vec![sine(), foreign]).serialize().unwrap_err();
	assert!(e.message().contains("Foreign"), "{e}");
	assert!(e.message().contains("host"), "{e}");
}

// --- Chords, voicing, and drift ----------------------------------------------------------------

/// How many windows of `pattern` fail when queried with `try_query`.
fn failing_windows(pattern: &Pattern<Value>, spans: &[Span]) -> usize {
	spans
		.iter()
		.filter(|span| pattern.try_query(**span).is_err())
		.count()
}

#[test]
fn the_chords_and_drift_corpus_programs_answer_the_same_on_another_thread() {
	let heavy = heavy_windows();
	let spans = windows(heavy);
	let (mut trees, mut errors, mut total) = (0, 0, Compared::default());
	let mut refused = Vec::new();
	for (group, file) in corpus_files(1) {
		if group != "chords" && group != "drift" && group != "notes" {
			continue;
		}
		for (id, pattern) in programs(&file) {
			match pattern.serialize() {
				Ok(_) => {
					errors += failing_windows(&pattern, &spans);
					let c = same_on_another_thread(
						&format!("{group}/{id}"),
						&pattern,
						heavy,
						heavy / 2,
					);
					total.haps += c.haps;
					total.samples += c.samples;
					trees += 1;
				}
				Err(e) => refused.push(format!("{group}/{id}: {e}")),
			}
		}
	}
	println!(
		"chords, drift, and notes corpus: {trees} trees rebuilt on another thread, {heavy} windows and {} samples each, {} haps and {} samples compared, {errors} windows answered with an error (compared too), none differed; {} refused",
		heavy / 2,
		total.haps,
		total.samples,
		refused.len()
	);
	assert!(refused.is_empty(), "{refused:?}");
	assert!(trees >= 150, "only {trees} trees were checked");
}

#[test]
fn voicing_and_drift_options_cross_exactly() {
	use undertone_pattern::chord::{Anchor, VoicingOptions, chord};
	use undertone_pattern::drift::{DriftOptions, drift};
	let spans = windows(200);
	let base = control::note("c3 e3*2 g3 ~").unwrap();
	let mut options = vec![DriftOptions::new(7.0), DriftOptions::new("song \u{1f941}")];
	let mut full = DriftOptions::new(-0.0);
	(
		full.timing,
		full.level,
		full.cents,
		full.pan,
		full.push,
		full.cycles_per_pass,
	) = (0.02, 0.1, 5.0, 0.25, -0.01, 2.0);
	options.push(full);
	let mut lone = DriftOptions::new("x");
	lone.seed_utf16 = Some(vec![0x61, 0xd800, 0x62]);
	lone.timing = 0.5;
	options.push(lone);
	let mut trees: Vec<(String, Pattern<Value>)> = Vec::new();
	for (i, o) in options.into_iter().enumerate() {
		trees.push((format!("drift {i}"), drift(&base, o).unwrap()));
	}
	for anchor in [
		None,
		Some(Anchor::Midi(48.5)),
		Some(Anchor::Name("c3".into())),
		Some(Anchor::Name("zz".into())),
	] {
		let name = format!("voicing {anchor:?}");
		let tree = chord("C Am7 <F G7>")
			.unwrap()
			.voicing(VoicingOptions { anchor });
		trees.push((name, tree));
	}
	let bad = trees.last().unwrap().1.clone();
	assert_eq!(
		failing_windows(&bad, &spans),
		spans.len(),
		"a bad anchor fails every query"
	);
	for (name, tree) in &trees {
		assert!(tree.can_fail(), "{name}");
		same_on_another_thread(name, tree, 200, 500);
		let rebuilt = Pattern::<Value>::deserialize(&tree.serialize().unwrap()).unwrap();
		assert_eq!(
			rebuilt.can_fail(),
			tree.can_fail(),
			"{name}: the fallible flag"
		);
	}
	// The lone surrogate is kept as units, not turned into a replacement character.
	let text = trees[3].1.serialize().unwrap();
	assert!(text.contains(" u 3 97 55296 98 "), "{text}");
}

// --- The property ------------------------------------------------------------------------------

const CASES: u32 = 10_000;

fn num(n: f64) -> Json {
	Json::Num(common::interpret_number_text(n), n)
}

fn text(s: &str) -> Json {
	Json::Str(s.to_string())
}

fn step(name: &str, args: Vec<Json>) -> Json {
	let mut items = vec![text(name)];
	items.extend(args);
	Json::Arr(items)
}

const BASES: [&str; 16] = [
	"sine", "cosine", "saw", "isaw", "tri", "square", "sine2", "saw2", "tri2", "square2", "rand",
	"rand2", "perlin", "brand", "irand", "choose",
];

fn base() -> BoxedStrategy<Vec<Json>> {
	prop_oneof![
		4 => (prop::sample::select(BASES.to_vec()), prop::option::of(0..=99), prop::bool::ANY).prop_map(
			|(name, seed, string_seed)| {
				let mut program = vec![match name {
					"irand" => step("irand", vec![num(6.0)]),
					"choose" => step("choose", vec![num(1.0), num(-2.5), num(7.0)]),
					other => step(other, vec![]),
				}];
				let random = !name.starts_with("sine")
					&& !name.starts_with("cosine")
					&& !name.starts_with("saw")
					&& !name.starts_with("isaw")
					&& !name.starts_with("tri")
					&& !name.starts_with("square");
				if let (Some(seed), true) = (seed, random) {
					program.push(step(
						"seed",
						vec![if string_seed {
							text(&format!("seed {seed}"))
						} else {
							num(f64::from(seed))
						}],
					));
				}
				program
			}
		),
		1 => (-4.0..4.0f64).prop_map(|n| vec![step("pure", vec![num((n * 4.0).round() / 4.0)])]),
		1 => Just(vec![step("silence", vec![])]),
		1 => prop::sample::select(vec!["c3 e3", "c3*2 [e3 g3]", "<c3 e3> g3", "c3 ~ e3"])
			.prop_map(|s| vec![step("mini", vec![text(s), text("number")])]),
	]
	.boxed()
}

fn shaping() -> BoxedStrategy<Json> {
	prop_oneof![
		(1..=5).prop_map(|n| step("fast", vec![num(f64::from(n) / 2.0)])),
		(1..=5).prop_map(|n| step("slow", vec![num(f64::from(n) / 2.0)])),
		Just(step("rev", vec![])),
		(1..=8).prop_map(|n| step("segment", vec![num(f64::from(n))])),
		(1..=4, 5..=9)
			.prop_map(|(a, b)| step("euclid", vec![num(f64::from(a)), num(f64::from(b))])),
		(-3..=3).prop_map(|n| step("add", vec![num(f64::from(n))])),
		(-3..=3).prop_map(|n| step("sub", vec![num(f64::from(n))])),
		(-3..=3).prop_map(|n| step("mul", vec![num(f64::from(n))])),
		(-3..=3).prop_map(|n| step("div", vec![num(f64::from(n))])),
		Just(step("round", vec![])),
		Just(step("floor", vec![])),
		Just(step("range", vec![num(10.0), num(20.0)])),
		Just(step("range2", vec![num(-2.0), num(2.0)])),
		Just(step("rangex", vec![num(100.0), num(1000.0)])),
		Just(step("add", vec![Json::Arr(vec![step("saw", vec![])])])),
		Just(step("mul", vec![Json::Arr(vec![step("perlin", vec![])])])),
		Just(step(
			"every",
			vec![num(2.0), Json::Arr(vec![step("rev", vec![])])]
		)),
		Just(step(
			"every",
			vec![num(3.0), Json::Arr(vec![step("add", vec![num(1.0)])])]
		)),
	]
	.boxed()
}

/// A program: a base (or a `seq`, `cat`, `stack`, `timecat`, `arrange` of programs) with a few shaping steps.
fn program(depth: u32) -> BoxedStrategy<Vec<Json>> {
	let leaf = (base(), prop::collection::vec(shaping(), 0..=4))
		.prop_map(|(mut p, shapes)| {
			p.extend(shapes);
			p
		})
		.boxed();
	if depth == 0 {
		return leaf;
	}
	let inner = program(depth - 1);
	prop_oneof![
		3 => leaf,
		2 => (
			prop::sample::select(vec!["seq", "cat", "stack"]),
			prop::collection::vec(inner.clone(), 1..=3),
			prop::collection::vec(shaping(), 0..=2),
		)
			.prop_map(|(name, children, shapes)| {
				let mut p = vec![step(name, children.into_iter().map(Json::Arr).collect())];
				p.extend(shapes);
				p
			}),
		1 => (inner.clone(), inner.clone()).prop_map(|(a, b)| {
			vec![step(
				"timecat",
				vec![Json::Arr(vec![
					Json::Arr(vec![num(1.0), Json::Arr(a)]),
					Json::Arr(vec![num(2.0), Json::Arr(b)]),
				])],
			)]
		}),
		1 => (inner.clone(), inner.clone()).prop_map(|(a, b)| {
			vec![step(
				"arrange",
				vec![
					Json::Arr(vec![num(1.0), Json::Arr(a)]),
					Json::Arr(vec![num(2.0), Json::Arr(b)]),
				],
			)]
		}),
		1 => (prop::sample::select(vec!["c3 e3", "c3*4", "c3 e3 g3"]), inner).prop_map(|(notes, p)| {
			vec![
				step("note", vec![text(notes)]),
				step("lpf", vec![Json::Arr(p)]),
				step("pan", vec![Json::Arr(vec![step("sine2", vec![])])]),
			]
		}),
	]
	.boxed()
}

/// Round-trip property: a program that serialises rebuilds to a tree that hashes, writes, queries, and samples the same.
#[test]
fn a_rebuilt_tree_is_the_same_tree() {
	let cases = std::env::var("PROPTEST_CASES")
		.ok()
		.and_then(|c| c.parse().ok())
		.unwrap_or(CASES);
	let config = ProptestConfig {
		cases,
		max_global_rejects: 1_000_000,
		failure_persistence: None,
		..ProptestConfig::default()
	};
	let mut runner = TestRunner::new(config);
	let (built, skipped) = (std::cell::Cell::new(0u32), std::cell::Cell::new(0u32));
	let (spans, points) = (windows(8), instants(40));
	let result = runner.run(&program(2), |steps| {
		let Ok(pattern) = interpret(&Json::Arr(steps)) else {
			skipped.set(skipped.get() + 1);
			return Ok(());
		};
		built.set(built.get() + 1);
		let text = pattern
			.serialize()
			.expect("a corpus-language program has no closures");
		let rebuilt = Pattern::<Value>::deserialize(&text).expect("the text rebuilds");
		prop_assert_eq!(rebuilt.structural_hash(), pattern.structural_hash());
		prop_assert_eq!(rebuilt.serialize().unwrap(), text);
		prop_assert_eq!(
			answers(&rebuilt, &spans, &points),
			answers(&pattern, &spans, &points)
		);
		Ok(())
	});
	if let Err(failure) = result {
		panic!("failed after {} programs\n{failure}", built.get());
	}
	println!(
		"round trip: {} programs rebuilt and compared, {} did not build (an error the reference also throws)",
		built.get(),
		skipped.get()
	);
	assert!(built.get() > cases / 2, "too few programs built");
}
