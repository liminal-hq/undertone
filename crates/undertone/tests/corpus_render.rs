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

	use std::collections::BTreeSet;
	use std::path::PathBuf;

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
