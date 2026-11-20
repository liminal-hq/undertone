// The system device: listing, selecting by name, and opening and closing the stream twice, where a device exists
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! These tests need a sound card. Where the machine has none (a CI container, a headless server) they say so on
//! standard error and pass, so the suite stays green there; they run for real on a machine with an output
//! device. They open the device and send it a quiet pattern; they do not check what is heard.
#![cfg(feature = "cpal")]

use undertone::prelude::*;
use undertone_native::{CpalSink, DeviceChoice, NativeError, Output, OutputOptions, Sink};

/// The default sink, or `None` (with a note) on a machine with no usable output device.
fn default_sink() -> Option<CpalSink> {
	match CpalSink::default_output() {
		Ok(sink) => Some(sink),
		Err(
			error @ (NativeError::NoDevice | NativeError::Stream(_) | NativeError::Unsupported(_)),
		) => {
			eprintln!("skipping: no usable audio output device here ({error})");
			None
		}
		Err(error) => panic!("unexpected error finding the default device: {error}"),
	}
}

#[test]
fn listing_devices_does_not_fail() {
	match undertone_native::output_devices() {
		Ok(devices) => {
			assert!(devices.iter().filter(|device| device.is_default).count() <= 1);
			for device in &devices {
				assert!(!device.name.is_empty());
			}
		}
		// A machine without an audio system may refuse to be listed at all.
		Err(error) => eprintln!("skipping: the audio system cannot be listed ({error})"),
	}
}

#[test]
fn an_unknown_device_name_is_not_found() {
	let name = "no such device, undertone-native test".to_string();
	match CpalSink::new(&DeviceChoice::Named(name.clone())) {
		Err(NativeError::DeviceNotFound(found)) => assert_eq!(found, name),
		// Without an audio system, listing fails before the name is looked up.
		Err(NativeError::Stream(_)) => eprintln!("skipping: the audio system cannot be listed"),
		other => panic!("expected DeviceNotFound, got {other:?}"),
	}
}

#[test]
fn a_device_can_be_selected_by_the_name_it_is_listed_under() {
	let Ok(devices) = undertone_native::output_devices() else {
		eprintln!("skipping: the audio system cannot be listed");
		return;
	};
	let Some(device) = devices
		.iter()
		.find(|device| device.default_format.is_some())
	else {
		eprintln!("skipping: no output device with a usable format");
		return;
	};
	let sink = CpalSink::new(&DeviceChoice::Named(device.name.clone())).unwrap();
	assert_eq!(sink.device_name(), device.name);
	assert_eq!(Some(sink.format()), device.default_format);
}

#[test]
fn the_default_device_opens_and_closes_twice() {
	for round in 0..2 {
		let Some(sink) = default_sink() else {
			return;
		};
		let mut player = Player::new(&sink.format().player_options()).unwrap();
		player
			.play_loop(
				&note("c3 g3").unwrap().sound("triangle").gain(0.05).unwrap(),
				&LoopOptions::default(),
			)
			.unwrap();
		let mut output = Output::open(sink, player, &OutputOptions::default())
			.unwrap_or_else(|error| panic!("round {round}: opening the device failed: {error}"));
		std::thread::sleep(std::time::Duration::from_millis(300));
		let health = output.health();
		output.close();
		assert!(!output.is_open());
		eprintln!(
			"round {round}: {} frames played, {} underruns, {} stream errors",
			health.frames_played(),
			health.underruns(),
			health.stream_errors()
		);
		output.with_player(Player::shutdown);
	}
}
