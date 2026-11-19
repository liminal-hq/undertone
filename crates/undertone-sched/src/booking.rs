// The pure part of the scheduler: book every voice that starts in a window of a pattern
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`book_window`], the pure part of the scheduler: find every voice that starts in `[t0, t1)` of a pattern at
//! a tempo and book it on an [`Engine`].
//!
//! It reads no clock and starts no timer. A caller gives the window (seconds since the pattern started), where
//! the pattern started on the graph's clock, and the tempo; the [`Transport`](crate::Transport) is one caller,
//! a test is another. It is the step the reference's `loop()` takes at each tick ([`schedule_span`] over the
//! window between what is booked and the look-ahead), with the window's edges placed the way the reference
//! places them: on a grid of [`WINDOW_GRID`] steps a cycle, so the fractions stay small however long the
//! pattern has been playing. Event times are exact rationals, so an onset falls in exactly one half-open window
//! wherever the edges land.
//!
//! Two properties follow, and the property tests in `tests/properties.rs` hold the crate to them:
//!
//! - **Halves equal the whole.** Booking `[a, c)` books the same voices, in the same order, at the same times
//!   as booking `[a, b)` and then `[b, c)`, for any `b` in between.
//! - **No boundary is booked twice.** A voice that starts exactly on an edge belongs to the window that begins
//!   there, never to the one that ends there.
//!
//! One deliberate difference from the reference's `loop()`: the voices of a window are booked in time order
//! (the nudge included), as an offline render books them, where the reference books them in the order the
//! pattern lists them. Within one 0.3 second look-ahead the two orders agree except for stacked layers, and the
//! time order is what makes the property above hold for any pattern.
//!
//! ```
//! use undertone_engine::engine::{Engine, OutputSetup};
//! use undertone_engine::graph::LogGraph;
//! use undertone_pattern::control::note;
//! use undertone_sched::{BookOptions, book_window};
//!
//! let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default())?;
//! let pattern = note("c3 e3 g3 b3")?;
//!
//! // At 240 bpm a cycle is one second, so the four notes start at 10, 10.25, 10.5, and 10.75.
//! let options = BookOptions {
//!     bpm: Some(240.0),
//!     start_time: 10.0,
//!     ..BookOptions::default()
//! };
//! let first = book_window(&mut engine, &pattern, 0.0, 0.5, &options)?;
//! let second = book_window(&mut engine, &pattern, 0.5, 1.0, &options)?;
//! let starts: Vec<f64> = first.iter().chain(&second).map(|p| p.start_time).collect();
//! assert_eq!(starts, [10.0, 10.25, 10.5, 10.75]);
//! # Ok::<(), undertone_pattern::Error>(())
//! ```

use crate::tempo::Tempo;
use undertone_engine::engine::{Engine, Playback};
use undertone_engine::graph::{Graph, NodeId};
use undertone_engine::render::collect_onsets;
use undertone_engine::window::sort_booking_order;
use undertone_pattern::js::number_to_string;
use undertone_pattern::{ControlMap, Error, Fraction, Pattern, Result, Span};

/// How many steps a cycle is divided into when a window's edge is placed (the reference's `WINDOW_GRID`).
///
/// 10080 is divisible by every whole number from 1 to 10, so the edges of any plain subdivision of a cycle
/// fall exactly on the grid.
pub const WINDOW_GRID: i128 = 10_080;

/// The farthest a window's edge may be from the pattern's start, in cycles: beyond this the grid step no
/// longer fits an `f64` exactly (a deliberate bound; the reference's numbers lose precision there, silently).
pub const MAX_WINDOW_CYCLES: f64 = 1.0e11;

/// What [`book_window`] needs besides the pattern and the window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BookOptions {
	/// Tempo in beats per minute, four beats to a cycle. Pass this or `cps`, not both.
	pub bpm: Option<f64>,
	/// Tempo in cycles per second. Pass this or `bpm`, not both.
	pub cps: Option<f64>,
	/// The default tempo, used when neither `bpm` nor `cps` is given (D-29: held by the caller, not global).
	pub tempo: Tempo,
	/// Where pattern time zero is on the graph's clock, in seconds.
	pub start_time: f64,
	/// Holds each voice's envelope for its event's share of the cycle, as `loop()` does. Default `true`; a
	/// one-shot `play()` is percussive (`false`).
	pub gated: bool,
	/// The node the voices go to; the engine's output when `None`.
	pub output: Option<NodeId>,
}

