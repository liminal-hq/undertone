// Runs every example, and checks that each writes real WAV files: valid header, at most two seconds, not silent
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! One example per page of the guide (`docs/guide/*.md`) lives under `crates/undertone/examples/`. This test
//! runs each as a program with `UNDERTONE_EXAMPLE_OUT` pointing at a fresh directory, and then reads the files it
//! wrote: the RIFF structure must be consistent, no file may be longer than two seconds, every sample must be
//! finite, and at least one file of the example must not be silent. The examples assert their own claims as they
//! run (an example that fails exits non-zero), so a program that completes has checked what its comments say.
//!
//! A second test lists the guide's pages and the examples, and fails if a page has no example.
//! Nothing here listens to the audio.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The guide page each example ports. Every page of `docs/guide/` must be here.
const GUIDE_PAGES: &[(&str, &str)] = &[
	("getting-started", "getting_started"),
	("mini-notation", "mini_notation"),
	("melody-and-harmony", "melody_and_harmony"),
	("patterned-parameters", "patterned_parameters"),
	("signals", "signals"),
	("effects", "effects_and_filters"),
	("fm-synthesis", "fm_synthesis"),
	("instruments-and-scores", "instruments_and_scores"),
	("stereo-and-surround", "stereo_and_surround"),
	("arranging-songs", "arranging_songs"),
	("tempo-and-note-length", "tempo_and_note_length"),
	("samples", "samples"),
	("rendering-and-export", "rendering_and_export"),
	("troubleshooting", "troubleshooting"),
];

/// The longest a written file may be, in seconds.
const MAX_SECONDS: f64 = 2.0;

/// What a WAV file holds, read back.
struct Wav {
	channels: usize,
	sample_rate: u32,
	samples: Vec<f32>,
}

impl Wav {
	fn frames(&self) -> usize {
		self.samples.len() / self.channels
	}

