// The scheduler crate of Undertone: windowed booking, a clock, and a transport
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Windowed booking, a clock, and a transport for Undertone.
//!
//! This crate turns a pattern into voices on an [`Engine`](undertone_engine::engine::Engine) over time.

pub mod booking;
pub mod tempo;

pub use booking::{
	BookOptions, MAX_WINDOW_CYCLES, WINDOW_GRID, book_cycles, book_window, window_edge,
};
pub use tempo::Tempo;
