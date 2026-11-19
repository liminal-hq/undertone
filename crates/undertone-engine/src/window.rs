// Planning for booking an offline render in windows: ordering, room-size look-ahead, and the pauses
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The planning half of `bookingWindow` (`src/render.ts`): which voices are booked at which pause of a render.
//!
//! An offline render can book every voice before it starts, or in windows: it pauses a window ahead of each
//! window's first onset, books that window's voices, and resumes. The audio is the same as booking up front; a
//! renderer that processes every node from the moment it is made does far less work this way. The pauses
//! themselves belong to the renderer (a later work package); this module is the pure planning, so any host
//! that can pause a render uses the same plan.
//!
//! - [`check_booking_window`] validates the window: positive, and at least two render quanta (256 frames).
//! - [`sort_booking_order`] puts voices in time order (nudge included), so cut groups choke the voice that
//!   really played before.
//! - [`last_room_sizes`] gives every reverb voice on an orbit the room size the orbit's last booked voice has.
//!   Booked up front, the last size booked on an orbit replaces the impulse response for the whole render;
//!   booked in windows, a later size would replace it only part way through. With this the windowed render
//!   builds the same impulse response, from the same seeded key, once. Only voices the engine will really
//!   book count: a voice it skips (a sample with no buffer) never reaches the bus, so it sets no size.
//! - [`booking_windows`] splits the voices by onset into windows, each booked at a pause a whole window
//!   ahead.

use crate::engine::number_key;
use crate::math::{js_max, js_min};
use crate::params::VoiceParams;
use std::collections::HashMap;
use undertone_pattern::js::number_to_string;
use undertone_pattern::{Error, Result};

/// Frames in one Web Audio render quantum, the unit pause times are quantized to.
pub const RENDER_QUANTUM_FRAMES: usize = 128;

/// The orbit a voice without one sends to.
const DEFAULT_ORBIT: f64 = 0.0;

/// A voice that is ready to play: where it starts and what it sounds like.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingVoice {
	/// Where the voice starts on the render's clock, in seconds (before its nudge).
	pub start_time: f64,
	/// What it sounds like.
	pub params: VoiceParams,
}

/// The voices to book at one pause of the render, and when that pause is.
#[derive(Debug, Clone, PartialEq)]
pub struct BookingWindow {
	/// Seconds on the render's clock; `0` means before the render starts.
	pub suspend_at: f64,
	/// The voices to book at that pause.
	pub voices: Vec<PendingVoice>,
}

/// Checks a `bookingWindow`.
///
/// # Errors
///
/// Fails with the reference's message when the window is not a positive finite number, or covers fewer than
/// two render quanta (256 frames) at `sample_rate`.
///
/// ```
/// use undertone_engine::window::check_booking_window;
/// assert!(check_booking_window(0.5, 1280.0).is_ok());
/// assert_eq!(
///     check_booking_window(0.05, 1280.0).unwrap_err().message(),
///     "bookingWindow must cover at least 256 frames (0.2 s at 1280 Hz), got 0.05"
/// );
/// ```
#[allow(clippy::neg_cmp_op_on_partial_ord)] // `!(x > 0)` is true for NaN, as the reference's check is
pub fn check_booking_window(seconds: f64, sample_rate: f64) -> Result<()> {
	if !(seconds > 0.0) || !seconds.is_finite() {
		return Err(Error::new(format!(
			"bookingWindow must be positive, got {}",
			number_to_string(seconds)
		)));
	}
	let quanta = (2 * RENDER_QUANTUM_FRAMES) as f64;
	if seconds * sample_rate < quanta {
		return Err(Error::new(format!(
			"bookingWindow must cover at least {} frames ({} s at {} Hz), got {}",
			2 * RENDER_QUANTUM_FRAMES,
			number_to_string(quanta / sample_rate),
			number_to_string(sample_rate),
			number_to_string(seconds)
		)));
	}
	Ok(())
}

/// Sorts voices into booking order: by onset with the nudge included, keeping the order of voices that tie.
pub fn sort_booking_order(voices: &mut [PendingVoice]) {
	voices.sort_by(|a, b| {
		let (a, b) = (
			a.start_time + a.params.nudge_time,
			b.start_time + b.params.nudge_time,
		);
		a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
	});
}

fn sends_room(params: &VoiceParams) -> bool {
	params.room_level.is_some_and(|level| level > 0.0)
}

