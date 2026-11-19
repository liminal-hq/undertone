// Property tests: booking a window equals booking its halves, and no boundary is booked twice
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Window independence of booking (RF-22): for any pattern, tempo, and split points, the graph recorded by
//! booking a window in one call equals the graph recorded by booking it in pieces.

use proptest::prelude::*;
use undertone_engine::engine::{Engine, OutputSetup, Playback};
use undertone_engine::graph::{GraphRecord, LogGraph};
use undertone_pattern::control::{note, sound};
use undertone_pattern::pattern::stack;
use undertone_pattern::{ControlMap, Pattern};
use undertone_sched::{BookOptions, book_window};

/// The patterns the properties run over: plain, subdivided, alternating, euclidean, stacked, slowed and
/// sped up by non-integer factors (so events straddle window edges), a cut group, a nudge, and noise.
fn pattern(index: usize) -> Pattern<ControlMap> {
	let pattern = match index % 9 {
		0 => note("c3 e3 g3"),
		1 => note("c3*3 e3").and_then(|p| p.slow(1.5)),
		2 => note("<c3 e3> g3 ~ c4@2"),
		3 => note("c3(3,8)"),
		4 => {
			let low = note("[c3,e3]").and_then(|p| p.cut(1.0));
			let high = note("g3*5").and_then(|p| p.nudge(MAX_NUDGE));
			Ok(stack(vec![low.unwrap(), high.unwrap()]))
		}
		5 => note("c3 e3").and_then(|p| p.fast(2.5)),
		6 => note("c3").and_then(|p| p.slow(2.0)),
		7 => sound("white pink ~ white"),
		_ => note("c3 e3 g3 b3").and_then(|p| p.cut(2.0)),
	};
	pattern.expect("a valid pattern")
}

/// The nudge, in seconds, that one of the patterns gives its voices.
const MAX_NUDGE: f64 = 0.004;

fn engine() -> Engine<LogGraph> {
	Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default()).expect("an engine")
}

fn options(bpm: f64, start_time: f64, gated: bool) -> BookOptions {
	BookOptions {
		bpm: Some(bpm),
		start_time,
		gated,
		..BookOptions::default()
	}
}

/// What booking leaves behind: the recorded graph and every playback's window.
fn outcome(engine: Engine<LogGraph>, booked: Vec<Playback>) -> (GraphRecord, Vec<(f64, f64)>) {
	let windows = booked.iter().map(|p| (p.start_time, p.end_time)).collect();
	(engine.into_graph().finish(None), windows)
}

/// Books the window in one call, and in pieces cut at `cuts` (sorted), and gives both outcomes.
fn book_whole_and_pieces(
	pattern: &Pattern<ControlMap>,
	options: &BookOptions,
	t0: f64,
	t1: f64,
	cuts: &[f64],
) -> (
	(GraphRecord, Vec<(f64, f64)>),
	(GraphRecord, Vec<(f64, f64)>),
) {
	let mut whole = engine();
	let booked = book_window(&mut whole, pattern, t0, t1, options).expect("books");
	let whole = outcome(whole, booked);

	let mut pieces = engine();
	let mut booked = Vec::new();
	let mut at = t0;
	for &cut in cuts.iter().chain(std::iter::once(&t1)) {
		booked.extend(book_window(&mut pieces, pattern, at, cut, options).expect("books"));
		at = cut;
	}
	(whole, outcome(pieces, booked))
}

