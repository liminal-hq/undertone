// Native real-time output for Undertone: a Player through the system audio device, or through a host's own callback
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Plays an Undertone [`Player`](undertone::Player) in real time.
//!
//! - [`Output`] runs a player through a [`Sink`]: a control thread books and renders ahead into a wait-free ring,
//!   and the sink's audio thread copies from it with [`AudioCallback::fill`], which never allocates or locks.
//! - [`Sink`] is the seam. A host that owns its audio (a Tauri plugin, a plug-in host, a test) implements it and
//!   needs no `cpal`: build with `default-features = false`. [`ManualSink`] is a sink with no device, for tests
//!   and offline hosts.
//! - With the default `cpal` feature, [`CpalSink`] is a sink over a system output device, [`output_devices`]
//!   lists them, and [`DeviceChoice`] selects one by name.
//!
//! ```no_run
//! use undertone::prelude::*;
//! use undertone_native::{CpalSink, Output, OutputOptions, Sink};
//!
//! let sink = CpalSink::default_output()?;
//! let mut player = Player::new(&sink.format().player_options())?;
//! player.play_loop(&note("c3 e3 g3 c4")?.sound("triangle"), &LoopOptions::default())?;
//! let mut output = Output::open(sink, player, &OutputOptions::default())?;
//! std::thread::sleep(std::time::Duration::from_secs(4));
//! output.close();
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! The automated tests assert the sample stream, the allocation count, and the timing against a fake callback.
//! They cannot say how it sounds on a speaker: that has to be listened to on a real device.

mod error;
pub mod output;
pub mod sink;

#[cfg(feature = "cpal")]
mod device;

pub use error::{NativeError, Result};
pub use output::{Output, OutputOptions};
pub use sink::{AudioCallback, ManualDriver, ManualSink, Sink, StreamFormat, StreamHealth};

#[cfg(feature = "cpal")]
pub use device::{CpalSink, DeviceChoice, DeviceInfo, output_devices};
