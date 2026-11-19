// The undertone crate: the Rust API of Undertone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The Rust API of Undertone.

pub mod error;
pub mod options;
pub mod player;
pub mod prelude;
pub mod render;
pub mod signals;

/// The pattern core: exact time, patterns, mini-notation, controls, signals, scales, and chords
/// ([`undertone_pattern`]).
pub use undertone_pattern as pattern;

/// The synth engine: voices on a graph, the renderer, scores, and WAV ([`undertone_engine`]).
pub use undertone_engine as engine;

/// The scheduler: windowed booking, a clock, and a transport ([`undertone_sched`]).
pub use undertone_sched as sched;

pub use error::{Error, ErrorKind, Result};
pub use options::{RenderOptions, WavOptions};
pub use player::{Player, PlayerOptions};
pub use prelude::*;
pub use render::{RenderedAudio, render, render_score, render_to_wav};
