// The tempo a scheduler holds: an explicit value in place of the reference's process-wide `setcpm`
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Tempo`], the default tempo a [`Transport`](crate::Transport) holds (decision D-29).
//!
//! The TypeScript's `setcpm()` writes a module-level variable that every later `play()` and `loop()` reads.
//! Rust has no such global: a [`Tempo`] is a plain value that the transport (or any caller of
//! [`book_window`](crate::book_window)) owns, so two transports in one process can run at different tempos
//! and a test never leaks a tempo into the next one. The JavaScript bridge keeps its global `setcpm()` and
//! passes the number in.

use undertone_engine::render::cycle_seconds_for;
use undertone_pattern::Result;
use undertone_pattern::js::number_to_string;

/// The default tempo, in cycles per minute, used by a call that gives neither `bpm` nor `cps`.
///
/// With no default set, that call plays at 120 bpm (two seconds a cycle). An explicit `bpm` or `cps` always
/// wins over the default.
///
/// ```
/// use undertone_sched::Tempo;
///
/// let mut tempo = Tempo::new();
/// assert_eq!(tempo.cycle_seconds(None, None)?, 2.0);
///
/// tempo.set_cpm(60.0)?; // 60 cycles a minute: one second a cycle
/// assert_eq!(tempo.cycle_seconds(None, None)?, 1.0);
/// assert_eq!(tempo.cycle_seconds(Some(480.0), None)?, 0.5, "an explicit bpm wins");
///
/// tempo.reset();
/// assert_eq!(tempo.cycle_seconds(None, None)?, 2.0);
/// # Ok::<(), undertone_pattern::Error>(())
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Tempo {
	default_cpm: Option<f64>,
}

impl Tempo {
	/// A tempo with no default set: 120 bpm.
	pub const fn new() -> Self {
		Self { default_cpm: None }
	}

	/// A tempo whose default is `cycles_per_minute` (`setcpm`).
	///
	/// # Errors
	///
	/// As [`Tempo::set_cpm`].
	pub fn with_cpm(cycles_per_minute: f64) -> Result<Self> {
		let mut tempo = Self::new();
		tempo.set_cpm(cycles_per_minute)?;
		Ok(tempo)
	}

	/// Sets the default tempo in cycles per minute (`setcpm`).
	///
	/// # Errors
	///
	/// Fails with the reference's message `setcpm() must be positive, got …` when the number is not above
	/// zero. Beyond the reference, which would turn an infinite tempo into a zero-length cycle, it also
	/// fails with `setcpm() must be finite, got …` (a deliberate difference, as in
	/// [`cycle_seconds_for`]). A failed call leaves the tempo as it was.
	#[allow(clippy::neg_cmp_op_on_partial_ord)] // `!(x > 0)` is true for NaN, as the reference's check is
	pub fn set_cpm(&mut self, cycles_per_minute: f64) -> Result<()> {
		if !(cycles_per_minute > 0.0) {
			return Err(undertone_pattern::Error::new(format!(
				"setcpm() must be positive, got {}",
				number_to_string(cycles_per_minute)
			)));
		}
		if !cycles_per_minute.is_finite() {
			return Err(undertone_pattern::Error::new(format!(
				"setcpm() must be finite, got {}",
				number_to_string(cycles_per_minute)
			)));
		}
		self.default_cpm = Some(cycles_per_minute);
		Ok(())
	}

	/// Clears the default, restoring the plain 120 bpm (`resetTempo`).
	pub fn reset(&mut self) {
		self.default_cpm = None;
	}

	/// The default tempo in cycles per minute, when one is set.
	pub const fn default_cpm(&self) -> Option<f64> {
		self.default_cpm
	}

	/// The seconds one cycle lasts for a call that gives `bpm` or `cps` (or neither): `cps` wins over the
	/// default, `bpm` likewise, and the default over 120 bpm (`cycleSecondsFor`).
	///
	/// # Errors
	///
	/// As [`cycle_seconds_for`]: both given, or the one given is not positive and finite.
	pub fn cycle_seconds(&self, bpm: Option<f64>, cps: Option<f64>) -> Result<f64> {
		cycle_seconds_for(bpm, cps, self.default_cpm)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rejects_a_cpm_that_is_not_positive_with_the_reference_message() {
		let mut tempo = Tempo::new();
		assert_eq!(
			tempo.set_cpm(0.0).unwrap_err().message(),
			"setcpm() must be positive, got 0"
		);
		assert_eq!(
			tempo.set_cpm(-5.0).unwrap_err().message(),
			"setcpm() must be positive, got -5"
		);
		assert_eq!(
			tempo.set_cpm(f64::NAN).unwrap_err().message(),
			"setcpm() must be positive, got NaN"
		);
		assert_eq!(tempo.default_cpm(), None);
	}

	#[test]
	fn rejects_an_infinite_cpm() {
		let mut tempo = Tempo::new();
		assert_eq!(
			tempo.set_cpm(f64::INFINITY).unwrap_err().message(),
			"setcpm() must be finite, got Infinity"
		);
	}

	#[test]
	fn a_failed_set_leaves_the_tempo() {
		let mut tempo = Tempo::with_cpm(30.0).unwrap();
		assert!(tempo.set_cpm(-1.0).is_err());
		assert_eq!(tempo.default_cpm(), Some(30.0));
	}

	#[test]
	fn two_tempos_are_independent() {
		let slow = Tempo::with_cpm(30.0).unwrap();
		let fast = Tempo::with_cpm(120.0).unwrap();
		assert_eq!(slow.cycle_seconds(None, None).unwrap(), 2.0);
		assert_eq!(fast.cycle_seconds(None, None).unwrap(), 0.5);
	}

	#[test]
	fn cps_and_bpm_convert_and_are_exclusive() {
		let tempo = Tempo::new();
		assert_eq!(tempo.cycle_seconds(None, Some(2.0)).unwrap(), 0.5);
		assert!(
			tempo
				.cycle_seconds(Some(120.0), Some(1.0))
				.unwrap_err()
				.message()
				.contains("either bpm or cps")
		);
		assert_eq!(
			tempo.cycle_seconds(Some(0.0), None).unwrap_err().message(),
			"bpm must be positive, got 0"
		);
	}
}
