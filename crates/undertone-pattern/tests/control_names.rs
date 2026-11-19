// Checks the controls table against the TypeScript's exported methods and against what the guide documents
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Two checks that read files of this repository:
//!
//! 1. **The name map.** The JavaScript names in [`undertone_pattern::CONTROLS`] equal the control methods the
//!    TypeScript exports on `Pattern`, read from the API report `conformance/api/undertone.api.md` (the methods
//!    whose `this` is `Pattern<ControlPatch>`, less the ones that are not controls). The Rust names must be
//!    unique snake_case, and equal the JavaScript names with the words split where the JavaScript runs them together.
//! 2. **The guide.** Every control the guide documents is in the table: each `.name(` call in the guide's code
//!    blocks is a table control or a method on a short list of other methods, and the controls the guide lists in
//!    its prose (`docs/guide/patterned-parameters.md`, `signals.md`) are all in the table, and the table's
//!    patternable controls are all in those lists. A control the guide never mentions in an example is reported.

use std::collections::BTreeSet;
use std::path::PathBuf;
use undertone_pattern::CONTROLS;

fn repo(path: &str) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../..")
		.join(path)
}

/// The methods of `Pattern` that take `this: Pattern<ControlPatch>` but are not controls: they are the voice,
/// scale, chord, juxtaposition, and playback methods, written by hand elsewhere.
const NOT_CONTROLS: &[&str] = &["voice", "scale", "voicing", "jux", "play", "loop", "render"];

/// Methods the guide's code blocks call that are not controls: pattern transforms, playback, and the like.
const OTHER_METHODS: &[&str] = &[
	// Pattern methods and playback.
	"add",
	"div",
	"every",
	"floor",
	"jux",
	"loop",
	"mul",
	"play",
	"range",
	"rangex",
	"render",
	"rev",
	"round",
	"scale",
	"seed",
	"segment",
	"slow",
	"stop",
	"sub",
	"voice",
	"voicing",
	"query",
	// The master and orbit buses, and JavaScript built-ins the examples use.
	"setDelay",
	"setRoomSize",
	"createObjectURL",
	"log",
	"map",
	"toFixed",
];

fn ts_control_methods() -> BTreeSet<String> {
	let report = std::fs::read_to_string(repo("conformance/api/undertone.api.md"))
		.expect("the API report exists");
	report
		.lines()
		.filter_map(|line| {
			let rest = line.strip_prefix("    ")?;
			let (name, tail) = rest.split_once('(')?;
			let is_method = name.chars().all(|c| c.is_ascii_alphanumeric());
			(is_method && tail.starts_with("this: Pattern<ControlPatch>")).then(|| name.to_string())
		})
		.filter(|name| !NOT_CONTROLS.contains(&name.as_str()))
		.collect()
}

#[test]
fn the_tables_javascript_names_are_the_typescripts_control_methods() {
	let ts = ts_control_methods();
	let table: BTreeSet<String> = CONTROLS.iter().map(|c| c.js_name.to_string()).collect();
	assert_eq!(
		ts.len(),
		53,
		"the TypeScript exports 53 control methods: {ts:?}"
	);
	let missing: Vec<_> = ts.difference(&table).collect();
	let extra: Vec<_> = table.difference(&ts).collect();
	assert!(
		missing.is_empty() && extra.is_empty(),
		"in the TypeScript but not the table: {missing:?}; in the table but not the TypeScript: {extra:?}"
	);
}

#[test]
fn rust_names_are_the_javascript_names_in_snake_case() {
	for spec in CONTROLS {
		assert!(
			spec.rust_name
				.chars()
				.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
			"{}",
			spec.rust_name
		);
		// Dropping the underscores gives the JavaScript name back.
		assert_eq!(
			spec.rust_name.replace('_', ""),
			spec.js_name,
			"{} is not {} in snake case",
			spec.rust_name,
			spec.js_name
		);
	}
}

