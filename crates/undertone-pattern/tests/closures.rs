// Measures closure nodes in the tree: nothing may hold a function except the two escape hatches
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The R1 measure "closure nodes in the tree outside `Foreign` and `Custom` (must be zero)".
//!
//! A tree node can hold a function only through a trait object (`dyn`) or a function pointer (`fn(`), a boxed closure, or an `impl Fn` type stored in a field. This test reads the library source and finds every such place. Behaviour that is allowed in the tree must come through the two traits `Query` (the `Custom` node) and `ForeignHost` (the `Foreign` node), so the count of other places must be zero.

use std::path::Path;

#[test]
fn only_the_two_escape_hatches_hold_behaviour() {
	let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
	let mut offenders = Vec::new();
	let mut allowed = 0;
	for entry in std::fs::read_dir(&src).unwrap() {
		let path = entry.unwrap().path();
		let text = std::fs::read_to_string(&path).unwrap();
		for (n, line) in text.lines().enumerate() {
			let code = line.split("//").next().unwrap();
			let holds = code.contains("dyn ")
				|| code.contains("Box<")
				|| code.contains(" fn(")
				|| code.contains("&dyn");
			if !holds {
				continue;
			}
			if code.contains("dyn Query<T>") || code.contains("dyn ForeignHost<T>") {
				allowed += 1;
			} else {
				offenders.push(format!("{}:{}: {}", path.display(), n + 1, line.trim()));
			}
		}
	}
	println!(
		"closure-holding places: {allowed} (the two variants and their two constructors in pattern.rs, and the four of the std-only ForeignTable in query.rs), {} elsewhere",
		offenders.len()
	);
	assert!(
		offenders.is_empty(),
		"closure-holding places outside the escape hatches:\n{}",
		offenders.join("\n")
	);
	assert_eq!(
		allowed, 8,
		"the variants Node::Custom and Node::Foreign, their two constructors, and the std-only ForeignTable's four places"
	);
}