/// Gives every reverb voice on an orbit the room size the orbit's last booked voice has. `skipped` says which
/// voices the engine books nothing for (`Engine::is_voice_skipped`).
pub fn last_room_sizes(
	voices: &[PendingVoice],
	skipped: impl Fn(&VoiceParams) -> bool,
) -> Vec<PendingVoice> {
	let mut last: HashMap<u64, f64> = HashMap::new();
	for voice in voices {
		if sends_room(&voice.params) && !skipped(&voice.params) {
			last.insert(
				number_key(voice.params.orbit.unwrap_or(DEFAULT_ORBIT)),
				voice.params.room_size,
			);
		}
	}
	voices
		.iter()
		.map(|voice| {
			let size = last
				.get(&number_key(voice.params.orbit.unwrap_or(DEFAULT_ORBIT)))
				.copied();
			match size {
				Some(size) if sends_room(&voice.params) && size != voice.params.room_size => {
					let mut voice = voice.clone();
					voice.params.room_size = size;
					voice
				}
				_ => voice.clone(),
			}
		})
		.collect()
}

/// Splits voices, already in booking order, into windows of `seconds` by their onset (nudge included).
///
/// The voices of window `k` are booked at a pause at the start of window `k - 1`, a whole window ahead, so a
/// pause quantized up to the next render quantum still comes before any of them sound. Windows 0 and 1 are
/// booked before the render starts. A pause never falls within two render quanta of the end (`last_pause`, in
/// seconds), where a context would refuse it: voices nudged that late are booked at the last pause before it.
pub fn booking_windows(
	voices: &[PendingVoice],
	seconds: f64,
	last_pause: f64,
) -> Vec<BookingWindow> {
	let last_index = js_max((last_pause / seconds).floor(), 0.0);
	let mut windows: Vec<BookingWindow> = Vec::new();
	for voice in voices {
		let onset = js_max(voice.start_time + voice.params.nudge_time, 0.0);
		let index = js_min(js_max((onset / seconds).floor() - 1.0, 0.0), last_index);
		let suspend_at = index * seconds;
		match windows.last_mut() {
			Some(current) if current.suspend_at == suspend_at => current.voices.push(voice.clone()),
			_ => windows.push(BookingWindow {
				suspend_at,
				voices: vec![voice.clone()],
			}),
		}
	}
	windows
}

#[cfg(test)]
mod tests {
	use super::*;

	fn voice(start_time: f64, orbit: Option<f64>, room_size: f64) -> PendingVoice {
		PendingVoice {
			start_time,
			params: VoiceParams {
				room_level: Some(0.5),
				room_size,
				orbit,
				..VoiceParams::empty()
			},
		}
	}

	#[test]
	fn the_window_must_be_positive() {
		assert_eq!(
			check_booking_window(0.0, 1280.0).unwrap_err().message(),
			"bookingWindow must be positive, got 0"
		);
		assert!(check_booking_window(f64::NAN, 1280.0).is_err());
	}

	#[test]
	fn the_last_room_size_on_an_orbit_wins() {
		let voices = [
			voice(0.0, None, 2.0),
			voice(1.0, Some(1.0), 5.0),
			voice(2.0, None, 8.0),
		];
		let sized = last_room_sizes(&voices, |_| false);
		assert_eq!(
			sized.iter().map(|v| v.params.room_size).collect::<Vec<_>>(),
			[8.0, 5.0, 8.0]
		);
	}

	#[test]
	fn a_skipped_voice_sets_no_room_size() {
		let voices = [voice(0.0, None, 2.0), voice(1.0, None, 8.0)];
		let sized = last_room_sizes(&voices, |p| p.room_size == 8.0);
		assert_eq!(sized[0].params.room_size, 2.0);
	}

	#[test]
	fn voices_are_booked_a_window_ahead() {
		let voices = [
			voice(0.0, None, 3.0),
			voice(0.4, None, 3.0),
			voice(1.2, None, 3.0),
			voice(3.0, None, 3.0),
		];
		let windows = booking_windows(&voices, 1.0, 10.0);
		let pauses: Vec<f64> = windows.iter().map(|w| w.suspend_at).collect();
		assert_eq!(pauses, [0.0, 2.0]);
		assert_eq!(windows[0].voices.len(), 3);
	}

	#[test]
	fn a_late_nudge_is_booked_at_the_last_pause() {
		let voices = [voice(9.0, None, 3.0)];
		let windows = booking_windows(&voices, 1.0, 3.5);
		assert_eq!(windows[0].suspend_at, 3.0);
	}
}