fn guide_text() -> Vec<(String, String)> {
	let mut files: Vec<_> = std::fs::read_dir(repo("docs/guide"))
		.expect("the guide exists")
		.map(|e| e.unwrap().path())
		.filter(|p| p.extension().is_some_and(|x| x == "md"))
		.collect();
	files.sort();
	files
		.into_iter()
		.map(|p| {
			(
				p.file_name().unwrap().to_string_lossy().into_owned(),
				std::fs::read_to_string(&p).unwrap(),
			)
		})
		.collect()
}

/// The text of the fenced code blocks in a markdown file.
fn code_blocks(markdown: &str) -> String {
	let mut out = String::new();
	let mut inside = false;
	for line in markdown.lines() {
		if line.trim_start().starts_with("```") {
			inside = !inside;
		} else if inside {
			out.push_str(line);
			out.push('\n');
		}
	}
	out
}

/// Every `.name(` in `text`.
fn method_calls(text: &str) -> BTreeSet<String> {
	let bytes = text.as_bytes();
	let mut found = BTreeSet::new();
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'.' {
			let start = i + 1;
			let mut end = start;
			while end < bytes.len() && bytes[end].is_ascii_alphanumeric() {
				end += 1;
			}
			if end > start && bytes.get(end) == Some(&b'(') && bytes[start].is_ascii_lowercase() {
				found.insert(text[start..end].to_string());
			}
			i = end.max(i + 1);
		} else {
			i += 1;
		}
	}
	found
}

/// The identifiers in backticks in `text`, with a trailing `()` dropped (`panpath()` is `panpath`).
fn backticked_names(text: &str) -> BTreeSet<String> {
	text.split('`')
		.skip(1)
		.step_by(2)
		.map(|s| s.trim_end_matches("()"))
		.filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase()))
		.map(String::from)
		.collect()
}

#[test]
fn the_guide_documents_no_control_the_table_lacks() {
	let table: BTreeSet<&str> = CONTROLS.iter().map(|c| c.js_name).collect();
	let mut shown_in_examples = BTreeSet::new();
	for (file, text) in guide_text() {
		for call in method_calls(&code_blocks(&text)) {
			assert!(
				table.contains(call.as_str()) || OTHER_METHODS.contains(&call.as_str()),
				"{file}: the code blocks call .{call}(), which is neither a control in the table nor one of the listed other methods"
			);
			shown_in_examples.insert(call);
		}
	}
	// The prose lists of the controls that accept a pattern (patterned-parameters.md, signals.md) and the
	// ones that refuse it.
	let guide = guide_text();
	let prose = |file: &str, marker: &str| -> BTreeSet<String> {
		let text = &guide.iter().find(|(f, _)| f == file).expect(file).1;
		let line = text
			.lines()
			.find(|l| l.contains(marker))
			.unwrap_or_else(|| panic!("{file} no longer has a line with {marker:?}"));
		// Only the sentence that lists the controls: later ones talk about `n()` and `note()`.
		backticked_names(line.split("`n()`").next().unwrap())
	};
	let accepting = prose("signals.md", "The controls that take a pattern:");
	let refusing = prose("patterned-parameters.md", "only take plain values");
	for name in accepting.iter().chain(&refusing) {
		assert!(
			table.contains(name.as_str()),
			"the guide lists {name}, which is not in the table"
		);
	}
	// Every patternable control of the table is in the guide's list, except the three the list names only
	// as part of another control (the start of `panslide` is in it) and the ones that are not numeric.
	for spec in CONTROLS.iter().filter(|c| c.is_patternable()) {
		assert!(
			accepting.contains(spec.js_name),
			"the guide's list of controls that take a pattern lacks {}",
			spec.js_name
		);
	}
	for spec in CONTROLS.iter().filter(|c| c.is_scalar_only()) {
		// `panslide` has a plain `seconds` but is patternable; `surround` and `channels` are in the refusing list.
		assert!(
			refusing.contains(spec.js_name),
			"the guide's list of controls that refuse a pattern lacks {}",
			spec.js_name
		);
	}
	let never_shown: Vec<&str> = table
		.iter()
		.copied()
		.filter(|name| !shown_in_examples.contains(*name))
		.collect();
	println!("controls the guide lists but never calls in an example: {never_shown:?}");
}
