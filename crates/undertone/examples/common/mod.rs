// Helpers the examples share: where the WAV files go, and a quick set of render options
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Each example renders a few short patterns and writes them as WAV files. The files go to the directory named
//! by the `UNDERTONE_EXAMPLE_OUT` environment variable, or to `undertone-examples` in the system's temporary
//! directory. Nothing in an example plays through a speaker, and none of the audio has been listened to: the
//! examples show the API, and `tests/examples.rs` checks that each runs and writes a real WAV file.

#![allow(dead_code, reason = "each example uses some of the helpers")]

use std::error::Error;
use std::path::PathBuf;
use undertone::prelude::*;

/// What an example's `main` returns.
pub type Outcome = Result<(), Box<dyn Error>>;

/// The sample rate the examples render at: low enough to be quick, high enough to hold a melody.
pub const RATE: f64 = 22_050.0;

/// Render options at the examples' sample rate. Add the length and the tempo.
pub fn quick() -> RenderOptions {
	RenderOptions::new().sample_rate(RATE)
}

/// The directory the WAV files are written to, created if it is missing.
pub fn out_dir() -> Result<PathBuf, Box<dyn Error>> {
	let dir = std::env::var_os("UNDERTONE_EXAMPLE_OUT")
		.map(PathBuf::from)
		.unwrap_or_else(|| std::env::temp_dir().join("undertone-examples"));
	std::fs::create_dir_all(&dir)?;
	Ok(dir)
}

/// Writes the audio as a 16 bit WAV file called `name` (`.wav` is added) and prints where it went.
pub fn save(name: &str, audio: &RenderedAudio) -> Result<PathBuf, Box<dyn Error>> {
	let path = out_dir()?.join(format!("{name}.wav"));
	std::fs::write(&path, audio.to_wav(&WavOptions::new())?)?;
	println!(
		"wrote {} ({:.2} s, {} channels, peak {:.3})",
		path.display(),
		audio.seconds(),
		audio.channel_count(),
		audio.peak()
	);
	Ok(path)
}

/// Renders `pattern` with `options` and saves it as `name`.
pub fn render_and_save(
	name: &str,
	pattern: &Pattern<ControlMap>,
	options: &RenderOptions,
) -> Result<RenderedAudio, Box<dyn Error>> {
	let audio = render(pattern, options)?;
	save(name, &audio)?;
	Ok(audio)
}
