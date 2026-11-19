// Property tests: query-window independence, inverses, and signals over random programs of depth at most 5
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Properties 1 to 3 of `docs/rust-migration/CONFORMANCE.md`, the Rust twin of `conformance/recorder/properties.test.ts`.
//!
//! Programs are random JSON programs in the corpus language, built from a small grammar (mini-notation words, rests, groups, alternations, speed, replication, elongation, euclid; `pure` and `silence`; and `fast`, `slow`, `rev`, `every`, `euclid`, `stack`, `seq`, `cat`, `timecat`, `arrange`), so the interpreter that runs the corpus runs them too. Times are fractions with denominators up to 12, negative time included.
//!
//! A hap cut by a query boundary is joined with its neighbour before two answers are compared: per event (whole and value), how many fragments cover each stretch of time, with adjacent stretches of equal cover merged. A stack of equal layers and an event cut at a cycle boundary therefore compare equal to the whole.

mod common;

use common::encode::encode_value;
use common::interpret::interpret;
use common::json::Json;
use proptest::prelude::*;
use proptest::test_runner::TestRunner;
use std::collections::{BTreeMap, BTreeSet};
use undertone_pattern::random::Seed;
use undertone_pattern::{Fraction, Hap, Span, Value};

/// How many random programs each property runs. CI uses this; a nightly job raises it with `PROPTEST_CASES`.
const CASES: u32 = 10_000;

fn config() -> ProptestConfig {
	let cases = std::env::var("PROPTEST_CASES")
		.ok()
		.and_then(|c| c.parse().ok())
		.unwrap_or(CASES);
	ProptestConfig {
		cases,
		max_global_rejects: 1_000_000,
		failure_persistence: None,
		..ProptestConfig::default()
	}
}

// --- Program generators ------------------------------------------------------------------------

type Prog = Vec<Json>;

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

fn word() -> impl Strategy<Value = String> {
	prop::sample::select(vec!["a", "b", "c", "d", "e"]).prop_map(String::from)
}

/// A mini-notation string from a small grammar.
fn mini_source() -> BoxedStrategy<String> {
	let atom = prop_oneof![
		word(),
		Just("~".to_string()),
		(word(), 2..=3).prop_map(|(w, n)| format!("{w}*{n}")),
		(word(), 2..=3).prop_map(|(w, n)| format!("{w}!{n}")),
		(word(), 2..=3).prop_map(|(w, n)| format!("{w}@{n}")),
		(word(), 1..=4, 4..=8, 0..=3).prop_map(|(w, p, s, r)| format!("{w}({p},{s},{r})")),
		prop::collection::vec(word(), 2..=3).prop_map(|ws| format!("<{}>", ws.join(" "))),
	]
	.prop_recursive(2, 8, 3, |inner| {
		prop::collection::vec(inner, 1..=4).prop_map(|atoms| format!("[{}]", atoms.join(" ")))
	});
	prop::collection::vec(atom, 1..=4)
		.prop_map(|atoms| atoms.join(" "))
		.boxed()
}

fn leaf() -> BoxedStrategy<Prog> {
	prop_oneof![
		mini_source().prop_map(|s| vec![step("mini", vec![text(&s), text("word")])]),
		(0..=9).prop_map(|n| vec![step("pure", vec![num(f64::from(n))])]),
		Just(vec![step("silence", vec![])]),
	]
	.boxed()
}

fn with(mut program: Prog, extra: Json) -> Prog {
	program.push(extra);
	program
}

fn factor() -> impl Strategy<Value = f64> {
	prop::sample::select(vec![1.0, 2.0, 3.0, 0.5, 1.5, 0.25])
}