proptest! {
	/// Booking [a, c) equals booking [a, b) then [b, c), for a split anywhere inside.
	#[test]
	fn a_window_equals_its_two_halves(
		index in 0usize..9,
		bpm in 60.0f64..480.0,
		start in 0.0f64..50.0,
		gated in any::<bool>(),
		a in 0.0f64..20.0,
		length in 0.0f64..12.0,
		split in 0.0f64..1.0,
	) {
		let pattern = pattern(index);
		let (t0, t1) = (a, a + length);
		let middle = t0 + (t1 - t0) * split;
		let (whole, halves) =
			book_whole_and_pieces(&pattern, &options(bpm, start, gated), t0, t1, &[middle]);
		prop_assert_eq!(whole, halves);
	}

	/// Windows cut at any number of random points book the same as one call: window independence.
	#[test]
	fn a_window_is_independent_of_how_it_is_split(
		index in 0usize..9,
		bpm in 60.0f64..480.0,
		a in 0.0f64..20.0,
		length in 0.0f64..12.0,
		mut splits in proptest::collection::vec(0.0f64..1.0, 0..8),
	) {
		let pattern = pattern(index);
		let (t0, t1) = (a, a + length);
		splits.sort_by(|x, y| x.partial_cmp(y).unwrap());
		let cuts: Vec<f64> = splits.iter().map(|s| t0 + (t1 - t0) * s).collect();
		let (whole, pieces) =
			book_whole_and_pieces(&pattern, &options(bpm, 0.0, true), t0, t1, &cuts);
		prop_assert_eq!(whole, pieces);
	}

	/// Two windows that meet at a point book no voice twice: the voices are distinct, and their number is
	/// the number of onsets the pattern has over the joined window.
	#[test]
	fn no_voice_is_booked_twice_at_a_boundary(
		index in 0usize..9,
		bpm in 60.0f64..480.0,
		a in 0.0f64..20.0,
		length in 0.1f64..12.0,
		split in 0.0f64..1.0,
	) {
		let pattern = pattern(index);
		let (t0, t1) = (a, a + length);
		let middle = t0 + (t1 - t0) * split;
		let options = options(bpm, 0.0, true);

		let mut one = engine();
		let joined = book_window(&mut one, &pattern, t0, t1, &options).unwrap();

		let mut two = engine();
		let first = book_window(&mut two, &pattern, t0, middle, &options).unwrap();
		let second = book_window(&mut two, &pattern, middle, t1, &options).unwrap();
		prop_assert_eq!(first.len() + second.len(), joined.len());

		// Every onset in the second window is at or after the boundary's grid edge (the nudge only moves a
		// voice later), and every onset of the first is before it (less the nudge): no tail repeats.
		let edge = undertone_sched::window_edge(middle, options.cycle_seconds().unwrap())
			.unwrap()
			.to_f64()
			* options.cycle_seconds().unwrap();
		for playback in &second {
			prop_assert!(playback.start_time >= edge - 1e-9, "{} < {}", playback.start_time, edge);
		}
		for playback in &first {
			prop_assert!(
				playback.start_time < edge + MAX_NUDGE + 1e-9,
				"{} >= {}",
				playback.start_time,
				edge
			);
		}
	}

	/// Booking the same window twice on one engine books it twice (the caller tracks what was booked): the
	/// second booking is not a no-op, and is the same voices.
	#[test]
	fn the_same_window_books_the_same_voices_each_time(
		index in 0usize..9,
		a in 0.0f64..10.0,
		length in 0.0f64..6.0,
	) {
		let pattern = pattern(index);
		let options = options(120.0, 0.0, true);
		let mut engine = engine();
		let first = book_window(&mut engine, &pattern, a, a + length, &options).unwrap();
		let second = book_window(&mut engine, &pattern, a, a + length, &options).unwrap();
		prop_assert_eq!(first.len(), second.len());
		for (x, y) in first.iter().zip(&second) {
			prop_assert_eq!((x.start_time, x.end_time), (y.start_time, y.end_time));
		}
	}
}

/// The properties are not vacuous: every pattern in the pool books voices over a long enough window, and the
/// stacked, cut, and noise ones make nodes beyond the destination.
#[test]
fn every_pattern_in_the_pool_books_something() {
	for index in 0..9 {
		let mut engine = engine();
		let booked = book_window(
			&mut engine,
			&pattern(index),
			0.0,
			16.0,
			&options(120.0, 0.0, true),
		)
		.unwrap();
		assert!(!booked.is_empty(), "pattern {index} booked nothing");
	}
}