	fn peak(&self) -> f32 {
		self.samples.iter().fold(0.0, |peak, s| peak.max(s.abs()))
	}
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
	u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
	u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Reads a RIFF/WAVE file with 16 or 24 bit PCM or 32 bit float samples, checking the structure on the way.
fn read_wav(path: &Path) -> Wav {
	let bytes = std::fs::read(path).unwrap();
	let name = path.display();
	assert!(bytes.len() > 44, "{name}: too short for a WAV file");
	assert_eq!(&bytes[0..4], b"RIFF", "{name}");
	assert_eq!(
		u32_at(&bytes, 4) as usize,
		bytes.len() - 8,
		"{name}: RIFF size"
	);
	assert_eq!(&bytes[8..12], b"WAVE", "{name}");
	let (mut format, mut data) = (None, None);
	let mut at = 12;
	while at + 8 <= bytes.len() {
		let id = &bytes[at..at + 4];
		let size = u32_at(&bytes, at + 4) as usize;
		let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
		assert_eq!(body.len(), size, "{name}: chunk {:?} runs past the end", id);
		match id {
			b"fmt " => format = Some(body.to_vec()),
			b"data" => data = Some(body.to_vec()),
			_ => {}
		}
		at += 8 + size + size % 2;
	}
	let format = format.unwrap_or_else(|| panic!("{name}: no fmt chunk"));
	let data = data.unwrap_or_else(|| panic!("{name}: no data chunk"));
	let tag = match u16_at(&format, 0) {
		0xfffe => u16_at(&format, 24), // extensible: the sub-format's first two bytes
		tag => tag,
	};
	let channels = u16_at(&format, 2) as usize;
	let sample_rate = u32_at(&format, 4);
	let bits = u16_at(&format, 14);
	assert_eq!(
		u32_at(&format, 8),
		sample_rate * channels as u32 * u32::from(bits) / 8,
		"{name}: byte rate"
	);
	assert_eq!(
		u16_at(&format, 12),
		channels as u16 * bits / 8,
		"{name}: block align"
	);
	let step = usize::from(bits) / 8;
	assert_eq!(data.len() % (step * channels), 0, "{name}: whole frames");
	let samples = data
		.chunks_exact(step)
		.map(|chunk| match (tag, bits) {
			(1, 16) => f32::from(i16::from_le_bytes([chunk[0], chunk[1]])) / 32768.0,
			(1, 24) => {
				let value = i32::from_le_bytes([0, chunk[0], chunk[1], chunk[2]]) >> 8;
				value as f32 / 8_388_608.0
			}
			(3, 32) => f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
			other => panic!("{name}: format {other:?}"),
		})
		.collect();
	Wav {
		channels,
		sample_rate,
		samples,
	}
}

/// Runs one example into a fresh directory and returns the directory.
fn run_example(example: &str) -> PathBuf {
	static RUNS: AtomicUsize = AtomicUsize::new(0);
	let out = std::env::temp_dir().join(format!(
		"undertone-examples-test-{}-{}-{example}",
		std::process::id(),
		RUNS.fetch_add(1, Ordering::Relaxed)
	));
	let _ = std::fs::remove_dir_all(&out);
	// The test binary is `target/<profile>/deps/examples-<hash>`; cargo builds the examples beside it.
	let built = std::env::current_exe()
		.unwrap()
		.parent()
		.and_then(Path::parent)
		.map(|profile| profile.join("examples").join(example))
		.filter(|path| path.exists());
	let output = match built {
		Some(program) => Command::new(program)
			.env("UNDERTONE_EXAMPLE_OUT", &out)
			.output(),
		None => Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
			.args([
				"run",
				"--quiet",
				"--locked",
				"-p",
				"undertone",
				"--example",
				example,
			])
			.env("UNDERTONE_EXAMPLE_OUT", &out)
			.output(),
	}
	.unwrap_or_else(|error| panic!("{example}: could not run: {error}"));
	assert!(
		output.status.success(),
		"{example} failed ({}):\n{}\n{}",
		output.status,
		String::from_utf8_lossy(&output.stdout),
		String::from_utf8_lossy(&output.stderr)
	);
	out
}

fn check_example(example: &str) {
	let out = run_example(example);
	let mut files: Vec<PathBuf> = std::fs::read_dir(&out)
		.unwrap_or_else(|error| panic!("{example} wrote nothing to {}: {error}", out.display()))
		.map(|entry| entry.unwrap().path())
		.filter(|path| path.extension().is_some_and(|ext| ext == "wav"))
		.collect();
	files.sort();
	assert!(!files.is_empty(), "{example} wrote no WAV file");
	let mut loudest = 0.0_f32;
	for path in &files {
		let wav = read_wav(path);
		let seconds = wav.frames() as f64 / f64::from(wav.sample_rate);
		assert!(
			(0.0..=MAX_SECONDS).contains(&seconds) && wav.frames() > 0,
			"{}: {seconds} s is not in 0 to {MAX_SECONDS}",
			path.display()
		);
		assert!(
			wav.samples.iter().all(|sample| sample.is_finite()),
			"{}: a sample is not finite",
			path.display()
		);
		assert!((1..=8).contains(&wav.channels));
		loudest = loudest.max(wav.peak());
	}
	assert!(
		loudest > 1e-3,
		"{example}: every file is silent (the loudest peak is {loudest})"
	);
	let _ = std::fs::remove_dir_all(&out);
}

macro_rules! example_tests {
	($($name:ident),* $(,)?) => {
		$(
			#[test]
			fn $name() {
				check_example(stringify!($name));
			}
		)*
	};
}

example_tests!(
	getting_started,
	mini_notation,
	melody_and_harmony,
	patterned_parameters,
	signals,
	effects_and_filters,
	fm_synthesis,
	instruments_and_scores,
	stereo_and_surround,
	arranging_songs,
	tempo_and_note_length,
	samples,
	rendering_and_export,
	troubleshooting,
);

#[test]
fn every_guide_page_has_an_example_and_every_example_a_test() {
	let root = Path::new(env!("CARGO_MANIFEST_DIR"));
	let mut pages: Vec<String> = std::fs::read_dir(root.join("../../docs/guide"))
		.unwrap()
		.map(|entry| entry.unwrap().path())
		.filter(|path| path.extension().is_some_and(|ext| ext == "md"))
		.map(|path| path.file_stem().unwrap().to_string_lossy().into_owned())
		// The Rust guide pages (`rust-*.md`, the documentation package) are not pages of the reference's guide.
		.filter(|stem| !stem.starts_with("rust-"))
		// `runtimes.md` is the npm package's loading page (M6), with no reference example to port.
		.filter(|stem| stem != "runtimes")
		.collect();
	pages.sort();
	let mut mapped: Vec<String> = GUIDE_PAGES
		.iter()
		.map(|(page, _)| page.to_string())
		.collect();
	mapped.sort();
	assert_eq!(
		pages, mapped,
		"a guide page has no example (or one was removed)"
	);

	let mut examples: Vec<String> = std::fs::read_dir(root.join("examples"))
		.unwrap()
		.map(|entry| entry.unwrap().path())
		.filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
		.map(|path| path.file_stem().unwrap().to_string_lossy().into_owned())
		.collect();
	examples.sort();
	let mut expected: Vec<String> = GUIDE_PAGES
		.iter()
		.map(|(_, example)| example.to_string())
		.collect();
	expected.sort();
	assert_eq!(examples, expected, "an example is not in the table");
}

#[test]
fn getting_started_writes_a_wav_called_for_by_the_milestone() {
	// `cargo run --example getting_started` writes a WAV: the first file it names is the first sound.
	let out = run_example("getting_started");
	let wav = read_wav(&out.join("getting-started-first-sound.wav"));
	assert_eq!((wav.channels, wav.sample_rate), (2, 22_050));
	assert_eq!(wav.frames(), 22_050);
	assert!(wav.peak() > 0.1);
	let _ = std::fs::remove_dir_all(&out);
}
