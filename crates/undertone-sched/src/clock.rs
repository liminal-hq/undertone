// The clock a transport reads: a trait for the host's audio clock, and a deterministic manual clock
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The [`Clock`] a [`Transport`](crate::Transport) reads, and [`ManualClock`], which a test (or an offline
//! host) moves by hand.
//!
//! A clock says where the audio is: how many seconds the output has been running (`ctx.currentTime` in the
//! reference), how many frames it has played, and how long a frame takes to get from the engine to the
//! speakers. A real host implements it over its audio callback (a frame counter the callback bumps, an
//! atomic the scheduler thread reads); the transport only reads.
//!
//! ```
//! use undertone_sched::{Clock, ManualClock};
//!
//! let clock = ManualClock::new(48_000.0);
//! assert_eq!(clock.now(), 0.0);
//!
//! clock.advance(0.5);
//! assert_eq!(clock.now(), 0.5);
//! assert_eq!(clock.frames_played(), 24_000);
//!
//! // Clones are handles on the same clock, so a test can keep one while the transport owns another.
//! let alias = clock.clone();
//! alias.advance(0.25);
//! assert_eq!(clock.now(), 0.75);
//! ```

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Where the host's audio is. The transport reads it and never writes it.
///
/// `now` and `frames_played` agree: `now()` is `frames_played()` divided by the sample rate, up to the host's
/// own granularity (a callback of 512 frames moves both by 512 frames at once). The scheduler books against
/// `now()`; `frames_played()` and `output_latency()` are for the statistics and for a host that wants to
/// turn engine time into what the listener hears.
pub trait Clock {
	/// The time on the graph's clock, in seconds (`ctx.currentTime`). It never goes backwards.
	fn now(&self) -> f64;

	/// How many frames the output has played.
	fn frames_played(&self) -> u64;

	/// How long a frame takes to get from the engine to the speakers, in seconds (`ctx.outputLatency`).
	fn output_latency(&self) -> f64;
}

/// A clock moved by hand, for tests and for hosts that drive time themselves (an offline render).
///
/// Cloning gives another handle on the same clock. The state is atomic, so the clock is `Send` and `Sync`
/// and a callback thread can move it while a scheduler thread reads it.
#[derive(Debug, Clone)]
pub struct ManualClock {
	state: Arc<ManualState>,
}

#[derive(Debug)]
struct ManualState {
	sample_rate: f64,
	/// The seconds, as `f64` bits.
	seconds: AtomicU64,
	/// The output latency, as `f64` bits.
	latency: AtomicU64,
}

impl ManualClock {
	/// A clock at time zero for output at `sample_rate` hertz, which turns seconds into frames.
	pub fn new(sample_rate: f64) -> Self {
		Self {
			state: Arc::new(ManualState {
				sample_rate,
				seconds: AtomicU64::new(0.0_f64.to_bits()),
				latency: AtomicU64::new(0.0_f64.to_bits()),
			}),
		}
	}

	/// Moves the clock to `seconds`. A time before the current one is ignored (a clock never goes backwards).
	pub fn set(&self, seconds: f64) {
		let mut current = self.state.seconds.load(Ordering::Acquire);
		loop {
			if seconds.is_nan() || seconds <= f64::from_bits(current) {
				return;
			}
			match self.state.seconds.compare_exchange_weak(
				current,
				seconds.to_bits(),
				Ordering::AcqRel,
				Ordering::Acquire,
			) {
				Ok(_) => return,
				Err(seen) => current = seen,
			}
		}
	}

	/// Moves the clock forward by `seconds` (a negative or not-a-number step does nothing).
	pub fn advance(&self, seconds: f64) {
		if seconds > 0.0 {
			self.set(self.now() + seconds);
		}
	}

	/// Sets the output latency [`Clock::output_latency`] reports.
	pub fn set_output_latency(&self, seconds: f64) {
		self.state
			.latency
			.store(seconds.to_bits(), Ordering::Release);
	}
}

impl Clock for ManualClock {
	fn now(&self) -> f64 {
		f64::from_bits(self.state.seconds.load(Ordering::Acquire))
	}

	fn frames_played(&self) -> u64 {
		(self.now() * self.state.sample_rate).round() as u64
	}

	fn output_latency(&self) -> f64 {
		f64::from_bits(self.state.latency.load(Ordering::Acquire))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_clock_never_goes_backwards() {
		let clock = ManualClock::new(1000.0);
		clock.set(2.0);
		clock.set(1.0);
		clock.advance(-5.0);
		clock.advance(f64::NAN);
		assert_eq!(clock.now(), 2.0);
		assert_eq!(clock.frames_played(), 2000);
	}

	#[test]
	fn latency_is_reported_as_set() {
		let clock = ManualClock::new(44_100.0);
		assert_eq!(clock.output_latency(), 0.0);
		clock.set_output_latency(0.012);
		assert_eq!(clock.output_latency(), 0.012);
	}

	#[test]
	fn is_send_and_sync() {
		fn needs<T: Send + Sync>() {}
		needs::<ManualClock>();
	}
}
