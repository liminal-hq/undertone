// The AudioParam automation timeline: set, ramps, setTarget, and cancel, evaluated per frame
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The event timeline of one `AudioParam`, as the Web Audio specification describes it.
//!
//! Events are kept in time order (a new event goes after the events with the same time, and replaces an
//! event of the same kind at the same time). The value at a time `t` is found from the last event at or
//! before `t` and the event after it:
//!
//! - **Before the first event** the value is the default; a ramp as the first event starts from the default
//!   at time 0.
//! - **After a set or a ramp** the value holds until the next event, unless the next event is a ramp, which
//!   starts from this event's time and value.
//! - **After a `setTarget`** the value approaches the target exponentially from the value the timeline had
//!   where the target began, until the next event takes over. A ramp that follows a `setTarget` starts from
//!   the target's start time and start value (the specification leaves where such a ramp begins to the
//!   implementation; the curve already travelled is not followed).
//! - **A cancel** drops every event at or after its time at once.
//!
//! An exponential ramp between values of opposite signs, or from zero, holds its start value until its end
//! time, as the specification says.

use crate::math::{exp, pow};

/// What an event does.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
	Set,
	Linear,
	Exponential,
	Target { time_constant: f64 },
}

impl Kind {
	fn same_kind(self, other: Kind) -> bool {
		core::mem::discriminant(&self) == core::mem::discriminant(&other)
	}

	fn is_ramp(self) -> bool {
		matches!(self, Kind::Linear | Kind::Exponential)
	}
}

#[derive(Debug, Clone, Copy)]
struct Event {
	time: f64,
	value: f64,
	kind: Kind,
	/// For a target: the value of the timeline just before the target began.
	start_value: f64,
}

/// The automation of one parameter.
#[derive(Debug, Clone)]
pub(crate) struct Timeline {
	default: f64,
	events: Vec<Event>,
	/// How many events have a time at or before the last time evaluated: a cursor that makes a run of frames
	/// cheap. `usize::MAX` means the timeline changed and it must be found again.
	position: usize,
}

impl Timeline {
	pub(crate) fn new(default: f64) -> Self {
		Self {
			default,
			events: Vec::new(),
			position: usize::MAX,
		}
	}

	/// `setValueAtTime`.
	pub(crate) fn set_value(&mut self, value: f64, time: f64) {
		self.insert(Kind::Set, value, time);
	}

	/// `linearRampToValueAtTime`.
	pub(crate) fn linear_ramp(&mut self, value: f64, time: f64) {
		self.insert(Kind::Linear, value, time);
	}

	/// `exponentialRampToValueAtTime`.
	pub(crate) fn exponential_ramp(&mut self, value: f64, time: f64) {
		self.insert(Kind::Exponential, value, time);
	}

	/// `setTargetAtTime`.
	pub(crate) fn set_target(&mut self, value: f64, time: f64, time_constant: f64) {
		self.insert(Kind::Target { time_constant }, value, time);
	}

	/// `cancelScheduledValues`: drops every event at or after `time`.
	pub(crate) fn cancel(&mut self, time: f64) {
		if time.is_nan() {
			return;
		}
		let keep = self.events.partition_point(|event| event.time < time);
		if keep != self.events.len() {
			self.events.truncate(keep);
			self.position = usize::MAX;
		}
	}

	fn insert(&mut self, kind: Kind, value: f64, time: f64) {
		// A time before the clock starts is the start; a time that is not a number schedules nothing.
		if time.is_nan() || value.is_nan() {
			return;
		}
		let time = if time < 0.0 { 0.0 } else { time };
		let event = Event {
			time,
			value,
			kind,
			start_value: 0.0,
		};
		let after = self.events.partition_point(|other| other.time <= time);
		// An event of the same kind at the same time is replaced.
		if let Some(previous) = after.checked_sub(1)
			&& self.events[previous].time == time
			&& self.events[previous].kind.same_kind(kind)
		{
			self.events[previous] = event;
		} else {
			self.events.insert(after, event);
		}
		self.position = usize::MAX;
		self.refresh_targets();
	}

	/// Works out each target's start value, in order, because a target starts from where the events before it
	/// left the value.
	fn refresh_targets(&mut self) {
		for index in 0..self.events.len() {
			if matches!(self.events[index].kind, Kind::Target { .. }) {
				let time = self.events[index].time;
				let value = self.value_with(index.checked_sub(1), time);
				self.events[index].start_value = value;
			}
		}
	}

	/// The point a following ramp starts from, and the value an event settles at.
	fn anchor(&self, index: Option<usize>) -> (f64, f64) {
		match index {
			None => (0.0, self.default),
			Some(i) => {
				let event = &self.events[i];
				match event.kind {
					Kind::Target { .. } => (event.time, event.start_value),
					_ => (event.time, event.value),
				}
			}
		}
	}

