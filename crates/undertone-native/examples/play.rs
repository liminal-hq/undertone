// Plays a short pattern through the system audio device, lists devices, and runs the underrun soak
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Plays a short pattern through the system audio device.
//!
//! ```text
//! cargo run -p undertone-native --example play                      # four seconds on the default device
//! cargo run -p undertone-native --example play -- --list            # list the output devices
//! cargo run -p undertone-native --example play -- --device pipewire # a device by name
//! cargo run -p undertone-native --example play -- --seconds 10
//! cargo run -p undertone-native --example play -- --soak-seconds 600 --busy-threads 16
//! ```
//!
//! `--soak-seconds N` is the underrun soak of RF-28: it plays for `N` seconds, optionally with `--busy-threads K`
//! threads spinning to load the cores, prints the sample clock and the underrun count every ten seconds, and exits
//! with a failure status if there was an underrun or a stream error. Run it by hand on your own machine
//! (ten minutes with every core busy is `--soak-seconds 600 --busy-threads <cores>`): it is not run in CI.
//!
//! This program has not been listened to by its authors. The automated tests do not play sound through a
//! speaker, and what you hear is yours to judge.

use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use undertone::prelude::*;
use undertone_native::{CpalSink, DeviceChoice, Output, OutputOptions, Sink, output_devices};

struct Args {
	list: bool,
	device: DeviceChoice,
	seconds: f64,
	soak: Option<f64>,
	busy_threads: usize,
}

fn parse() -> Result<Args, String> {
	let mut args = Args {
		list: false,
		device: DeviceChoice::Default,
		seconds: 4.0,
		soak: None,
		busy_threads: 0,
	};
	let mut it = std::env::args().skip(1);
	while let Some(flag) = it.next() {
		let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
		match flag.as_str() {
			"--list" => args.list = true,
			"--device" => args.device = DeviceChoice::Named(value("--device")?),
			"--seconds" => {
				args.seconds = value("--seconds")?.parse().map_err(|e| format!("{e}"))?
			}
			"--soak-seconds" => {
				args.soak = Some(
					value("--soak-seconds")?
						.parse()
						.map_err(|e| format!("{e}"))?,
				)
			}
			"--busy-threads" => {
				args.busy_threads = value("--busy-threads")?
					.parse()
					.map_err(|e| format!("{e}"))?
			}
			other => return Err(format!("unknown argument {other}")),
		}
	}
	Ok(args)
}

fn main() -> ExitCode {
	match run() {
		Ok(code) => code,
		Err(message) => {
			eprintln!("play: {message}");
			ExitCode::FAILURE
		}
	}
}

fn run() -> Result<ExitCode, Box<dyn std::error::Error>> {
	let args = parse()?;
	if args.list {
		for device in output_devices()? {
			let format = device
				.default_format
				.map_or("no usable format".to_string(), |f| {
					format!("{} Hz, {} channels", f.sample_rate, f.channels)
				});
			println!(
				"{}{}  ({format})",
				device.name,
				if device.is_default { "  [default]" } else { "" }
			);
		}
		return Ok(ExitCode::SUCCESS);
	}

	let sink = CpalSink::new(&args.device)?;
	let format = sink.format();
	println!(
		"playing on {:?}: {} Hz, {} channels",
		sink.device_name(),
		format.sample_rate,
		format.channels
	);

	// A slow arpeggio in two voices, quiet: a bass line and a bell on top.
	let mut player = Player::new(&format.player_options())?;
	let tune = stack(vec![
		note("c2 c2 g1 g1")?
			.sound("triangle")
			.decay(0.3)?
			.gain(0.25)?,
		note("e4 g4 c5 g4 e5 c5 g4 e4")?
			.sound("sine")
			.decay(0.2)?
			.gain(0.12)?,
	]);
	player.play_loop(
		&tune,
		&LoopOptions {
			bpm: Some(100.0),
			..LoopOptions::default()
		},
	)?;

	let busy = Arc::new(AtomicBool::new(true));
	let spinners: Vec<_> = (0..args.busy_threads)
		.map(|_| {
			let busy = Arc::clone(&busy);
			std::thread::spawn(move || {
				let mut x = 1.0_f64;
				while busy.load(Ordering::Relaxed) {
					x = std::hint::black_box((x * 1.000_000_1).sin() + 1.5);
				}
			})
		})
		.collect();

	let mut output = Output::open(sink, player, &OutputOptions::default())?;
	let health = output.health();
	let total = Duration::from_secs_f64(args.soak.unwrap_or(args.seconds));
	let started = Instant::now();
	let mut next_report = Duration::from_secs(10);
	while started.elapsed() < total {
		std::thread::sleep(Duration::from_millis(100).min(total.saturating_sub(started.elapsed())));
		if let Some(error) = output.take_error() {
			eprintln!("a tick failed: {error}");
		}
		if args.soak.is_some() && started.elapsed() >= next_report {
			println!(
				"{:>6.0} s  clock {:>9.2} s  underruns {}  stream errors {}",
				started.elapsed().as_secs_f64(),
				health.position_seconds(),
				health.underruns(),
				health.stream_errors()
			);
			next_report += Duration::from_secs(10);
		}
	}
	output.close();
	busy.store(false, Ordering::Relaxed);
	for spinner in spinners {
		let _ = spinner.join();
	}

	println!(
		"done: {:.2} s on the sample clock, {} underruns ({} frames of silence), {} stream errors",
		health.position_seconds(),
		health.underruns(),
		health.underrun_frames(),
		health.stream_errors()
	);
	if args.soak.is_some() && (health.underruns() > 0 || health.stream_errors() > 0) {
		return Ok(ExitCode::FAILURE);
	}
	Ok(ExitCode::SUCCESS)
}
