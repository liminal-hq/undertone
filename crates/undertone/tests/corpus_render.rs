// The layer 4 runner over the whole corpus, through the facade: every group of every layer, and WAV
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Re-runs the whole conformance corpus (`conformance/cases/{1,2,3,4,wav}`) through the `undertone` crate's
//! API only, to show that the facade exposes everything the lower crates' own runners use, and that what it
//! exposes still equals the reference.
//!
//! - **Layer 1** (`1/*.json`): every program is built with the interpreter (`tests/corpus/interpret.rs`, which
//!   uses `undertone::pattern` only), queried through `Pattern` queries, and compared hap for hap.
//! - **Layer 2** (`2/*.json`): the same programs booked as voices and resolved with `resolve_params`.
//! - **Layer 3** (`3/*.json`): scores, voices, and renders booked through `Engine` on a `LogGraph` and compared
//!   with the recorded graph; the recorded graphs are replayed through the `Graph` trait.
//! - **Layer 4** (`4/renders.json`): the recorded programs are rendered by the facade's `render`, which plans
//!   the render, books it on a `RenderGraph`, and renders it, and compared with the browser's summaries against
//!   the tolerances of `docs/rust-migration/CONFORMANCE.md`.
//! - **WAV** (`wav/wav.json`): `encode_wav` byte for byte.
//!
//! The comparators are the lower crates' own, copied with only their import paths changed (`undertone_pattern`
//! to `undertone::pattern`, `undertone_engine` to `undertone::engine`); none is weakened. Nothing here was
//! listened to.
//!
//! **Coverage.** [`every_group_of_the_corpus_is_handled`] lists the corpus's directories and fails unless each
//! group is named in [`HANDLED`], and each layer's runner asserts that it ran exactly the groups named for it,
//! so a group added to the corpus cannot be skipped silently.

mod corpus {
	pub mod encode;
	pub mod interpret;
	pub mod json;
	pub mod layer1;
	pub mod layer2;
	pub mod layer3;
	pub mod layer4;
	pub mod wav;

	use std::collections::{BTreeMap, BTreeSet};
	use std::path::{Path, PathBuf};

	/// The groups of each corpus directory that this runner handles. A group of the corpus that is not here
	/// fails [`super::every_group_of_the_corpus_is_handled`], and a group here that the corpus lost fails it too.
	pub const HANDLED: &[(&str, &[&str])] = &[
		(
			"1",
			&[
				"chords",
				"combinators",
				"controls",
				"core",
				"drift",
				"mini",
				"notes",
				"random",
				"scales",
				"signals",
			],
		),
		(
			"2",
			&[
				"channels",
				"chords",
				"controls",
				"drift",
				"instruments",
				"notes",
				"signals",
			],
		),
		(
			"3",
			&[
				"channels",
				"instruments",
				"options",
				"placement",
				"samples",
				"score",
				"voices",
			],
		),
		("4", &["renders"]),
		("wav", &["wav"]),
	];

	/// The corpus directory.
	pub fn cases() -> PathBuf {
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cases")
	}

	/// The groups a layer's directory holds: the file names without `.json`.
	pub fn groups_on_disk(layer: &str) -> BTreeSet<String> {
		std::fs::read_dir(cases().join(layer))
			.unwrap_or_else(|error| panic!("the corpus directory {layer} is missing: {error}"))
			.map(|entry| entry.unwrap().path())
			.filter(|path| path.extension().is_some_and(|ext| ext == "json"))
			.map(|path| path.file_stem().unwrap().to_string_lossy().into_owned())
			.collect()
	}

	/// The number of cases in each group file of a corpus directory, counted from the files themselves.
	///
	/// Fails when a file has no `cases` array or an empty one: a group with no cases would let its runner pass
	/// having compared nothing.
	pub fn count_cases(dir: &Path) -> Result<BTreeMap<String, usize>, String> {
		let mut counts = BTreeMap::new();
		let entries = std::fs::read_dir(dir).map_err(|error| {
			format!("the corpus directory {} is missing: {error}", dir.display())
		})?;
		for entry in entries {
			let path = entry.map_err(|error| error.to_string())?.path();
			if path.extension().is_none_or(|ext| ext != "json") {
				continue;
			}
			let group = path.file_stem().unwrap().to_string_lossy().into_owned();
			let text = std::fs::read_to_string(&path)
				.map_err(|error| format!("{} does not read: {error}", path.display()))?;
			let file: serde_json::Value = serde_json::from_str(&text)
				.map_err(|error| format!("{} is not JSON: {error}", path.display()))?;
			let count = file
				.get("cases")
				.and_then(serde_json::Value::as_array)
				.map_or(0, Vec::len);
			if count == 0 {
				return Err(format!(
					"group {group} ({}) has no cases: a runner would pass having compared nothing",
					path.display()
				));
			}
			counts.insert(group, count);
		}
		if counts.is_empty() {
			return Err(format!("{} holds no group files", dir.display()));
		}
		Ok(counts)
	}

