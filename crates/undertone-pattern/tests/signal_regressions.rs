// Pins the signal cases that the corpus does not cover: mixed continuous and discrete compositions across query windows, and a negative time from a signal
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Two behaviours of the reference that the layer 1 and layer 2 `signals` corpus does not pin, found while checking RF-16's acceptance.
//!
//! - **Mixed compositions (TypeScript commit `5a45f43`).** A `cat`, `seq`, `timecat`, `stack`, `arrange`, or `every` with one continuous child and one discrete child keeps a point sampler, so a control reads the continuous child at each onset whatever the query window is. The corpus holds raw queries of these patterns (`signals-cat-mixed-01` and its siblings) but never feeds one to a control cut into windows, which is where the bug was. The expected values are the reference's: `note('c4*8').pan(<composition>)` over cycles 0 to 3, one onset after another, derived by running the TypeScript with `bun`.
//! - **A negative time from a signal (TypeScript commit `6deecfb`).** A duration control given a signal that reads below zero leaves its key unset, and zero stays valid; `nudge`, `late`, and `early` stay signed. The corpus case `signals-attack-negative` samples `sine2` at 0 and 1/2, which never goes below zero, so the rule is untested there.

use std::sync::Arc;
use undertone_pattern::signal::{Shape, periodic};
use undertone_pattern::{
	Fraction, Hap, Pattern, Query, Span, Value, arrange, cat, control, js, mini, pure, seq, stack,
	timecat,
};

const CAT_SAW2_PURE: [f64; 32] = [
	-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0,
	-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
];
const CAT_PURE_SAW2: [f64; 32] = [
	0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.2,
	0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75,
];
const CAT_SAW2_MINI: [f64; 32] = [
	-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.5, -1.0,
	-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.5,
];
const SEQ_SAW2_PURE_ISAW: [f64; 32] = [
	-1.0, -0.25, 0.5, 0.5, 0.5, 0.5, 0.5, -0.25, -1.0, -0.25, 0.5, 0.5, 0.5, 0.5, 0.5, -0.25, -1.0,
	-0.25, 0.5, 0.5, 0.5, 0.5, 0.5, -0.25, -1.0, -0.25, 0.5, 0.5, 0.5, 0.5, 0.5, -0.25,
];
const TIMECAT_SAW2_PURE: [f64; 32] = [
	-1.0, -0.25, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25, -1.0, -0.25, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25,
	-1.0, -0.25, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25, -1.0, -0.25, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25,
];
const STACK_PURE_SAW2: [f64; 32] = [
	0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3,
	0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3,
];
const STACK_REST_SAW2: [f64; 32] = [
	-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75,
	-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75,
];
const ARRANGE_SAW2_PURE: [f64; 32] = [
	-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
	0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75,
];
const EVERY_DISCRETE: [f64; 32] = [
	0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.0,
	0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75,
];
const EVERY_FROM_DISCRETE: [f64; 32] = [
	-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, -1.0,
	-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4,
];
const NESTED: [f64; 32] = [
	-1.0,
	2.220446049250313e-16,
	0.0,
	0.0,
	0.0,
	2.220446049250313e-16,
	0.0,
	0.0,
	-1.0,
	2.220446049250313e-16,
	0.0,
	0.0,
	0.0,
	2.220446049250313e-16,
	0.0,
	0.0,
	-1.0,
	2.220446049250313e-16,
	0.0,
	0.0,
	0.0,
	2.220446049250313e-16,
	0.0,
	0.0,
	-1.0,
	2.220446049250313e-16,
	0.0,
	0.0,
	0.0,
	2.220446049250313e-16,
	0.0,
	0.0,
];

type Make = fn() -> Pattern<Value>;

fn num(n: f64) -> Pattern<Value> {
	pure(Value::Num(n))
}

fn saw2() -> Pattern<Value> {
	periodic(Shape::Saw, true)
}

fn sine2() -> Pattern<Value> {
	periodic(Shape::Sine, true)
}

fn half() -> Pattern<Value> {
	mini::parse("0 0.5", |w| Ok(Value::Num(js::string_to_number(w)))).unwrap()
}