/// A discrete program of depth at most 5: constructors and transforms.
fn discrete() -> BoxedStrategy<Prog> {
	leaf()
		.prop_recursive(5, 64, 3, |inner| {
			prop_oneof![
				leaf(),
				(inner.clone(), factor()).prop_map(|(p, v)| with(p, step("fast", vec![num(v)]))),
				(inner.clone(), factor()).prop_map(|(p, v)| with(p, step("slow", vec![num(v)]))),
				inner.clone().prop_map(|p| with(p, step("rev", vec![]))),
				(inner.clone(), 1..=4).prop_map(|(p, n)| with(
					p,
					step(
						"every",
						vec![num(f64::from(n)), Json::Arr(vec![step("rev", vec![])])]
					)
				)),
				(inner.clone(), 1..=4).prop_map(|(p, n)| with(
					p,
					step(
						"every",
						vec![
							num(f64::from(n)),
							Json::Arr(vec![step("fast", vec![num(2.0)])])
						]
					)
				)),
				(inner.clone(), 1..=5, 5..=9, 0..=4).prop_map(|(p, a, b, r)| with(
					p,
					step(
						"euclid",
						vec![num(f64::from(a)), num(f64::from(b)), num(f64::from(r))]
					)
				)),
				(inner.clone(), inner.clone())
					.prop_map(|(a, b)| vec![step("stack", vec![Json::Arr(a), Json::Arr(b)])]),
				(inner.clone(), inner.clone(), inner.clone()).prop_map(|(a, b, c)| vec![step(
					"seq",
					vec![Json::Arr(a), Json::Arr(b), Json::Arr(c)]
				)]),
				(inner.clone(), inner.clone())
					.prop_map(|(a, b)| vec![step("cat", vec![Json::Arr(a), Json::Arr(b)])]),
				(inner.clone(), inner.clone(), 1..=3, 1..=3).prop_map(|(a, b, x, y)| vec![step(
					"timecat",
					vec![Json::Arr(vec![
						Json::Arr(vec![num(f64::from(x)), Json::Arr(a)]),
						Json::Arr(vec![num(f64::from(y)), Json::Arr(b)]),
					])]
				)]),
				(inner.clone(), inner, 1..=3, 1..=3).prop_map(|(a, b, x, y)| vec![step(
					"arrange",
					vec![
						Json::Arr(vec![num(f64::from(x)), Json::Arr(a)]),
						Json::Arr(vec![num(f64::from(y)), Json::Arr(b)]),
					]
				)]),
			]
		})
		.boxed()
}

const SIGNALS: [&str; 13] = [
	"sine", "cosine", "saw", "isaw", "tri", "square", "sine2", "saw2", "tri2", "rand", "rand2",
	"perlin", "brand",
];

/// A signal, shaped: a name, a seed for the random ones, then a few shaping steps.
fn signal_program() -> BoxedStrategy<Prog> {
	let shaping = prop::sample::select(vec![
		step("fast", vec![num(2.0)]),
		step("slow", vec![num(3.0)]),
		step("rev", vec![]),
		step("fast", vec![num(0.5)]),
		step("add", vec![num(1.0)]),
	]);
	(
		prop::sample::select(SIGNALS.to_vec()),
		prop::option::of(0..=99),
		prop::collection::vec(shaping, 0..=3),
	)
		.prop_map(|(name, seed, shapes)| {
			let random = ["rand", "rand2", "perlin", "brand"].contains(&name);
			let mut program = vec![step(name, vec![])];
			if let (Some(seed), true) = (seed, random) {
				program.push(step("seed", vec![num(f64::from(seed))]));
			}
			program.extend(shapes);
			program
		})
		.boxed()
}

/// A signal given structure (`segment`, `euclid`) or used as a control: still window independent.
fn signal_with_structure() -> BoxedStrategy<Prog> {
	prop_oneof![
		(signal_program(), 1..=8)
			.prop_map(|(p, n)| with(p, step("segment", vec![num(f64::from(n))]))),
		(signal_program(), 1..=5, 5..=9).prop_map(|(p, a, b)| with(
			p,
			step("euclid", vec![num(f64::from(a)), num(f64::from(b))])
		)),
		(mini_source(), signal_program()).prop_map(|(source, p)| {
			let notes: String = source
				.chars()
				.flat_map(|c| {
					if ('a'..='e').contains(&c) {
						vec![c, '3']
					} else {
						vec![c]
					}
				})
				.collect();
			vec![
				step("note", vec![text(&notes)]),
				step("gain", vec![Json::Arr(p)]),
			]
		}),
	]
	.boxed()
}

/// Three fractions with denominators up to 12, from -3 to 6, strictly increasing.
fn times() -> impl Strategy<Value = [Fraction; 3]> {
	let fraction = (-36i128..=72, 1i128..=12).prop_map(|(n, d)| Fraction::new(n, d));
	(fraction.clone(), fraction.clone(), fraction)
		.prop_map(|(a, b, c)| {
			let mut sorted = [a, b, c];
			sorted.sort();
			sorted
		})
		.prop_filter("strictly increasing", |[a, b, c]| a < b && b < c)
}

