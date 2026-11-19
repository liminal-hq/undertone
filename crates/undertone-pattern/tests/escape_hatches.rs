// Tests the Custom and Foreign escape hatches, the registry, and the tree printers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The host-facing side of the tree: a registered callback, a freed one, a closure, a sampler passed through a combinator, and threads.

use std::sync::Arc;
use undertone_pattern::{
	Datum, ForeignTable, Fraction, Hap, MapFn, Pattern, Query, Span, cat, pure, seq,
	signal::{Shape, periodic},
};

fn sine() -> Pattern<f64> {
	periodic(Shape::Sine, false)
}

fn span(a: i128, b: i128) -> Span {
	Span::new(Fraction::from_int(a), Fraction::from_int(b))
}

/// A continuous pattern: one hap with no whole, and a sampler equal to the time.
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
fn a_foreign_callback_is_called_printed_and_freed() {
	let table = Arc::new(ForeignTable::<f64>::new());
	let id = table.register(Arc::new(Clock));
	let p = table.pattern(id);
	assert!(p.has_sampler());
	assert_eq!(p.sample_at(Fraction::new(3, 2)), Some(1.5));
	assert_eq!(p.to_string(), "(foreign #0)");
	assert_eq!(p.describe(), "foreign #0\n");
	// A second table's callback does not collide, and the hash follows the id.
	let other = Arc::new(ForeignTable::<f64>::new());
	assert_eq!(
		other
			.pattern(other.register(Arc::new(Clock)))
			.structural_hash(),
		p.structural_hash()
	);
	assert_eq!(table.len(), 1);
	assert!(table.unregister(id));
	assert!(!table.unregister(id));
	assert!(table.is_empty());
	assert!(p.query(span(0, 1)).is_empty());
	assert_eq!(p.sample_at(Fraction::from_int(1)), None);
}

#[test]
fn a_foreign_sampler_passes_through_combinators() {
	let table = Arc::new(ForeignTable::<f64>::new());
	let p = table.pattern(table.register(Arc::new(Clock)));
	let doubled = p.fmap(MapFn::Mul(2.0)).fast(2.0).unwrap();
	assert!(doubled.has_sampler());
	// Fast 2 reads the child at twice the time, then doubles it.
	assert_eq!(doubled.sample_at(Fraction::from_int(1)), Some(4.0));
	let stacked = seq(vec![p.clone(), pure(1.0)]);
	assert!(stacked.has_sampler());
}

#[test]
fn closures_are_custom_nodes_and_keep_a_sampler() {
	let p = sine().fmap_with(|v: &f64| v + 10.0);
	assert!(p.has_sampler());
	let at_zero = p.sample_at(Fraction::from_int(0)).unwrap();
	assert!((at_zero - 10.5).abs() < 1e-12);
	assert!(p.to_string().starts_with("(custom #"));
	// Two closures never share a number.
	let q = sine().fmap_with(|v: &f64| *v);
	assert_ne!(p.to_string(), q.to_string());
}

#[test]
fn a_pattern_with_a_foreign_leaf_can_be_queried_on_another_thread() {
	let table = Arc::new(ForeignTable::<f64>::new());
	let p = cat(vec![
		table.pattern(table.register(Arc::new(Clock))),
		pure(7.0),
	]);
	let q: Pattern<f64> = p.clone();
	let from_thread = std::thread::spawn(move || q.query(span(0, 2)).len())
		.join()
		.unwrap();
	assert_eq!(from_thread, p.query(span(0, 2)).len());
}

fn check<T: Datum>(p: &Pattern<T>) {
	assert!(!p.to_string().is_empty() && !p.describe().is_empty());
	assert_eq!(p.structural_hash(), p.clone().structural_hash());
}

#[test]
fn every_node_prints_in_both_forms_and_hashes() {
	use undertone_pattern::control::note;
	use undertone_pattern::{ArithOp, arrange};
	let base = note("c3 e3").unwrap();
	check(&base.rev().fast(2.0).unwrap().slow(3.0).unwrap());
	check(&base.every(2.0, |p| p.rev()).unwrap());
	check(&base.euclid(3.0, 8.0, 1.0).unwrap());
	check(&base.jux(|p| p.rev()).unwrap());
	check(&arrange(vec![(2.0, base.clone()), (1.0, base.clone())]).unwrap());
	check(&sine().segment(4.0).unwrap());
	check(&sine().euclid(3.0, 8.0, 0.0).unwrap());
	check(&sine().range(1.0, 3.0).arith(ArithOp::Add, &pure(1.0)));
	check(&sine().round().floor());
	check(&undertone_pattern::silence::<f64>());
	// The outline names every node on its own line.
	let outline = base.every(2.0, |p| p.rev()).unwrap().describe();
	assert!(outline.starts_with("every 2\n"));
	assert_eq!(outline.lines().filter(|l| l.contains("rev")).count(), 1);
}