fn rest() -> Pattern<Value> {
	mini::parse("~", |w| Ok(Value::Num(js::string_to_number(w)))).unwrap()
}

/// The eleven compositions of the reference's test, with the pan it reads at each of the 32 onsets of `c4*8` over cycles 0 to 3.
fn compositions() -> Vec<(&'static str, Make, [f64; 32])> {
	vec![
		(
			"cat(saw2, pure)",
			|| cat(vec![saw2(), num(0.0)]),
			CAT_SAW2_PURE,
		),
		(
			"cat(pure, saw2)",
			|| cat(vec![num(0.2), saw2()]),
			CAT_PURE_SAW2,
		),
		(
			"cat(saw2, mini)",
			|| cat(vec![saw2(), half()]),
			CAT_SAW2_MINI,
		),
		(
			"seq(saw2, pure, isaw)",
			|| seq(vec![saw2(), num(0.5), saw2().rev()]),
			SEQ_SAW2_PURE_ISAW,
		),
		(
			"timecat(saw2, pure)",
			|| timecat(vec![(1.0, saw2()), (2.0, num(0.25))]).unwrap(),
			TIMECAT_SAW2_PURE,
		),
		(
			"stack(pure, saw2)",
			|| stack(vec![num(0.3), saw2()]),
			STACK_PURE_SAW2,
		),
		(
			"stack(rest, saw2)",
			|| stack(vec![rest(), saw2()]),
			STACK_REST_SAW2,
		),
		(
			"arrange(saw2, pure)",
			|| arrange(vec![(1.0, saw2()), (2.0, num(0.0))]).unwrap(),
			ARRANGE_SAW2_PURE,
		),
		(
			"every(discrete)",
			|| saw2().every(2.0, |_| num(0.0)).unwrap(),
			EVERY_DISCRETE,
		),
		(
			"every(from discrete)",
			|| num(0.4).every(2.0, |_| saw2()).unwrap(),
			EVERY_FROM_DISCRETE,
		),
		(
			"nested",
			|| {
				seq(vec![cat(vec![saw2(), num(0.0)]), sine2()])
					.fast(2.0)
					.unwrap()
					.rev()
			},
			NESTED,
		),
	]
}

/// The pan at every onset of `c4*8` in cycles 0 to 3, read through `windows` query windows per cycle.
fn read(pan: &Pattern<Value>, windows: i128) -> Vec<Option<f64>> {
	let control = control::note("c4*8").unwrap().pan(pan).unwrap();
	let mut onsets: Vec<(Fraction, Option<f64>)> = Vec::new();
	for k in 0..4 * windows {
		let span = Span::new(Fraction::new(k, windows), Fraction::new(k + 1, windows));
		for hap in control.query(span).iter().filter(|h| h.has_onset()) {
			onsets.push((
				hap.part.begin,
				hap.value.get("pan").and_then(Value::as_number),
			));
		}
	}
	onsets.sort_by_key(|(at, _)| *at);
	onsets.into_iter().map(|(_, pan)| pan).collect()
}

fn close(expected: f64, actual: Option<f64>) -> bool {
	actual.is_some_and(|a| (a - expected).abs() <= 1e-12)
}

#[test]
fn mixed_compositions_read_the_same_in_one_window_and_in_many() {
	for (name, make, expected) in compositions() {
		let whole = read(&make(), 1);
		assert_eq!(whole.len(), 32, "{name}");
		for (i, (want, got)) in expected.iter().zip(&whole).enumerate() {
			assert!(
				close(*want, *got),
				"{name}, onset {i}: {got:?}, the reference gave {want}"
			);
		}
		for windows in [2, 3, 8, 16] {
			assert_eq!(read(&make(), windows), whole, "{name}, {windows} windows");
		}
	}
}

#[test]
fn a_rest_in_a_discrete_child_leaves_the_key_unset() {
	let half_rest = mini::parse("~ 0.5", |w| Ok(Value::Num(js::string_to_number(w)))).unwrap();
	let control = control::note("c4*4")
		.unwrap()
		.pan(cat(vec![half_rest, saw2()]))
		.unwrap();
	let mut haps = control.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	haps.sort_by_key(|h| h.part.begin);
	let pans: Vec<Option<f64>> = haps
		.iter()
		.map(|h| h.value.get("pan").and_then(Value::as_number))
		.collect();
	assert_eq!(pans, [None, None, Some(0.5), Some(0.5)]);
}