	/// Fails unless `executed` (the cases a runner ran, by group) is exactly `on_disk` (the cases in the files).
	pub fn check_every_case_ran(
		layer: &str,
		on_disk: &BTreeMap<String, usize>,
		executed: &BTreeMap<String, usize>,
	) -> Result<(), String> {
		if on_disk.keys().ne(executed.keys()) {
			return Err(format!(
				"layer {layer}: the runner ran groups {:?}, the files hold {:?}",
				executed.keys().collect::<Vec<_>>(),
				on_disk.keys().collect::<Vec<_>>()
			));
		}
		for (group, count) in on_disk {
			if executed[group] != *count {
				return Err(format!(
					"layer {layer} group {group}: the runner ran {} cases, the file holds {count} (a case was skipped)",
					executed[group]
				));
			}
		}
		Ok(())
	}

	/// What each runner calls once it has run the cases of a layer: the cases it ran, by group, must be every
	/// case in the layer's files, and every group must have some.
	pub fn assert_every_case_ran(layer: &str, executed: &BTreeMap<String, usize>) {
		let on_disk =
			count_cases(&cases().join(layer)).unwrap_or_else(|message| panic!("{message}"));
		if let Err(message) = check_every_case_ran(layer, &on_disk, executed) {
			panic!("{message}");
		}
		let total: usize = executed.values().sum();
		println!(
			"layer {layer}: ran {total} cases in {} groups, every case in the files",
			executed.len()
		);
	}

	/// The groups this runner handles for a layer.
	pub fn handled(layer: &str) -> BTreeSet<String> {
		HANDLED
			.iter()
			.find(|(name, _)| *name == layer)
			.unwrap_or_else(|| panic!("layer {layer} is not handled"))
			.1
			.iter()
			.map(|group| group.to_string())
			.collect()
	}
}

/// The directories of the corpus, the groups in each, and the facade runner's list agree.
#[test]
fn every_group_of_the_corpus_is_handled() {
	let mut layers: Vec<String> = std::fs::read_dir(corpus::cases())
		.expect("the corpus exists")
		.map(|entry| entry.unwrap())
		.filter(|entry| entry.path().is_dir())
		.map(|entry| entry.file_name().to_string_lossy().into_owned())
		.collect();
	layers.sort();
	let mut handled_layers: Vec<&str> = corpus::HANDLED.iter().map(|(layer, _)| *layer).collect();
	handled_layers.sort_unstable();
	assert_eq!(
		layers, handled_layers,
		"a directory of conformance/cases has no runner (or a runner has no directory)"
	);
	let mut total = 0;
	for layer in &layers {
		let on_disk = corpus::groups_on_disk(layer);
		let handled = corpus::handled(layer);
		assert_eq!(
			on_disk, handled,
			"layer {layer}: the groups on disk and the groups the facade runner handles differ"
		);
		total += on_disk.len();
	}
	// Ten, seven, seven, one, and one groups.
	assert_eq!(total, 26);
}

/// A scratch corpus directory for a test, empty, under the target directory.
fn scratch(name: &str) -> std::path::PathBuf {
	let dir =
		std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("corpus-guard-{name}"));
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(&dir).unwrap();
	dir
}

#[test]
fn a_group_with_no_cases_fails_the_count() {
	let dir = scratch("empty-group");
	std::fs::write(
		dir.join("full.json"),
		r#"{"cases":[{"id":"a"},{"id":"b"}]}"#,
	)
	.unwrap();
	std::fs::write(dir.join("hollow.json"), r#"{"corpus":1,"cases":[]}"#).unwrap();
	let error = corpus::count_cases(&dir).unwrap_err();
	assert!(
		error.contains("group hollow") && error.contains("no cases"),
		"{error}"
	);
	// A file with no `cases` key at all, and a missing directory, fail too.
	std::fs::write(dir.join("hollow.json"), r#"{"corpus":1}"#).unwrap();
	assert!(corpus::count_cases(&dir).is_err());
	std::fs::remove_file(dir.join("hollow.json")).unwrap();
	assert_eq!(corpus::count_cases(&dir).unwrap()["full"], 2);
	assert!(corpus::count_cases(&dir.join("missing")).is_err());
	assert!(corpus::count_cases(&scratch("no-files")).is_err());
}

#[test]
fn a_skipped_case_or_group_fails_the_comparison() {
	let counts = |pairs: &[(&str, usize)]| {
		pairs
			.iter()
			.map(|(group, count)| (group.to_string(), *count))
			.collect::<std::collections::BTreeMap<_, _>>()
	};
	let on_disk = counts(&[("a", 3), ("b", 1)]);
	assert!(corpus::check_every_case_ran("x", &on_disk, &counts(&[("a", 3), ("b", 1)])).is_ok());
	let skipped = corpus::check_every_case_ran("x", &on_disk, &counts(&[("a", 2), ("b", 1)]));
	assert!(
		skipped
			.unwrap_err()
			.contains("group a: the runner ran 2 cases, the file holds 3")
	);
	assert!(corpus::check_every_case_ran("x", &on_disk, &counts(&[("a", 3)])).is_err());
	assert!(
		corpus::check_every_case_ran("x", &on_disk, &counts(&[("a", 3), ("b", 1), ("c", 1)]))
			.is_err()
	);
	// Too many is as wrong as too few: the files and the runner disagree.
	assert!(corpus::check_every_case_ran("x", &on_disk, &counts(&[("a", 4), ("b", 1)])).is_err());
}
