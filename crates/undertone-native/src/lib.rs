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
//!
//!
//! Nothing in this crate has been listened to by its authors in an automated run: the tests assert the sample
//! stream, the allocation count, and the timing against a fake callback, not what a speaker plays.

mod error;
mod output;
mod sink;

pub use error::{NativeError, Result};
pub use output::{Output, OutputOptions};
pub use sink::{AudioCallback, ManualDriver, ManualSink, Sink, StreamFormat, StreamHealth};
