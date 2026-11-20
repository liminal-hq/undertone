// Renders a note or sound pattern to a WAV file: a command line with no audio device and no browser
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `undertone-render` is the offline renderer behind "Rendering without a browser" in the guide. It builds natively
//! and for `wasm32-wasip1`, where `wasmtime` runs it; the engine, the maths (`libm`, D-23), and the WAV encoder are
//! the library's own, so both builds write the same bytes.
//!
//! ```text
//! undertone-render --note "c3 [e3 g3] <b3 a3> ~" --wave triangle --seconds 2 --out song.wav
//! ```
//!
//! Nothing here has been listened to. The tests assert the arguments and the bytes, not the sound.

use std::io::Write;
use std::process::ExitCode;
use undertone::prelude::*;

const USAGE: &str = "\
undertone-render: render a pattern to a WAV file, with no audio device

Usage:
  undertone-render (--note PATTERN [--wave TYPE] | --sound PATTERN) [options]

Pattern (one of):
  --note PATTERN     mini-notation of notes, such as \"c3 [e3 g3] <b3 a3> ~\"
  --sound PATTERN    mini-notation of unpitched sounds, such as \"white*4\"
  --wave TYPE        the sound type of a --note pattern (default sine)

Options:
  --seconds N        seconds of the pattern to render (default 2)
  --tail N           extra seconds after it, so releases ring out (default 0)
  --bpm N            tempo in beats per minute, four beats a cycle (default 120)
  --rate N           sample rate in hertz (default 48000)
  --channels N       1, 2, 4, 6, or 8 (default 2; more than 2 turns the master bus off)
  --seed TEXT        seed for noise, reverb, and dither (default 0)
  --bit-depth N      16, 24, or 32 (default 16)
  --out PATH         the WAV file to write, or - for standard output (default out.wav)
  --help             this text
";

/// What the command line asked for.
#[derive(Debug, PartialEq)]
struct Job {
	note: Option<String>,
	sound: Option<String>,
	wave: String,
	seconds: f64,
	tail: f64,
	bpm: f64,
	rate: f64,
	channels: u8,
	seed: String,
	bit_depth: u8,
	out: String,
}

/// The parsed command line: a job, or a request for the usage text.
#[derive(Debug, PartialEq)]
enum Command {
	Help,
	Render(Box<Job>),
}

fn number(flag: &str, text: &str) -> Result<f64, String> {
	text.parse::<f64>()
		.ok()
		.filter(|n| n.is_finite())
		.ok_or_else(|| format!("{flag} needs a number, got \"{text}\""))
}

fn whole(flag: &str, text: &str) -> Result<u8, String> {
	text.parse::<u8>()
		.map_err(|_| format!("{flag} needs a whole number, got \"{text}\""))
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Command, String> {
	let mut job = Job {
		note: None,
		sound: None,
		wave: "sine".into(),
		seconds: 2.0,
		tail: 0.0,
		bpm: 120.0,
		rate: 48_000.0,
		channels: 2,
		seed: "0".into(),
		bit_depth: 16,
		out: "out.wav".into(),
	};
	let mut args = args.into_iter();
	while let Some(flag) = args.next() {
		if flag == "--help" || flag == "-h" {
			return Ok(Command::Help);
		}
		let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
		match flag.as_str() {
			"--note" => job.note = Some(value()?),
			"--sound" => job.sound = Some(value()?),
			"--wave" => job.wave = value()?,
			"--seconds" => job.seconds = number(&flag, &value()?)?,
			"--tail" => job.tail = number(&flag, &value()?)?,
			"--bpm" => job.bpm = number(&flag, &value()?)?,
			"--rate" => job.rate = number(&flag, &value()?)?,
			"--channels" => job.channels = whole(&flag, &value()?)?,
			"--seed" => job.seed = value()?,
			"--bit-depth" => job.bit_depth = whole(&flag, &value()?)?,
			"--out" => job.out = value()?,
			other => return Err(format!("unknown option \"{other}\"")),
		}
	}
	match (&job.note, &job.sound) {
		(None, None) => return Err("give --note or --sound".into()),
		(Some(_), Some(_)) => return Err("give --note or --sound, not both".into()),
		_ => {}
	}
	Ok(Command::Render(Box::new(job)))
}

fn run(job: &Job) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
	let pattern = match (&job.note, &job.sound) {
		(Some(text), _) => note(text)?.sound(&job.wave),
		(_, Some(text)) => sound(text)?,
		_ => unreachable!("parse needs one of them"),
	};
	let mut options = RenderOptions::new()
		.seconds(job.seconds)
		.tail(job.tail)
		.bpm(job.bpm)
		.sample_rate(job.rate)
		.channels(job.channels)
		.seed(job.seed.as_str());
	if job.channels > 2 {
		options = options.master(MasterSetting::Off);
	}
	let depth = match job.bit_depth {
		16 => BitDepth::Sixteen,
		24 => BitDepth::TwentyFour,
		32 => BitDepth::ThirtyTwo,
		other => return Err(format!("--bit-depth must be 16, 24, or 32, got {other}").into()),
	};
	let wav = WavOptions::new().bit_depth(depth).seed(job.seed.as_str());
	Ok(render_to_wav(&pattern, &options, &wav)?)
}

fn main() -> ExitCode {
	let job = match parse(std::env::args().skip(1)) {
		Ok(Command::Help) => {
			print!("{USAGE}");
			return ExitCode::SUCCESS;
		}
		Ok(Command::Render(job)) => job,
		Err(message) => {
			eprintln!("undertone-render: {message}\n\n{USAGE}");
			return ExitCode::from(2);
		}
	};
	let result = run(&job).and_then(|bytes| {
		if job.out == "-" {
			std::io::stdout().write_all(&bytes)?;
		} else {
			std::fs::write(&job.out, &bytes)?;
			eprintln!("wrote {} ({} bytes)", job.out, bytes.len());
		}
		Ok(())
	});
	match result {
		Ok(()) => ExitCode::SUCCESS,
		Err(error) => {
			eprintln!("undertone-render: {error}");
			ExitCode::FAILURE
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn args(line: &str) -> Vec<String> {
		line.split_whitespace().map(String::from).collect()
	}

	fn job(line: &str) -> Box<Job> {
		match parse(args(line)) {
			Ok(Command::Render(job)) => job,
			other => panic!("should parse: {other:?}"),
		}
	}

	#[test]
	fn needs_a_pattern_and_refuses_two() {
		assert!(parse(args("--seconds 1")).is_err());
		assert!(parse(args("--note c3 --sound white")).is_err());
		assert!(parse(args("--bogus 1")).is_err());
		assert!(parse(args("--note")).is_err());
		assert!(parse(args("--note c3 --seconds x")).is_err());
		assert_eq!(parse(args("--help")), Ok(Command::Help));
	}

	#[test]
	fn renders_the_same_bytes_twice() {
		let job = job("--note c3 --seconds 0.25 --rate 8000");
		let a = run(&job).unwrap();
		assert_eq!(&a[0..4], b"RIFF");
		assert_eq!(a.len(), 44 + 2000 * 2 * 2);
		assert_eq!(a, run(&job).unwrap());
	}

	#[test]
	fn reports_a_bad_pattern_and_depth() {
		assert!(run(&job("--note c3( --seconds 0.1")).is_err());
		let error = run(&job("--note c3 --bit-depth 8")).unwrap_err();
		assert!(error.to_string().contains("bit-depth"));
	}
}