impl Default for BookOptions {
	fn default() -> Self {
		Self {
			bpm: None,
			cps: None,
			tempo: Tempo::new(),
			start_time: 0.0,
			gated: true,
			output: None,
		}
	}
}

impl BookOptions {
	/// The seconds one cycle lasts for these options (`cycleSecondsFor`).
	///
	/// # Errors
	///
	/// As [`Tempo::cycle_seconds`].
	pub fn cycle_seconds(&self) -> Result<f64> {
		self.tempo.cycle_seconds(self.bpm, self.cps)
	}
}

/// The pattern-time edge (in cycles, on the [`WINDOW_GRID`]) of a moment `seconds` after the pattern started.
///
/// The edge is the largest grid step at or before the moment, so a moment never rounds up past an onset that
/// has not happened yet, and two windows that meet at one moment share one edge.
///
/// # Errors
///
/// Fails when `seconds` or `cycle_seconds` is not finite, or the edge is farther than [`MAX_WINDOW_CYCLES`].
///
/// ```
/// use undertone_sched::window_edge;
///
/// // 0.3 s into a 1 s cycle, on a grid of 10080 steps.
/// let edge = window_edge(0.3, 1.0)?;
/// assert_eq!((edge.numerator(), edge.denominator()), (3, 10));
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
pub fn window_edge(seconds: f64, cycle_seconds: f64) -> Result<Fraction> {
	let cycles = seconds / cycle_seconds;
	if !cycles.is_finite() || cycles.abs() > MAX_WINDOW_CYCLES {
		return Err(Error::new(format!(
			"window edge must be a finite time within {} cycles of the start, got {} s at {} s a cycle",
			number_to_string(MAX_WINDOW_CYCLES),
			number_to_string(seconds),
			number_to_string(cycle_seconds)
		)));
	}
	let steps = (cycles * WINDOW_GRID as f64).floor();
	Ok(Fraction::new(steps as i128, WINDOW_GRID))
}

/// Books every voice that starts in the cycles `[begin, end)` on `engine`, in time order, with cycle zero at
/// `start_time` on the graph's clock and `cycle_seconds` a cycle. The exact form of [`book_window`], for a
/// caller that already holds the window as fractions.
///
/// An empty window (`end <= begin`) books nothing. The voices are collected before any is booked, so a
/// pattern that fails when queried books none.
///
/// # Errors
///
/// A pattern that fails when queried fails with its message, before anything is booked. A voice the engine
/// cannot book (a bad pitch) fails with the engine's message; the voices before it stay booked, and the ones
/// after it are not tried.
pub fn book_cycles<G: Graph>(
	engine: &mut Engine<G>,
	pattern: &Pattern<ControlMap>,
	begin: Fraction,
	end: Fraction,
	start_time: f64,
	cycle_seconds: f64,
	gated: bool,
	output: Option<NodeId>,
) -> Result<Vec<Playback>> {
	if end <= begin {
		return Ok(Vec::new());
	}
	let mut voices = collect_onsets(
		pattern,
		Span::new(begin, end),
		start_time,
		cycle_seconds,
		gated,
	)?;
	sort_booking_order(&mut voices);
	let output = output.unwrap_or_else(|| engine.output());
	voices
		.iter()
		.map(|voice| engine.play_to(output, &voice.params, voice.start_time))
		.collect()
}

