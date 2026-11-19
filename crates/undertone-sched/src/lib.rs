// The scheduler crate of Undertone: windowed booking, a clock, and a transport
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Windowed booking, a clock, and a transport for Undertone.
//!
//! This crate turns a pattern into voices on an [`Engine`](undertone_engine::engine::Engine) over time.

pub mod booking;
pub mod clock;
pub mod stats;
pub mod tempo;
pub mod transport;

pub use booking::{
	BookOptions, MAX_WINDOW_CYCLES, WINDOW_GRID, book_cycles, book_voices, book_window,
	collect_window, window_edge,
};
pub use clock::{Clock, ManualClock};
pub use stats::Stats;
pub use tempo::Tempo;
pub use transport::{
	CUT_FADE_SECONDS, LoopHandle, LoopOptions, LoopStop, LoopVoices, PlayOptions, PlaybackHandle,
	SchedulerOptions, TickReport, Transport,
};
