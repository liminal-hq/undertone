// Tests that a query-time error and the work of a query reach a caller through every node that reads a pattern
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A `voicing` with an unusable anchor fails at query time. The error has to survive being the structure or the value source of another pattern, and a chain of controls must query a failing child once, not once per control.

use std::sync::{
	Arc,
	atomic::{AtomicUsize, Ordering},
};
use undertone_pattern::{
	Fraction, Hap, Pattern, Span, Value,
	chord::{VoicingOptions, chord},
	control::note,
};

fn cycle() -> Span {
	Span::new(Fraction::from_int(0), Fraction::from_int(1))
}

fn bad_chord() -> Pattern<Value> {
	chord("C")
		.unwrap()
		.voicing(VoicingOptions::anchor_name("zz"))
}

#[test]
fn the_failing_pattern_itself_errors() {
	assert!(bad_chord().try_query(cycle()).is_err());
}

#[test]
fn an_error_survives_segment() {
	let p = bad_chord().segment(4.0).unwrap();
	assert!(p.can_fail());
	assert!(p.try_query(cycle()).is_err());
}

#[test]
fn an_error_survives_being_a_control_pattern() {
	let p = note("c3").unwrap().gain(bad_chord()).unwrap();
	assert!(p.can_fail());
	assert!(p.try_query(cycle()).is_err());
}

#[test]
fn a_chain_of_controls_queries_a_failing_child_once() {
	let calls = Arc::new(AtomicUsize::new(0));
	let counter = Arc::clone(&calls);
	let base = Pattern::from_fn(move |span, out: &mut Vec<Hap<Value>>| {
		counter.fetch_add(1, Ordering::SeqCst);
		chord("C").unwrap().query_into(span, out);
	});
	let mut p = base.voicing(VoicingOptions::default());
	for _ in 0..10 {
		p = p.gain(0.5).unwrap();
	}
	assert!(p.can_fail());
	p.try_query(cycle()).unwrap();
	assert_eq!(calls.load(Ordering::SeqCst), 1);
}