/// Books every voice of `pattern` that starts in `[t0, t1)` seconds after the pattern started, at the tempo in
/// `options`, on `engine`. Returns the playbacks in booking order.
///
/// `t0` and `t1` are seconds since pattern time zero, which sits at `options.start_time` on the graph's clock;
/// each is placed on the [`WINDOW_GRID`] by [`window_edge`]. A window that is empty after that books nothing.
///
/// # Errors
///
/// An invalid tempo fails with the reference's message (`Pass either bpm or cps, not both`, `bpm must be
/// positive, got 0`, and so on). An edge that is not finite fails as [`window_edge`] says. Then as
/// [`book_cycles`].
///
/// ```
/// use undertone_engine::engine::{Engine, OutputSetup};
/// use undertone_engine::graph::LogGraph;
/// use undertone_pattern::control::note;
/// use undertone_sched::{BookOptions, book_window};
///
/// let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default())?;
/// let pattern = note("c3 e3")?;
///
/// // The default tempo is 120 bpm: two seconds a cycle, so the second note starts at 1 s.
/// let booked = book_window(&mut engine, &pattern, 0.0, 2.0, &BookOptions::default())?;
/// assert_eq!(booked.len(), 2);
/// assert_eq!(booked[1].start_time, 1.0);
///
/// // Asking for the same window again books it again: tracking what is booked is the transport's job.
/// let again = book_window(&mut engine, &pattern, 0.0, 2.0, &BookOptions::default())?;
/// assert_eq!(again.len(), 2);
///
/// // Both bpm and cps is an error with the reference's message.
/// let both = BookOptions { bpm: Some(120.0), cps: Some(1.0), ..BookOptions::default() };
/// assert_eq!(
///     book_window(&mut engine, &pattern, 0.0, 1.0, &both).unwrap_err().message(),
///     "Pass either bpm or cps, not both"
/// );
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
pub fn book_window<G: Graph>(
	engine: &mut Engine<G>,
	pattern: &Pattern<ControlMap>,
	t0: f64,
	t1: f64,
	options: &BookOptions,
) -> Result<Vec<Playback>> {
	let cycle_seconds = options.cycle_seconds()?;
	let begin = window_edge(t0, cycle_seconds)?;
	let end = window_edge(t1, cycle_seconds)?;
	book_cycles(
		engine,
		pattern,
		begin,
		end,
		options.start_time,
		cycle_seconds,
		options.gated,
		options.output,
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use undertone_engine::engine::OutputSetup;
	use undertone_engine::graph::LogGraph;
	use undertone_pattern::control::note;

	fn engine() -> Engine<LogGraph> {
		Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default()).unwrap()
	}

	#[test]
	fn a_voice_on_an_edge_belongs_to_the_window_that_starts_there() {
		let pattern = note("c3 e3").unwrap();
		let options = BookOptions {
			bpm: Some(240.0),
			..BookOptions::default()
		};
		let mut engine = engine();
		// The second note starts at 0.5 s, exactly on the shared edge.
		let first = book_window(&mut engine, &pattern, 0.0, 0.5, &options).unwrap();
		let second = book_window(&mut engine, &pattern, 0.5, 1.0, &options).unwrap();
		assert_eq!(first.len(), 1);
		assert_eq!(second.len(), 1);
		assert_eq!(second[0].start_time, 0.5);
	}

	#[test]
	fn a_tail_that_began_before_the_window_is_not_booked_again() {
		let pattern = note("c3").unwrap().slow(2.0).unwrap();
		let mut engine = engine();
		let booked = book_window(&mut engine, &pattern, 1.0, 3.0, &BookOptions::default()).unwrap();
		assert!(booked.is_empty());
	}

	#[test]
	fn an_empty_or_backwards_window_books_nothing() {
		let pattern = note("c3 e3").unwrap();
		let mut engine = engine();
		let options = BookOptions::default();
		assert!(
			book_window(&mut engine, &pattern, 1.0, 1.0, &options)
				.unwrap()
				.is_empty()
		);
		assert!(
			book_window(&mut engine, &pattern, 2.0, 0.0, &options)
				.unwrap()
				.is_empty()
		);
		assert_eq!(engine.voice_count(), 0);
	}

	#[test]
	fn a_window_edge_that_is_not_finite_is_an_error() {
		let pattern = note("c3").unwrap();
		let mut engine = engine();
		for edge in [f64::NAN, f64::INFINITY, 1.0e300] {
			assert!(
				book_window(&mut engine, &pattern, 0.0, edge, &BookOptions::default()).is_err()
			);
		}
	}

	#[test]
	fn the_tempo_errors_carry_the_reference_messages() {
		let pattern = note("c3").unwrap();
		let mut engine = engine();
		let bad = BookOptions {
			bpm: Some(0.0),
			..BookOptions::default()
		};
		assert_eq!(
			book_window(&mut engine, &pattern, 0.0, 1.0, &bad)
				.unwrap_err()
				.message(),
			"bpm must be positive, got 0"
		);
	}

	#[test]
	fn the_default_tempo_is_used_unless_bpm_or_cps_is_given() {
		let pattern = note("c3 e3").unwrap();
		let mut engine = engine();
		let options = BookOptions {
			tempo: Tempo::with_cpm(60.0).unwrap(),
			..BookOptions::default()
		};
		let booked = book_window(&mut engine, &pattern, 0.0, 1.0, &options).unwrap();
		assert_eq!(
			booked.iter().map(|p| p.start_time).collect::<Vec<_>>(),
			[0.0, 0.5]
		);
		let explicit = BookOptions {
			bpm: Some(480.0),
			..options
		};
		let booked = book_window(&mut engine, &pattern, 0.0, 0.5, &explicit).unwrap();
		assert_eq!(
			booked.iter().map(|p| p.start_time).collect::<Vec<_>>(),
			[0.0, 0.25]
		);
	}
}