/// A continuous pattern that reads `value` at every instant: what `signal(() => value)` is in the reference.
struct Constant(f64);

impl Query<Value> for Constant {
	fn query(&self, span: Span, out: &mut Vec<Hap<Value>>) {
		out.push(Hap {
			whole: None,
			part: span,
			value: Value::Num(self.0),
		});
	}
	fn sample(&self, _: Fraction) -> Option<Value> {
		Some(Value::Num(self.0))
	}
	fn has_sampler(&self) -> bool {
		true
	}
}

fn bad(value: f64) -> Pattern<Value> {
	Pattern::custom(Arc::new(Constant(value)))
}

type Apply = fn(&Pattern<Value>, &Pattern<Value>) -> Pattern<Value>;

/// Every duration control, each with whatever else it needs to be meaningful (the filter, FM, pitch, and delay ones).
fn times() -> Vec<(&'static str, Apply)> {
	vec![
		("attack", |p, x| p.attack(x).unwrap()),
		("decay", |p, x| p.decay(x).unwrap()),
		("release", |p, x| p.release(x).unwrap()),
		("lpa", |p, x| {
			p.lpf(500.0).unwrap().lpenv(2000.0).unwrap().lpa(x).unwrap()
		}),
		("lpd", |p, x| {
			p.lpf(500.0).unwrap().lpenv(2000.0).unwrap().lpd(x).unwrap()
		}),
		("lpr", |p, x| {
			p.lpf(500.0).unwrap().lpenv(2000.0).unwrap().lpr(x).unwrap()
		}),
		("slide", |p, x| p.slide(x).unwrap()),
		("fmattack", |p, x| p.fm(2.0).unwrap().fm_attack(x).unwrap()),
		("fmdecay", |p, x| p.fm(2.0).unwrap().fm_decay(x).unwrap()),
		("fmrelease", |p, x| {
			p.fm(2.0).unwrap().fm_release(x).unwrap()
		}),
		("pattack", |p, x| p.penv(7.0).unwrap().pattack(x).unwrap()),
		("pdecay", |p, x| p.penv(7.0).unwrap().pdecay(x).unwrap()),
		("delaytime", |p, x| {
			p.delay(0.3).unwrap().delay_time(x).unwrap()
		}),
	]
}

fn first_value(pattern: &Pattern<Value>) -> Value {
	pattern
		.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)))
		.into_iter()
		.next()
		.expect("an event")
		.value
}

#[test]
fn a_negative_time_from_a_signal_is_left_unset_and_zero_is_kept() {
	for (name, apply) in times() {
		let key = undertone_pattern::Control::from_name(name).unwrap().key();
		let note = || control::note("c4*2").unwrap();
		let negative = first_value(&apply(&note(), &bad(-1.0)));
		assert_eq!(negative.get(key), None, "{name}: -1 leaves {key} unset");
		let zero = first_value(&apply(&note(), &bad(0.0)));
		assert_eq!(
			zero.get(key),
			Some(&Value::Num(0.0)),
			"{name}: 0 is a valid time"
		);
	}
}

#[test]
fn nudge_late_and_early_stay_signed() {
	let note = || control::note("c4").unwrap();
	let nudge = |p: Pattern<Value>| first_value(&p).get("nudgeTime").cloned();
	assert_eq!(
		nudge(note().nudge(bad(-0.05)).unwrap()),
		Some(Value::Num(-0.05))
	);
	assert_eq!(
		nudge(note().late(bad(-0.05)).unwrap()),
		Some(Value::Num(-0.05))
	);
	assert_eq!(
		nudge(note().early(bad(-0.05)).unwrap()),
		Some(Value::Num(0.05))
	);
}

#[test]
fn a_very_large_time_is_left_alone() {
	let value = first_value(&control::note("c4*2").unwrap().attack(bad(1e300)).unwrap());
	assert_eq!(value.get("attack"), Some(&Value::Num(1e300)));
}
