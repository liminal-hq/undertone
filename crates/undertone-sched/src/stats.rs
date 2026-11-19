// What a transport counts: ticks, voices, late voices, underruns, and callback time
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Stats`], the counters a [`Transport`](crate::Transport) keeps.
//!
//! The reference has no statistics; they are the part of the audit that a host needs to tell a dropped-out
//! stream from a healthy one. Nothing here reads a wall clock: this crate has no timers, and
//! `std::time::Instant` panics on `wasm32-unknown-unknown`. The durations are the host's, passed to
//! [`Transport::record_callback`](crate::Transport::record_callback).

/// The counters of a [`Transport`](crate::Transport), a snapshot from [`Transport::stats`](crate::Transport::stats).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stats {
	/// How many times the transport was ticked.
	pub ticks: u64,
	/// How many of those ticks booked at least one voice.
	pub booking_ticks: u64,
	/// How many voices were booked in all, by `play` and by loop ticks.
	pub voices_booked: u64,
	/// How many booked voices started before the clock when they were booked, so their attack was clamped:
	/// the look-ahead was too short for the host's tick rate, or the tick came late.
	pub late_voices: u64,
	/// How many onsets a tick skipped, instead of booking them late, because they started more than
	/// [`SchedulerOptions::max_catch_up_seconds`](crate::SchedulerOptions::max_catch_up_seconds) before the
	/// clock (the host was suspended or stalled). Counted exactly for up to 4096 skipped cycles at a time;
	/// beyond that it is a lower bound.
	pub dropped_voices: u64,
	/// How many times the transport read a clock time that was not finite or was earlier than an earlier
	/// reading, and treated it as no time passing.
	pub bad_clock_reads: u64,
	/// How many times a loop's booked material had run out by the time of its next tick: the clock passed the
	/// end of what was booked, and the output went (or would have gone) silent. The host may add its own with
	/// [`Transport::record_underrun`](crate::Transport::record_underrun) for an output-device underrun.
	pub underruns: u64,
	/// How many audio callbacks the host reported ([`Transport::record_callback`](crate::Transport::record_callback)).
	pub callbacks: u64,
	/// The total time of the reported callbacks, in seconds.
	pub callback_seconds_total: f64,
	/// The longest reported callback, in seconds.
	pub callback_seconds_max: f64,
	/// The last reported callback, in seconds.
	pub callback_seconds_last: f64,
	/// The frames the clock had played at the snapshot.
	pub frames_played: u64,
	/// The output latency the clock reported at the snapshot, in seconds.
	pub output_latency: f64,
}

impl Stats {
	/// The mean reported callback time in seconds, or zero before any.
	///
	/// ```
	/// use undertone_sched::Stats;
	/// assert_eq!(Stats::default().callback_seconds_mean(), 0.0);
	/// ```
	pub fn callback_seconds_mean(&self) -> f64 {
		if self.callbacks == 0 {
			0.0
		} else {
			self.callback_seconds_total / self.callbacks as f64
		}
	}
}