	/// The value at `time` when `current` is the last event at or before it.
	fn value_with(&self, current: Option<usize>, time: f64) -> f64 {
		let next = self.events.get(current.map_or(0, |i| i + 1));
		let (start_time, start_value) = self.anchor(current);
		if let Some(next) = next
			&& next.kind.is_ramp()
		{
			return ramp(
				next.kind,
				start_time,
				start_value,
				next.time,
				next.value,
				time,
			);
		}
		match current.map(|i| &self.events[i]) {
			Some(event) => match event.kind {
				Kind::Target { time_constant } => {
					if time_constant <= 0.0 {
						event.value
					} else {
						event.value
							+ (event.start_value - event.value)
								* exp(-(time - event.time) / time_constant)
					}
				}
				_ => event.value,
			},
			None => self.default,
		}
	}

	/// Finds the cursor for `time`: the number of events at or before it.
	fn seek(&mut self, time: f64) {
		let valid = self.position != usize::MAX
			&& self.position <= self.events.len()
			&& self
				.position
				.checked_sub(1)
				.is_none_or(|last| self.events[last].time <= time)
			&& self
				.events
				.get(self.position)
				.is_none_or(|next| next.time > time);
		if !valid {
			self.position = self.events.partition_point(|event| event.time <= time);
		}
	}

	#[allow(dead_code)] // the compressor's k-rate parameters use it
	/// The value at one time (no cursor use that outlasts the call).
	pub(crate) fn value_at(&mut self, time: f64) -> f64 {
		self.position = usize::MAX;
		self.seek(time);
		self.value_with(self.position.checked_sub(1), time)
	}

	/// Fills `out` with the value at each frame from `first_frame` (frame `i` is at `(first_frame + i) /
	/// sample_rate` seconds). Returns whether the value is the same for the whole run.
	pub(crate) fn fill(&mut self, first_frame: u64, sample_rate: f64, out: &mut [f64]) -> bool {
		let frames = out.len();
		if frames == 0 {
			return true;
		}
		let first = first_frame as f64 / sample_rate;
		let last = (first_frame + frames as u64 - 1) as f64 / sample_rate;
		self.seek(first);
		let current = self.position.checked_sub(1);
		let next = self.events.get(self.position);
		let flat = match (current.map(|i| self.events[i].kind), next) {
			(Some(Kind::Target { .. }), _) => false,
			(_, Some(next)) => next.time > last && !next.kind.is_ramp(),
			(_, None) => true,
		};
		if flat {
			let value = self.value_with(current, first);
			out.fill(value);
			return true;
		}
		for (i, slot) in out.iter_mut().enumerate() {
			let time = (first_frame + i as u64) as f64 / sample_rate;
			while let Some(next) = self.events.get(self.position)
				&& next.time <= time
			{
				self.position += 1;
			}
			*slot = self.value_with(self.position.checked_sub(1), time);
		}
		false
	}
}

