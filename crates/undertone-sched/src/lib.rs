// The scheduler crate of Undertone: windowed booking, a clock, and a transport
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Windowed booking, a clock, and a transport for Undertone: the Rust form of `src/scheduler.ts` and the
//! windowed booking of `src/render.ts`.
//!
//! The crate depends on [`undertone_pattern`] and [`undertone_engine`] only, uses no threads and no timers
//! (the host owns the timer), and reads no wall clock, so it runs the same in a native audio callback, a
//! browser worklet, and a test.
//!
//! - [`booking`]: [`book_window`], the pure part. Find every voice that starts in `[t0, t1)` of a pattern at a
//!   tempo and book it on an [`Engine`](undertone_engine::engine::Engine). Booking a window equals booking its
//!   halves, and no voice at a boundary is booked twice (property-tested).
//! - [`clock`]: the [`Clock`] trait (`now`, frames played, output latency) and the deterministic
//!   [`ManualClock`].
//! - [`transport`]: the [`Transport`], with `play`, `play_loop`, `tick`, `seek`, handles, and statistics, and a
//!   section on driving it from a real audio callback.
//! - [`tempo`]: [`Tempo`], the default tempo as a value the transport holds, in place of the reference's global
//!   `setcpm` (decision D-29).
//! - [`stats`]: [`Stats`], the counters of a transport: late voices, underruns, and callback time.
//!
//! ```
//! use undertone_engine::engine::{Engine, OutputSetup};
//! use undertone_engine::graph::LogGraph;
//! use undertone_pattern::control::note;
//! use undertone_sched::{ManualClock, PlayOptions, SchedulerOptions, Transport};
//!
//! // One note at the start of a one-second cycle (240 bpm), played once at 2 s on the clock.
//! let clock = ManualClock::new(48_000.0);
//! let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default())?;
//! let mut transport = Transport::new(clock, SchedulerOptions::default())?;
//! let options = PlayOptions { bpm: Some(240.0), when: Some(2.0), ..PlayOptions::default() };
//! let handle = transport.play(&mut engine, &note("c3")?, &options)?;
//! assert_eq!(handle.start_time, 2.0);
//! # Ok::<(), undertone_pattern::Error>(())
//! ```
//!
//! # Differences from the reference
//!
//! The voices of a window are booked in time order rather than the order the pattern lists them; `seek`, the
//! statistics, and [`LoopOptions::follow_tempo`] are additions; an infinite tempo, and a window edge more than
//! [`MAX_WINDOW_CYCLES`] from the start, are errors. Each is noted where it lives.

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