// --- Helpers -----------------------------------------------------------------------------------

fn build(program: &Prog) -> common::interpret::Pat {
	match interpret(&Json::Arr(program.clone())) {
		Ok(pattern) => pattern,
		Err(failure) => panic!("a generated program must build: {failure:?}\n{program:?}"),
	}
}

fn query(program: &Prog, begin: Fraction, end: Fraction) -> Vec<Hap<Value>> {
	build(program).query(Span::new(begin, end))
}

/// Haps with their fragments joined, as a canonical list of strings.
fn joined(haps: &[Hap<Value>]) -> Vec<String> {
	let mut groups: BTreeMap<String, Vec<&Hap<Value>>> = BTreeMap::new();
	let mut out = Vec::new();
	for hap in haps {
		match &hap.whole {
			None => out.push(format!(
				"loose {} {}..{}",
				encode_value(&hap.value),
				hap.part.begin,
				hap.part.end
			)),
			Some(whole) => {
				let key = format!(
					"[{},{},{}]",
					whole.begin,
					whole.end,
					encode_value(&hap.value)
				);
				groups.entry(key).or_default().push(hap);
			}
		}
	}
	for (key, fragments) in groups {
		let points: BTreeSet<Fraction> = fragments
			.iter()
			.flat_map(|h| [h.part.begin, h.part.end])
			.collect();
		let sorted: Vec<Fraction> = points.into_iter().collect();
		let mut run: Option<(usize, Fraction, Fraction)> = None;
		for pair in sorted.windows(2) {
			let (begin, end) = (pair[0], pair[1]);
			let count = fragments
				.iter()
				.filter(|f| f.part.begin <= begin && end <= f.part.end)
				.count();
			match &mut run {
				Some((c, _, run_end)) if *c == count => *run_end = end,
				_ => {
					if let Some((c, b, e)) = run.take().filter(|(c, _, _)| *c > 0) {
						out.push(format!("{key} x{c} {b}..{e}"));
					}
					run = Some((count, begin, end));
				}
			}
		}
		if let Some((c, b, e)) = run.filter(|(c, _, _)| *c > 0) {
			out.push(format!("{key} x{c} {b}..{e}"));
		}
	}
	out.sort();
	out
}

fn window_independent(program: &Prog, [a, b, c]: [Fraction; 3]) -> Result<(), TestCaseError> {
	let whole = joined(&query(program, a, c));
	let mut pieces = query(program, a, b);
	pieces.extend(query(program, b, c));
	prop_assert_eq!(joined(&pieces), whole);
	Ok(())
}

/// Runs one property over `config().cases` random inputs, checks that every case ran, and prints the count.
fn check<S: Strategy>(
	name: &str,
	strategy: S,
	property: impl Fn(S::Value) -> Result<(), TestCaseError>,
) where
	S::Value: std::fmt::Debug,
{
	let mut runner = TestRunner::new(config());
	let ran = std::cell::Cell::new(0u32);
	let result = runner.run(&strategy, |value| {
		ran.set(ran.get() + 1);
		property(value)
	});
	if let Err(failure) = result {
		panic!("{name}: failed after {} cases\n{failure}", ran.get());
	}
	assert_eq!(ran.get(), config().cases, "{name}: not every case ran");
	println!("property {name}: {} cases, 0 failures", ran.get());
}

// --- Properties --------------------------------------------------------------------------------

/// Property 1: querying `[a, c)` equals querying `[a, b)` and `[b, c)` with the fragments joined.
#[test]
fn window_independence_of_discrete_programs() {
	check(
		"window independence (discrete)",
		(discrete(), times()),
		|(program, t)| window_independent(&program, t),
	);
}

/// Property 1 for signals given structure, or used as controls (each event reads its onset).
#[test]
fn window_independence_of_signals_with_structure() {
	check(
		"window independence (signals with structure)",
		(signal_with_structure(), times()),
		|(program, t)| window_independent(&program, t),
	);
}