fn ramp(kind: Kind, t0: f64, v0: f64, t1: f64, v1: f64, time: f64) -> f64 {
	if t1 <= t0 {
		return v1;
	}
	let progress = (time - t0) / (t1 - t0);
	match kind {
		Kind::Linear => v0 + (v1 - v0) * progress,
		Kind::Exponential => {
			if v0 == 0.0 || v0.is_sign_negative() != v1.is_sign_negative() || v1 == 0.0 {
				v0
			} else {
				v0 * pow(v1 / v0, progress)
			}
		}
		_ => v0,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn at(timeline: &mut Timeline, time: f64) -> f64 {
		timeline.value_at(time)
	}

	#[test]
	fn the_default_holds_with_no_events() {
		let mut timeline = Timeline::new(0.5);
		assert_eq!(at(&mut timeline, 0.0), 0.5);
		assert_eq!(at(&mut timeline, 100.0), 0.5);
	}

	#[test]
	fn a_set_holds_from_its_time() {
		let mut timeline = Timeline::new(1.0);
		timeline.set_value(0.25, 2.0);
		assert_eq!(at(&mut timeline, 1.9), 1.0);
		assert_eq!(at(&mut timeline, 2.0), 0.25);
		assert_eq!(at(&mut timeline, 9.0), 0.25);
	}

	#[test]
	fn a_linear_ramp_runs_from_the_previous_event() {
		let mut timeline = Timeline::new(0.0);
		timeline.set_value(1.0, 1.0);
		timeline.linear_ramp(3.0, 3.0);
		assert_eq!(at(&mut timeline, 0.5), 0.0);
		assert_eq!(at(&mut timeline, 1.0), 1.0);
		assert_eq!(at(&mut timeline, 2.0), 2.0);
		assert_eq!(at(&mut timeline, 3.0), 3.0);
		assert_eq!(at(&mut timeline, 4.0), 3.0);
	}

	#[test]
	fn a_ramp_as_the_first_event_starts_from_the_default_at_zero() {
		let mut timeline = Timeline::new(2.0);
		timeline.linear_ramp(4.0, 2.0);
		assert_eq!(at(&mut timeline, 1.0), 3.0);
	}

	#[test]
	fn an_exponential_ramp_is_geometric() {
		let mut timeline = Timeline::new(1.0);
		timeline.set_value(1.0, 0.0);
		timeline.exponential_ramp(16.0, 4.0);
		assert!((at(&mut timeline, 1.0) - 2.0).abs() < 1e-12);
		assert!((at(&mut timeline, 2.0) - 4.0).abs() < 1e-12);
		assert!((at(&mut timeline, 3.0) - 8.0).abs() < 1e-12);
	}

	#[test]
	fn an_exponential_ramp_from_zero_holds_then_jumps() {
		let mut timeline = Timeline::new(0.0);
		timeline.set_value(0.0, 0.0);
		timeline.exponential_ramp(1.0, 2.0);
		assert_eq!(at(&mut timeline, 1.0), 0.0);
		assert_eq!(at(&mut timeline, 2.0), 1.0);
	}

	#[test]
	fn a_target_approaches_with_its_time_constant() {
		let mut timeline = Timeline::new(0.0);
		timeline.set_value(1.0, 0.0);
		timeline.set_target(0.0, 1.0, 0.5);
		assert_eq!(at(&mut timeline, 0.9), 1.0);
		let one_constant = at(&mut timeline, 1.5);
		assert!(
			(one_constant - (-1.0_f64).exp()).abs() < 1e-12,
			"{one_constant}"
		);
		assert!(at(&mut timeline, 20.0) < 1e-9);
	}

	#[test]
	fn a_set_cuts_a_target_short() {
		let mut timeline = Timeline::new(0.0);
		timeline.set_value(1.0, 0.0);
		timeline.set_target(0.0, 1.0, 1.0);
		timeline.set_value(5.0, 2.0);
		assert!(at(&mut timeline, 1.99) < 1.0);
		assert_eq!(at(&mut timeline, 2.0), 5.0);
	}

	#[test]
	fn a_target_that_follows_a_target_starts_from_where_the_first_had_got_to() {
		let mut timeline = Timeline::new(0.0);
		timeline.set_value(1.0, 0.0);
		timeline.set_target(0.0, 1.0, 1.0);
		timeline.set_target(2.0, 2.0, 1.0);
		let middle = at(&mut timeline, 2.0);
		assert!((middle - (-1.0_f64).exp()).abs() < 1e-12, "{middle}");
	}

	#[test]
	fn cancel_drops_events_at_or_after_its_time() {
		let mut timeline = Timeline::new(0.0);
		timeline.set_value(1.0, 1.0);
		timeline.set_value(2.0, 2.0);
		timeline.linear_ramp(5.0, 4.0);
		timeline.cancel(2.0);
		assert_eq!(at(&mut timeline, 3.0), 1.0);
		assert_eq!(at(&mut timeline, 10.0), 1.0);
	}

	#[test]
	fn an_event_of_the_same_kind_and_time_is_replaced_and_others_follow() {
		let mut timeline = Timeline::new(0.0);
		timeline.set_value(1.0, 1.0);
		timeline.set_value(2.0, 1.0);
		assert_eq!(at(&mut timeline, 1.0), 2.0);
		timeline.linear_ramp(3.0, 1.0);
		timeline.set_value(9.0, 1.0);
		assert_eq!(at(&mut timeline, 1.0), 9.0);
	}

	#[test]
	fn fill_matches_value_at_frame_by_frame() {
		let mut timeline = Timeline::new(0.0);
		timeline.set_value(0.0, 0.0);
		timeline.linear_ramp(1.0, 0.01);
		timeline.set_target(0.2, 0.012, 0.003);
		let mut direct = Timeline::new(0.0);
		direct.set_value(0.0, 0.0);
		direct.linear_ramp(1.0, 0.01);
		direct.set_target(0.2, 0.012, 0.003);
		let rate = 1000.0;
		let mut filled = vec![0.0; 40];
		let flat = timeline.fill(0, rate, &mut filled);
		assert!(!flat);
		for (frame, value) in filled.iter().enumerate() {
			assert_eq!(
				*value,
				direct.value_at(frame as f64 / rate),
				"frame {frame}"
			);
		}
	}

	#[test]
	fn fill_in_pieces_equals_fill_whole() {
		let mut a = Timeline::new(1.0);
		a.set_value(1.0, 0.0);
		a.exponential_ramp(0.01, 0.05);
		let mut b = a.clone();
		let mut whole = vec![0.0; 128];
		a.fill(0, 1000.0, &mut whole);
		let mut pieces = vec![0.0; 128];
		for chunk in 0..16 {
			b.fill(
				chunk * 8,
				1000.0,
				&mut pieces[(chunk as usize) * 8..(chunk as usize) * 8 + 8],
			);
		}
		assert_eq!(whole, pieces);
	}

	#[test]
	fn a_flat_stretch_is_reported_constant() {
		let mut timeline = Timeline::new(0.3);
		let mut out = vec![0.0; 16];
		assert!(timeline.fill(0, 1000.0, &mut out));
		timeline.set_value(0.8, 1.0);
		assert!(timeline.fill(0, 1000.0, &mut out));
		assert!(out.iter().all(|v| *v == 0.3));
		assert!(timeline.fill(1000, 1000.0, &mut out));
		assert!(out.iter().all(|v| *v == 0.8));
	}
}
