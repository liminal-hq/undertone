// Rendering and WAV export
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Ports `docs/guide/rendering-and-export.md`. Run it with `cargo run --example rendering_and_export`.
//!
//! `render` is `renderToBuffer`, `RenderedAudio::to_wav` is `encodeWav`, and `render_to_wav` is the two in one
//! call. Everything here is offline: no device, no clock, the same samples on every machine.

mod common;

use common::{Outcome, out_dir, quick, render_and_save};
use undertone::prelude::*;

fn main() -> Outcome {
	let song = note("c3 [e3 g3] <b3 a3> ~")?
		.sound("triangle")
		.release(0.4)?;

	// Two cycles at 480 bpm (a half-second cycle) plus half a second of tail, so the last release rings out. The
	// guide's four cycles at 110 bpm and a second of tail are the same call with other numbers.
	let options = quick().cycles(2).bpm(480).tail(0.5);
	let audio = render(&song, &options)?;
	assert_eq!(audio.frames(), (1.5 * common::RATE) as usize);

	// `encodeWav(buffer, { bitDepth: 24 })`: 16 bit (the default, with seeded dither), 24 bit, or 32 bit float.
	for (name, depth) in [
		("16", BitDepth::Sixteen),
		("24", BitDepth::TwentyFour),
		("32", BitDepth::ThirtyTwo),
	] {
		let bytes = audio.to_wav(&WavOptions::new().bit_depth(depth))?;
		let path = out_dir()?.join(format!("rendering-{name}-bit.wav"));
		std::fs::write(&path, &bytes)?;
		assert_eq!(
			u16::from_le_bytes([bytes[34], bytes[35]]) as u32,
			depth.bits().min(32)
		);
		println!("wrote {} ({} bytes)", path.display(), bytes.len());
	}

	// The whole path in one call.
	let bytes = render_to_wav(
		&song,
		&options,
		&WavOptions::new().bit_depth(BitDepth::TwentyFour),
	)?;
	assert_eq!(&bytes[0..4], b"RIFF");

	// Reproducible renders: noise and reverb are seeded (default 0), so the same pattern, tempo, sample rate, and
	// seed give the same samples. The dither is seeded too, so the same bytes.
	let noisy = sound("white*4")?.decay(0.05)?.room(0.5)?;
	let a = render_to_wav(
		&noisy,
		&quick().seed("level-1").bpm(240),
		&WavOptions::new().seed(1.0),
	)?;
	let b = render_to_wav(
		&noisy,
		&quick().seed("level-1").bpm(240),
		&WavOptions::new().seed(1.0),
	)?;
	assert_eq!(a, b);

	// Gating: notes are gated by their event length like `loop()`. `gated(false)` is a percussive one-shot.
	render_and_save("rendering-one-shot", &song, &quick().bpm(480).gated(false))?;

	// Seamless loops: `wrap(true)` folds the tail back onto the start, so the file is exactly one pass long and
	// loops without a gap or a cut-off tail.
	let wrapped = render_and_save(
		"rendering-wrapped",
		&song,
		&quick().bpm(480).tail(0.5).wrap(true),
	)?;
	assert_eq!(wrapped.frames(), (0.5 * common::RATE) as usize);

	// Master bus: the render goes through the same limiter as `createMasterBus`. `MasterSetting::Off` is the raw
	// mix; `Tuned` adds a gain, a limiter, and a final `ceiling` that no sample passes.
	let loud = stack(vec![
		note("c3 c3 c3 c3")?.sound("square").gain(1.0)?,
		note("c4 e4 g4 b4")?.sound("sawtooth").gain(1.0)?,
	]);
	let ceiling = MasterBusOptions {
		ceiling: Some(-0.3),
		..MasterBusOptions::default()
	};
	let limited = render(
		&loud,
		&quick().bpm(480).master(MasterSetting::Tuned(ceiling)),
	)?;
	let top = 10f32.powf(-0.3 / 20.0);
	assert!(limited.peak() <= top + 1e-6, "no sample passes the ceiling");
	let raw = render(&loud, &quick().bpm(480).master(MasterSetting::Off))?;
	println!(
		"peak with a -0.3 dB ceiling {:.3}, raw {:.3}",
		limited.peak(),
		raw.peak()
	);

	// Channels and format: `channels` is 1, 2, 4, 6, or 8. More than two uses discrete multichannel output with
	// the master bus off (see the stereo and surround example), and the WAV gets the extensible header.
	let surround = note("c4*4")?.sound("triangle").surround(45.0)?;
	let six = render(
		&surround,
		&quick().bpm(480).channels(6).master(MasterSetting::Off),
	)?;
	let bytes = six.to_wav(&WavOptions::new().bit_depth(BitDepth::TwentyFour))?;
	assert_eq!(
		u16::from_le_bytes([bytes[20], bytes[21]]),
		0xfffe,
		"extensible"
	);
	std::fs::write(out_dir()?.join("rendering-5-1.wav"), &bytes)?;

	// Booking in windows: the voices are booked a window at a time instead of all before the render starts. The
	// audio is the same; a renderer that processes every node from the moment it is made does far less work.
	let windowed = render(&song, &options.clone().booking_window(0.5))?;
	assert_eq!(windowed, audio, "the same samples either way");

	// Options are checked with the reference's messages, in its order.
	for (what, options) in [
		("cycles and seconds", quick().cycles(1).seconds(1)),
		("a half cycle", quick().cycles(1.5)),
		("three channels", quick().channels(3)),
		("a short window", quick().booking_window(0.001)),
		("a negative tail", quick().tail(-1)),
	] {
		println!("{what}: {}", render(&song, &options).unwrap_err());
	}

	// WAV files have limits: one to eight channels, all of one length.
	let none = RenderedAudio::new(48_000.0, vec![]);
	println!("{}", none.to_wav(&WavOptions::new()).unwrap_err());
	Ok(())
}