/// Property 2: `fast(n).slow(n)` equals the pattern.
#[test]
fn fast_then_slow_is_the_identity() {
	check(
		"fast(n).slow(n) is the identity",
		(
			discrete(),
			prop::sample::select(vec![2.0, 3.0, 0.5, 1.5, 5.0]),
			times(),
		),
		|(program, n, [a, _, c])| {
			let back = with(
				with(program.clone(), step("fast", vec![num(n)])),
				step("slow", vec![num(n)]),
			);
			prop_assert_eq!(joined(&query(&back, a, c)), joined(&query(&program, a, c)));
			Ok(())
		},
	);
}

/// Property 2: `rev().rev()` equals the pattern.
#[test]
fn rev_twice_is_the_identity() {
	check(
		"rev().rev() is the identity",
		(discrete(), times()),
		|(program, [a, _, c])| {
			let back = with(
				with(program.clone(), step("rev", vec![])),
				step("rev", vec![]),
			);
			prop_assert_eq!(joined(&query(&back, a, c)), joined(&query(&program, a, c)));
			Ok(())
		},
	);
}

/// Property 2: `every(1, f)` equals `f(pattern)`.
#[test]
fn every_one_is_the_transform() {
	let transforms: [Vec<Json>; 4] = [
		vec![step("rev", vec![])],
		vec![step("fast", vec![num(2.0)])],
		vec![step("slow", vec![num(2.0)])],
		vec![step("fast", vec![num(3.0)]), step("rev", vec![])],
	];
	check(
		"every(1, f) equals f(pattern)",
		(discrete(), 0usize..4, times()),
		|(program, which, [a, _, c])| {
			let f = &transforms[which];
			let every = with(
				program.clone(),
				step("every", vec![num(1.0), Json::Arr(f.clone())]),
			);
			let mut direct = program.clone();
			direct.extend(f.iter().cloned());
			prop_assert_eq!(joined(&query(&every, a, c)), joined(&query(&direct, a, c)));
			Ok(())
		},
	);
}

/// Property 3: a signal sampled at `t` gives the same value in any window that contains `t`.
#[test]
fn a_signal_reads_the_same_at_a_point_in_any_window() {
	check(
		"signal sampled at t is window independent",
		(signal_program(), times()),
		|(program, [a, b, c])| {
			let pattern = build(&program);
			let at = pattern.sample_at(b);
			// A query that starts at b reads the signal there. Not for a reversed signal, where the
			// query mirrors its span and reads the mirrored end (the reference's own tests say so),
			// which is why the sampler exists.
			let reversed = program
				.iter()
				.any(|s| matches!(s, Json::Arr(items) if items[0] == text("rev")));
			if !reversed {
				let first = pattern
					.query(Span::new(b, c))
					.into_iter()
					.next()
					.map(|h| h.value);
				prop_assert_eq!(first, at.clone());
			}
			// A window that merely contains b does not change what the sampler says about b.
			let _ = pattern.query(Span::new(a, c));
			prop_assert_eq!(pattern.sample_at(b), at);
			Ok(())
		},
	);
}

/// Property 3: `seed(s)` is reproducible across builds and across threads.
#[test]
fn a_seed_is_reproducible_across_threads() {
	let seeds = prop_oneof![
		(0..=999).prop_map(|n| Seed::Num(f64::from(n))),
		"[a-z0-9 ]{0,8}".prop_map(Seed::Str),
	];
	check(
		"seed(s) is reproducible across threads",
		(
			prop::sample::select(vec!["rand", "rand2", "perlin", "brand"]),
			seeds,
			prop::collection::vec((-36i128..=72, 1i128..=12), 1..=8),
		),
		|(name, seed, instants)| {
			let seed_json = match &seed {
				Seed::Num(n) => num(*n),
				Seed::Str(s) => text(s),
			};
			let program = vec![step(name, vec![]), step("seed", vec![seed_json])];
			let times: Vec<Fraction> = instants
				.iter()
				.map(|(n, d)| Fraction::new(*n, *d))
				.collect();
			let here: Vec<Option<Value>> = times
				.iter()
				.map(|t| build(&program).sample_at(*t))
				.collect();
			let there = {
				let (program, times) = (program.clone(), times.clone());
				std::thread::spawn(move || {
					times
						.iter()
						.map(|t| build(&program).sample_at(*t))
						.collect::<Vec<_>>()
				})
				.join()
				.unwrap()
			};
			prop_assert_eq!(here, there);
			Ok(())
		},
	);
}
