// Transport tests: play, loops, tempo, handles, seek, and statistics, ported from src/scheduler.test.ts
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The behaviours of `src/scheduler.test.ts` that are about scheduling logic, against a [`LogGraph`] and a
//! [`ManualClock`] in place of the fake audio context and the fake timer, and the Rust additions (seek,
//! statistics, an explicit tempo per transport).

use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::{GraphRecord, LogGraph};
use undertone_pattern::control::{note, sound};
use undertone_pattern::pattern::stack;
use undertone_pattern::{ControlMap, Fraction, Pattern};
use undertone_sched::{
	Clock, LoopOptions, LoopStop, LoopVoices, ManualClock, PlayOptions, SchedulerOptions, Transport,
};

/// An engine, its transport, and the clock the transport reads (kept in step with the graph's by `advance_to`).
struct Rig {
	engine: Engine<LogGraph>,
	transport: Transport<ManualClock>,
	clock: ManualClock,
}

impl Rig {
	fn new() -> Self {
		let clock = ManualClock::new(48_000.0);
		Self {
			engine: Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default()).unwrap(),
			transport: Transport::new(clock.clone(), SchedulerOptions::default()).unwrap(),
			clock,
		}
	}

	/// Moves the clock, and the graph's, to `seconds`.
	fn advance_to(&mut self, seconds: f64) {
		self.clock.set(seconds);
		self.engine.graph_mut().set_current_time(seconds);
	}

	/// Ticks once and fails the test on an error.
	fn tick(&mut self) {
		self.transport.tick(&mut self.engine).unwrap();
	}

	fn record(&self) -> GraphRecord {
		self.engine.graph().finish(None)
	}

	/// The start time of each oscillator, in creation order (`ctx.oscillators[i].started[0]`).
	fn oscillator_starts(&self) -> Vec<f64> {
		self.record()
			.nodes
			.iter()
			.filter(|node| node.kind == "oscillator")
			.map(|node| node.start[0])
			.collect()
	}

	/// The calls on the first gain's `gain` parameter.
	fn first_gain_calls(&self) -> Vec<String> {
		let record = self.record();
		let gain = record
			.nodes
			.iter()
			.find(|node| node.kind == "gain")
			.unwrap();
		gain.params
			.iter()
			.find(|(name, _)| name == "gain")
			.unwrap()
			.1
			.clone()
	}
}

fn approx(a: f64, b: f64) {
	assert!((a - b).abs() < 1e-9, "{a} != {b}");
}

fn looping(bpm: f64) -> LoopOptions {
	LoopOptions {
		bpm: Some(bpm),
		..LoopOptions::default()
	}
}

fn plain(pattern: Result<Pattern<ControlMap>, undertone_pattern::Error>) -> Pattern<ControlMap> {
	pattern.unwrap()
}

mod play {
	use super::*;

	#[test]
	fn schedules_one_cycle_of_onsets_starting_at_the_clocks_now() {
		let mut rig = Rig::new();
		rig.advance_to(3.0);
		rig.transport
			.play(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&PlayOptions::default(),
			)
			.unwrap();
		assert_eq!(rig.oscillator_starts(), [3.0, 4.0]);
	}

	#[test]
	fn honours_an_explicit_when_and_bpm() {
		let mut rig = Rig::new();
		rig.advance_to(3.0);
		let options = PlayOptions {
			when: Some(10.0),
			bpm: Some(240.0),
			..PlayOptions::default()
		};
		rig.transport
			.play(&mut rig.engine, &plain(note("c3 e3 g3 b3")), &options)
			.unwrap();
		assert_eq!(rig.oscillator_starts(), [10.0, 10.25, 10.5, 10.75]);
	}

	#[test]
	fn plays_chords_and_stacked_layers_polyphonically() {
		let mut rig = Rig::new();
		let pattern = stack(vec![note("[c3,e3,g3]").unwrap(), sound("white").unwrap()]);
		rig.transport
			.play(&mut rig.engine, &pattern, &PlayOptions::default())
			.unwrap();
		let record = rig.record();
		let count = |kind: &str| record.nodes.iter().filter(|n| n.kind == kind).count();
		assert_eq!(count("oscillator"), 3);
		assert_eq!(count("bufferSource"), 1);
		assert!(rig.oscillator_starts().iter().all(|start| *start == 0.0));
	}

	#[test]
	fn respects_each_events_nudge_on_top_of_the_shared_start_time() {
		let mut rig = Rig::new();
		let pattern = stack(vec![
			note("c2").unwrap(),
			note("c6").unwrap().nudge(0.02).unwrap(),
		]);
		let options = PlayOptions {
			when: Some(5.0),
			..PlayOptions::default()
		};
		rig.transport
			.play(&mut rig.engine, &pattern, &options)
			.unwrap();
		assert_eq!(rig.oscillator_starts(), [5.0, 5.02]);
	}

	#[test]
	fn stays_percussive_so_one_shots_sound_exactly_like_the_first_release() {
		let mut rig = Rig::new();
		let pattern = plain(note("c3").and_then(|p| p.sustain(0.5)));
		rig.transport
			.play(&mut rig.engine, &pattern, &PlayOptions::default())
			.unwrap();
		// set 0, ramp to peak, ramp to sustain, ramp to 0: no gate-hold call.
		let calls = rig.first_gain_calls();
		assert_eq!(calls.len(), 4, "{calls:?}");
		assert_eq!(calls.iter().filter(|c| c.starts_with("set ")).count(), 1);
	}

	#[test]
	fn does_not_retrigger_events_whose_tails_cross_into_the_cycle() {
		let mut rig = Rig::new();
		let pattern = plain(note("c3").and_then(|p| p.slow(2.0)));
		rig.transport
			.play(&mut rig.engine, &pattern, &PlayOptions::default())
			.unwrap();
		assert_eq!(rig.oscillator_starts().len(), 1);
	}

	#[test]
	fn rejects_a_non_positive_bpm() {
		let mut rig = Rig::new();
		let options = PlayOptions {
			bpm: Some(0.0),
			..PlayOptions::default()
		};
		let error = rig
			.transport
			.play(&mut rig.engine, &plain(note("c3")), &options)
			.unwrap_err();
		assert!(error.message().contains("bpm must be positive"));
	}

	#[test]
	fn rejects_both_bpm_and_cps() {
		let mut rig = Rig::new();
		let options = PlayOptions {
			bpm: Some(120.0),
			cps: Some(1.0),
			..PlayOptions::default()
		};
		let error = rig
			.transport
			.play(&mut rig.engine, &plain(note("c3")), &options)
			.unwrap_err();
		assert_eq!(error.message(), "Pass either bpm or cps, not both");
	}

	#[test]
	fn holds_each_event_for_its_own_share_of_the_cycle_when_gated() {
		let mut rig = Rig::new();
		// 240 bpm is a 1 s cycle; two events are 0.5 s gates. With sustain 0.5 the envelope holds at 0.4
		// (0.8 default gain * 0.5) until the gate closes.
		let pattern = plain(note("c3 e3").and_then(|p| p.sustain(0.5)));
		let options = PlayOptions {
			when: Some(0.0),
			bpm: Some(240.0),
			gated: true,
			..PlayOptions::default()
		};
		rig.transport
			.play(&mut rig.engine, &pattern, &options)
			.unwrap();
		assert!(rig.first_gain_calls().contains(&"set 0.4 @0.5".to_string()));
	}

	#[test]
	fn an_empty_pattern_gives_an_empty_handle_at_when() {
		let mut rig = Rig::new();
		let options = PlayOptions {
			when: Some(7.0),
			..PlayOptions::default()
		};
		let handle = rig
			.transport
			.play(&mut rig.engine, &plain(note("~")), &options)
			.unwrap();
		assert_eq!(
			(handle.voices(), handle.start_time, handle.end_time),
			(0, 7.0, 7.0)
		);
		handle.stop(&mut rig.engine, None, None); // nothing to stop, and no panic
	}

	#[test]
	fn the_handle_covers_the_earliest_start_and_the_latest_end() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&PlayOptions::default(),
			)
			.unwrap();
		assert_eq!(handle.start_time, 0.0);
		assert!(handle.end_time > 1.0);
	}

	#[test]
	fn stopping_fades_a_sounding_voice_and_silences_one_that_has_not_started() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&PlayOptions::default(),
			)
			.unwrap();
		handle.stop(&mut rig.engine, Some(0.5), Some(0.02));
		handle.stop(&mut rig.engine, Some(0.5), Some(0.02)); // idempotent: the same calls again
		let record = rig.record();
		let gains: Vec<_> = record.nodes.iter().filter(|n| n.kind == "gain").collect();
		assert_eq!(gains.len(), 2);
		let calls_of = |gain: &undertone_engine::graph::NodeRecord| {
			gain.params
				.iter()
				.find(|(name, _)| name == "gain")
				.unwrap()
				.1
				.clone()
		};
		// The first note finished by 0.5 s, so it is untouched.
		assert!(!calls_of(gains[0]).iter().any(|c| c.starts_with("cancel")));
		// The second starts at 1 s: it never sounds, and the stop cancels its envelope.
		let second = calls_of(gains[1]);
		assert!(second.contains(&"cancel @0.5".to_string()), "{second:?}");
		assert!(
			second
				.iter()
				.any(|c| c.starts_with("target 0 @0.5 tau 0.004")),
			"{second:?}"
		);
	}

	#[test]
	fn from_starts_part_way_through_the_cycle() {
		let mut rig = Rig::new();
		let options = PlayOptions {
			when: Some(10.0),
			from: Fraction::new(1, 2),
			..PlayOptions::default()
		};
		// Half a cycle in, the pattern's second note is the first: the cycle [1/2, 3/2) holds it at 10 s and the
		// next cycle's first note, half a cycle (1 s) later.
		rig.transport
			.play(&mut rig.engine, &plain(note("c3 e3")), &options)
			.unwrap();
		assert_eq!(rig.oscillator_starts(), [10.0, 11.0]);
	}
}

mod looping {
	use super::*;

	#[test]
	fn books_the_look_ahead_at_once_then_extends_it_as_the_clock_advances() {
		let mut rig = Rig::new();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		// The first tick covers the look-ahead: the cycle-0 onset, 100 ms out so its attack is not in the past.
		assert_eq!(rig.oscillator_starts(), [0.1]);
		assert_eq!(rig.transport.tick_interval(), 0.1);

		rig.advance_to(1.0);
		rig.tick();
		let starts = rig.oscillator_starts();
		assert_eq!(starts.len(), 2);
		approx(starts[1], 1.1);
	}

	#[test]
	fn gates_each_looped_voice_with_its_events_share_of_the_cycle() {
		let mut rig = Rig::new();
		let pattern = plain(note("c3 e3").and_then(|p| p.sustain(0.5)));
		rig.transport
			.play_loop(&mut rig.engine, &pattern, &looping(240.0))
			.unwrap();
		// 0.1 s of start latency plus the 0.5 s gate.
		assert!(rig.first_gain_calls().contains(&"set 0.4 @0.6".to_string()));
	}

	#[test]
	fn never_schedules_the_same_onset_twice() {
		let mut rig = Rig::new();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		rig.tick();
		rig.tick();
		assert_eq!(rig.oscillator_starts().len(), 1);
	}

	#[test]
	fn keeps_exact_time_across_many_cycles() {
		let mut rig = Rig::new();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("c3 e3 g3")), &looping(240.0))
			.unwrap();
		for step in 0..100 {
			rig.advance_to(f64::from(step) * 0.1);
			rig.tick();
		}
		let starts = rig.oscillator_starts();
		assert!(starts.len() >= 30, "{}", starts.len());
		approx(starts[4], 0.1 + 1.0 + 1.0 / 3.0);
		approx(starts[28], 0.1 + 9.0 + 1.0 / 3.0);
	}

	#[test]
	fn stops_scheduling_when_the_handle_is_stopped() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		assert!(rig.transport.is_running(handle));
		handle
			.stop(&mut rig.transport, &mut rig.engine, &LoopStop::default())
			.unwrap();
		assert!(!rig.transport.is_running(handle));
		assert_eq!(rig.transport.loop_count(), 0);
		rig.advance_to(5.0);
		rig.tick();
		assert_eq!(rig.oscillator_starts().len(), 1);
		// Stopping again, with a handle that is stale, is harmless.
		rig.transport
			.stop_loop(&mut rig.engine, handle, &LoopStop::default())
			.unwrap();
	}

	#[test]
	fn alternation_patterns_unfold_across_looped_cycles() {
		let mut rig = Rig::new();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("<220 440>")), &looping(240.0))
			.unwrap();
		rig.advance_to(1.0);
		rig.tick();
		let record = rig.record();
		let frequencies: Vec<String> = record
			.nodes
			.iter()
			.filter(|n| n.kind == "oscillator")
			.map(|n| {
				n.params
					.iter()
					.find(|(name, _)| name == "frequency")
					.unwrap()
					.1[0]
					.clone()
			})
			.collect();
		assert!(frequencies[0].starts_with("set 220 "), "{frequencies:?}");
		assert!(frequencies[1].starts_with("set 440 "), "{frequencies:?}");
	}

	#[test]
	fn a_ring_stop_leaves_the_booked_voices_alone() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3 e3 g3 b3")),
				&looping(240.0),
			)
			.unwrap();
		rig.transport
			.stop_loop(&mut rig.engine, handle, &LoopStop::default())
			.unwrap();
		let record = rig.record();
		for gain in record.nodes.iter().filter(|n| n.kind == "gain") {
			let calls = &gain
				.params
				.iter()
				.find(|(name, _)| name == "gain")
				.unwrap()
				.1;
			assert!(!calls.iter().any(|c| c.starts_with("cancel")), "{calls:?}");
		}
	}

	#[test]
	fn a_cut_stop_fades_the_booked_voices_including_those_in_the_look_ahead() {
		let mut rig = Rig::new();
		// 240 bpm, four notes a second, time zero at 0.1 s: the first tick books the note at 0.1; at 0.2 s the
		// look-ahead reaches 0.5 s and books the note at 0.35, which has not started.
		let handle = rig
			.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3 e3 g3 b3")),
				&looping(240.0),
			)
			.unwrap();
		assert_eq!(rig.oscillator_starts().len(), 1);
		rig.advance_to(0.2);
		rig.tick();
		approx(rig.oscillator_starts()[1], 0.35);
		let stop = LoopStop {
			voices: LoopVoices::Cut,
			fade: Some(0.02),
		};
		rig.transport
			.stop_loop(&mut rig.engine, handle, &stop)
			.unwrap();
		let record = rig.record();
		let gains: Vec<_> = record.nodes.iter().filter(|n| n.kind == "gain").collect();
		assert_eq!(gains.len(), 2);
		for gain in gains {
			let calls = &gain
				.params
				.iter()
				.find(|(name, _)| name == "gain")
				.unwrap()
				.1;
			assert!(calls.contains(&"cancel @0.2".to_string()), "{calls:?}");
			assert!(
				calls
					.iter()
					.any(|c| c.starts_with("target 0 @0.2 tau 0.004")),
				"{calls:?}"
			);
		}
	}

	#[test]
	fn a_loop_without_a_tempo_takes_the_transports_tempo_once_when_it_starts() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(60.0).unwrap(); // a 1 s cycle
		rig.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&LoopOptions::default(),
			)
			.unwrap();
		// A later change does not reach it (the reference reads the tempo when `loop()` is called).
		rig.transport.set_cpm(30.0).unwrap();
		rig.advance_to(1.0);
		rig.tick();
		let starts = rig.oscillator_starts();
		approx(starts[0], 0.1);
		approx(starts[1], 0.6);
		approx(starts[2], 1.1);
	}

	#[test]
	fn a_following_loop_changes_tempo_at_the_next_tick_without_a_jump() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(60.0).unwrap(); // a 1 s cycle
		let options = LoopOptions {
			follow_tempo: true,
			..LoopOptions::default()
		};
		let handle = rig
			.transport
			.play_loop(&mut rig.engine, &plain(note("c3 e3")), &options)
			.unwrap();
		// Booked up to 0.3 s past the clock at 0.1 start: cycles up to 0.2 s, so notes at 0.1 only.
		assert_eq!(rig.oscillator_starts().len(), 1);
		let booked_until = rig.transport.scheduled_until(handle).unwrap();

		rig.transport.set_cpm(120.0).unwrap(); // a 0.5 s cycle from here on
		rig.advance_to(0.3);
		rig.tick();
		// Pattern time continues from where it was booked to: the 0.5-cycle note after `booked_until` is
		// at 0.1 + booked_until * 1 s (where the old tempo put that position), then 0.25 s apart.
		let starts = rig.oscillator_starts();
		let anchor = 0.1 + booked_until.to_f64();
		let second = starts[1];
		assert!(second >= anchor - 1e-9, "{second} before {anchor}");
		for pair in starts.windows(2).skip(1) {
			approx(pair[1] - pair[0], 0.25);
		}
	}

	#[test]
	fn two_transports_hold_their_own_tempo() {
		let mut a = Rig::new();
		let mut b = Rig::new();
		a.transport.set_cpm(60.0).unwrap();
		b.transport.set_cpm(120.0).unwrap();
		let options = PlayOptions {
			when: Some(0.0),
			..PlayOptions::default()
		};
		a.transport
			.play(&mut a.engine, &plain(note("c3 e3")), &options)
			.unwrap();
		b.transport
			.play(&mut b.engine, &plain(note("c3 e3")), &options)
			.unwrap();
		assert_eq!(a.oscillator_starts(), [0.0, 0.5]);
		assert_eq!(b.oscillator_starts(), [0.0, 0.25]);
	}

	#[test]
	fn a_handle_from_another_transport_does_nothing() {
		let mut a = Rig::new();
		let mut b = Rig::new();
		let from_a = a
			.transport
			.play_loop(&mut a.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		b.transport
			.play_loop(&mut b.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		b.transport
			.stop_loop(&mut b.engine, from_a, &LoopStop::default())
			.unwrap();
		assert_eq!(b.transport.loop_count(), 1);
		assert!(a.transport.is_running(from_a));
	}

	#[test]
	fn a_stopped_loops_slot_is_reused_without_the_old_handle_reaching_it() {
		let mut rig = Rig::new();
		let first = rig
			.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		rig.transport
			.stop_loop(&mut rig.engine, first, &LoopStop::default())
			.unwrap();
		let second = rig
			.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		rig.transport
			.stop_loop(&mut rig.engine, first, &LoopStop::default())
			.unwrap();
		assert!(rig.transport.is_running(second));
	}

	#[test]
	fn an_invalid_tempo_starts_no_loop() {
		let mut rig = Rig::new();
		let error = rig
			.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(0.0))
			.unwrap_err();
		assert!(error.message().contains("bpm must be positive"));
		assert_eq!(rig.transport.loop_count(), 0);
	}

	#[test]
	fn several_loops_run_side_by_side() {
		let mut rig = Rig::new();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("e3*2")), &looping(240.0))
			.unwrap();
		rig.advance_to(1.0);
		let report = rig.transport.tick(&mut rig.engine).unwrap();
		assert_eq!(report.loops, 2);
		assert!(report.booked >= 2);
	}
}

mod seek {
	use super::*;

	#[test]
	fn repositions_the_loop_and_cuts_what_was_booked() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3 e3 g3 b3")),
				&looping(240.0),
			)
			.unwrap();
		assert_eq!(rig.oscillator_starts().len(), 1);

		// Jump half a cycle in, sounding at 0.2 s: the third note starts at 0.2.
		assert!(
			rig.transport
				.seek(&mut rig.engine, handle, Fraction::new(1, 2), Some(0.2))
				.unwrap()
		);
		let starts = rig.oscillator_starts();
		approx(starts[1], 0.2);
		// The earlier voices were cut at 0.2 with the cut-group fade of 5 ms (time constant 1 ms).
		let record = rig.record();
		let first_gain = record.nodes.iter().find(|n| n.kind == "gain").unwrap();
		let calls = &first_gain
			.params
			.iter()
			.find(|(name, _)| name == "gain")
			.unwrap()
			.1;
		assert!(calls.contains(&"cancel @0.2".to_string()), "{calls:?}");
		assert!(
			calls
				.iter()
				.any(|c| c.starts_with("target 0 @0.2 tau 0.001")),
			"{calls:?}"
		);
	}

	/// The calls on the `gain` parameter of every gain node, in creation order.
	fn gain_calls(rig: &Rig) -> Vec<Vec<String>> {
		rig.record()
			.nodes
			.iter()
			.filter(|n| n.kind == "gain")
			.map(|n| {
				n.params
					.iter()
					.find(|(name, _)| name == "gain")
					.unwrap()
					.1
					.clone()
			})
			.collect()
	}

	#[test]
	fn a_cut_stop_still_fades_what_a_seek_to_a_future_time_had_scheduled_to_stop() {
		let mut rig = Rig::new();
		// A cycle is 8 s at 30 bpm, so the one note is long.
		let handle = rig
			.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3").and_then(|p| p.release(20.0))),
				&looping(30.0),
			)
			.unwrap();
		// Seek to a time 5 s ahead: the booked note is scheduled to stop then.
		rig.transport
			.seek(&mut rig.engine, handle, Fraction::from_int(0), Some(5.0))
			.unwrap();
		// Stopping the loop with a cut at 1 s must fade it there, not leave it to sound until 5 s.
		rig.advance_to(1.0);
		rig.transport
			.stop_loop(
				&mut rig.engine,
				handle,
				&LoopStop {
					voices: LoopVoices::Cut,
					fade: None,
				},
			)
			.unwrap();
		for (i, calls) in gain_calls(&rig).iter().enumerate() {
			assert!(
				calls.contains(&"cancel @1".to_string()),
				"voice {i} was not cut at 1 s: {calls:?}"
			);
		}
	}

	#[test]
	fn two_seeks_into_the_future_leave_every_voice_reachable_by_a_cut() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3").and_then(|p| p.release(20.0))),
				&looping(30.0),
			)
			.unwrap();
		for when in [5.0, 6.0] {
			rig.transport
				.seek(&mut rig.engine, handle, Fraction::from_int(0), Some(when))
				.unwrap();
		}
		rig.advance_to(1.0);
		rig.transport
			.stop_loop(
				&mut rig.engine,
				handle,
				&LoopStop {
					voices: LoopVoices::Cut,
					fade: None,
				},
			)
			.unwrap();
		let all = gain_calls(&rig);
		assert_eq!(all.len(), 1, "nothing is booked until the clock nears 5 s");
		for (i, calls) in all.iter().enumerate() {
			assert!(
				calls.contains(&"cancel @1".to_string()),
				"voice {i} was not cut at 1 s: {calls:?}"
			);
		}
	}

	#[test]
	fn a_cut_does_not_reopen_a_voice_a_seek_already_faded() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3").and_then(|p| p.release(20.0))),
				&looping(30.0),
			)
			.unwrap();
		rig.transport
			.seek(&mut rig.engine, handle, Fraction::from_int(0), Some(0.5))
			.unwrap();
		rig.advance_to(2.0);
		rig.tick();
		rig.transport
			.stop_loop(
				&mut rig.engine,
				handle,
				&LoopStop {
					voices: LoopVoices::Cut,
					fade: None,
				},
			)
			.unwrap();
		// The first voice was stopped at 0.5 s; a cut at 2 s must not schedule a new level for it.
		let first = &gain_calls(&rig)[0];
		assert!(!first.contains(&"cancel @2".to_string()), "{first:?}");
	}

	#[test]
	fn defaults_to_now_plus_the_start_latency() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play_loop(&mut rig.engine, &plain(note("c3 e3")), &looping(240.0))
			.unwrap();
		rig.advance_to(2.0);
		assert!(
			rig.transport
				.seek(&mut rig.engine, handle, Fraction::from_int(0), None)
				.unwrap()
		);
		let starts = rig.oscillator_starts();
		approx(*starts.last().unwrap(), 2.1);
	}

	#[test]
	fn a_stopped_loop_cannot_be_moved() {
		let mut rig = Rig::new();
		let handle = rig
			.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		rig.transport
			.stop_loop(&mut rig.engine, handle, &LoopStop::default())
			.unwrap();
		assert!(
			!rig.transport
				.seek(&mut rig.engine, handle, Fraction::from_int(0), None)
				.unwrap()
		);
	}
}

mod stats {
	use super::*;

	#[test]
	fn counts_ticks_and_voices_booked() {
		let mut rig = Rig::new();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
			.unwrap();
		for step in 1..=20 {
			rig.advance_to(f64::from(step) * 0.1);
			rig.tick();
		}
		let stats = rig.transport.stats();
		assert_eq!(stats.ticks, 20);
		assert_eq!(stats.voices_booked, 3, "cycles 0, 1, and 2 in two seconds");
		assert_eq!(
			stats.booking_ticks, 2,
			"the ticks that reached cycles 1 and 2"
		);
		assert_eq!((stats.late_voices, stats.underruns), (0, 0));
		assert_eq!(stats.frames_played, 96_000);
	}

	#[test]
	fn a_stalled_host_is_an_underrun_and_its_voices_are_late() {
		let mut rig = Rig::new();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("c3*4")), &looping(240.0))
			.unwrap();
		// The host stops ticking for three seconds: the booked 0.4 s ran out long ago.
		rig.advance_to(3.0);
		rig.tick();
		let stats = rig.transport.stats();
		assert_eq!(stats.underruns, 1);
		assert!(stats.late_voices >= 8, "{stats:?}");
		// Back on time: the next ticks are healthy.
		for step in 1..=5 {
			rig.advance_to(3.0 + f64::from(step) * 0.1);
			rig.tick();
		}
		assert_eq!(rig.transport.stats().underruns, 1);
	}

	#[test]
	fn a_one_shot_in_the_past_counts_its_late_voices() {
		let mut rig = Rig::new();
		rig.advance_to(5.0);
		let options = PlayOptions {
			when: Some(3.0), // the notes start at 3 s and 4 s, both before the clock at 5 s
			..PlayOptions::default()
		};
		rig.transport
			.play(&mut rig.engine, &plain(note("c3 e3")), &options)
			.unwrap();
		assert_eq!(rig.transport.stats().late_voices, 2);
	}

	#[test]
	fn records_callback_time_and_the_hosts_underruns() {
		let mut rig = Rig::new();
		rig.transport.record_callback(0.001);
		rig.transport.record_callback(0.003);
		rig.transport.record_callback(f64::NAN);
		rig.transport.record_callback(-1.0);
		rig.transport.record_underrun();
		rig.clock.set_output_latency(0.02);
		let stats = rig.transport.stats();
		assert_eq!(stats.callbacks, 2);
		approx(stats.callback_seconds_total, 0.004);
		approx(stats.callback_seconds_max, 0.003);
		approx(stats.callback_seconds_last, 0.003);
		approx(stats.callback_seconds_mean(), 0.002);
		assert_eq!(stats.underruns, 1);
		assert_eq!(stats.output_latency, 0.02);
		rig.transport.reset_stats();
		assert_eq!(rig.transport.stats().callbacks, 0);
	}
}

mod options {
	use super::*;

	#[test]
	fn the_defaults_are_the_references() {
		let options = SchedulerOptions::default();
		assert_eq!(options.look_ahead, 0.3);
		assert_eq!(options.tick_interval, 0.1);
		assert_eq!(options.start_latency, 0.1);
		options.validate().unwrap();
	}

	#[test]
	fn invalid_options_are_refused() {
		let clock = ManualClock::new(48_000.0);
		for bad in [
			SchedulerOptions {
				look_ahead: 0.0,
				..SchedulerOptions::default()
			},
			SchedulerOptions {
				tick_interval: f64::NAN,
				..SchedulerOptions::default()
			},
			SchedulerOptions {
				start_latency: -1.0,
				..SchedulerOptions::default()
			},
		] {
			assert!(Transport::new(clock.clone(), bad).is_err(), "{bad:?}");
		}
	}

	#[test]
	fn a_longer_look_ahead_books_further_ahead() {
		let clock = ManualClock::new(48_000.0);
		let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default()).unwrap();
		let options = SchedulerOptions {
			look_ahead: 2.0,
			..SchedulerOptions::default()
		};
		let mut transport = Transport::new(clock.clone(), options).unwrap();
		transport
			.play_loop(&mut engine, &plain(note("c3*4")), &looping(240.0))
			.unwrap();
		let record = engine.graph().finish(None);
		let oscillators = record
			.nodes
			.iter()
			.filter(|n| n.kind == "oscillator")
			.count();
		assert_eq!(oscillators, 8, "two seconds of four notes a second");
		assert_eq!(clock.now(), 0.0);
	}
}

mod clock_jumps {
	use super::*;
	use std::cell::Cell;
	use std::rc::Rc;

	/// A clock a test can set to anything, including a time before the last one or a number that is not one.
	#[derive(Clone)]
	struct WildClock(Rc<Cell<f64>>);

	impl Clock for WildClock {
		fn now(&self) -> f64 {
			self.0.get()
		}
		fn frames_played(&self) -> u64 {
			0
		}
		fn output_latency(&self) -> f64 {
			0.0
		}
	}

	#[test]
	fn a_forward_jump_does_not_book_every_onset_it_missed() {
		let mut rig = Rig::new();
		// One note every 2 s (120 bpm), looped.
		let handle = rig
			.transport
			.play_loop(&mut rig.engine, &plain(note("c3")), &looping(120.0))
			.unwrap();
		// The host was suspended for a thousand seconds.
		rig.advance_to(1000.0);
		let report = rig.transport.tick(&mut rig.engine).unwrap();
		assert!(
			report.booked <= 8,
			"booked {} voices in one tick",
			report.booked
		);
		assert!(
			rig.engine.voice_count() <= 10,
			"{}",
			rig.engine.voice_count()
		);
		// The loop is positioned at the new horizon, not left a thousand seconds behind.
		let until = rig.transport.scheduled_until(handle).unwrap().to_f64();
		assert!(until > 499.0, "scheduled only to cycle {until}");
		// Every onset is either booked (the first when the loop started) or counted as dropped: 501 notes
		// start before 1000.3 s.
		let stats = rig.transport.stats();
		assert_eq!(stats.voices_booked + stats.dropped_voices, 501, "{stats:?}");
		assert!(stats.dropped_voices >= 490, "{stats:?}");
		assert!(stats.late_voices <= 4, "{stats:?}");
	}

	#[test]
	fn a_short_stall_still_books_what_it_missed_as_the_reference_does() {
		let mut rig = Rig::new();
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("c3*4")), &looping(240.0))
			.unwrap();
		rig.advance_to(3.0);
		rig.tick();
		let stats = rig.transport.stats();
		assert_eq!(stats.dropped_voices, 0);
		assert!(stats.late_voices >= 8, "{stats:?}");
	}

	#[test]
	fn the_catch_up_bound_is_an_option_and_zero_skips_everything_already_past() {
		let clock = ManualClock::new(48_000.0);
		let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default()).unwrap();
		let options = SchedulerOptions {
			max_catch_up_seconds: 0.0,
			..SchedulerOptions::default()
		};
		let mut transport = Transport::new(clock.clone(), options).unwrap();
		transport
			.play_loop(&mut engine, &plain(note("c3*4")), &looping(240.0))
			.unwrap();
		clock.set(3.0);
		engine.graph_mut().set_current_time(3.0);
		transport.tick(&mut engine).unwrap();
		let stats = transport.stats();
		assert_eq!(stats.late_voices, 0, "{stats:?}");
		assert!(stats.dropped_voices >= 8, "{stats:?}");
		for bad in [-1.0, f64::NAN, f64::INFINITY] {
			let options = SchedulerOptions {
				max_catch_up_seconds: bad,
				..SchedulerOptions::default()
			};
			assert!(Transport::new(ManualClock::new(48_000.0), options).is_err());
		}
	}

	#[test]
	fn a_clock_that_goes_backwards_or_is_not_a_number_books_nothing_and_does_not_panic() {
		let cell = Rc::new(Cell::new(10.0));
		let clock = WildClock(cell.clone());
		let mut engine = Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default()).unwrap();
		let mut transport = Transport::new(clock, SchedulerOptions::default()).unwrap();
		transport
			.play_loop(&mut engine, &plain(note("c3")), &looping(120.0))
			.unwrap();
		for bad in [5.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -3.0] {
			cell.set(bad);
			let report = transport.tick(&mut engine).unwrap();
			assert_eq!(report.booked, 0, "a clock reading {bad} booked voices");
		}
		assert_eq!(transport.stats().bad_clock_reads, 5);
		// Once the clock is back to sensible, ticking carries on.
		cell.set(12.0);
		assert!(transport.tick(&mut engine).is_ok());
	}
}

/// Extreme numbers at every public entry: each is an error or a harmless call, never a panic.
mod extremes {
	use super::*;
	use undertone_sched::{BookOptions, book_cycles, book_window, window_edge};

	fn huge_fractions() -> Vec<Fraction> {
		vec![
			Fraction::from_int(i128::MAX),
			Fraction::from_int(-i128::MAX),
			Fraction::new(i128::MAX, 3),
			Fraction::new(1, i128::MAX),
			Fraction::new(i128::MAX - 1, i128::MAX),
			Fraction::from_int(1_000_000_000_000),
		]
	}

	#[test]
	fn play_from_a_huge_cycle_is_an_error() {
		for from in huge_fractions() {
			let mut rig = Rig::new();
			let options = PlayOptions {
				from,
				..PlayOptions::default()
			};
			let result = rig
				.transport
				.play(&mut rig.engine, &plain(note("c3")), &options);
			assert!(result.is_err(), "from {from:?} gave {result:?}");
		}
	}

	#[test]
	fn seek_to_a_huge_cycle_is_an_error_and_leaves_the_loop_alone() {
		for from in huge_fractions() {
			let mut rig = Rig::new();
			let handle = rig
				.transport
				.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
				.unwrap();
			let before = rig.transport.scheduled_until(handle);
			assert!(
				rig.transport
					.seek(&mut rig.engine, handle, from, None)
					.is_err()
			);
			assert_eq!(rig.transport.scheduled_until(handle), before);
			assert!(rig.transport.is_running(handle));
		}
	}

	#[test]
	fn book_cycles_with_huge_edges_is_an_error() {
		let mut rig = Rig::new();
		let pattern = plain(note("c3"));
		for edge in huge_fractions() {
			for (begin, end) in [
				(Fraction::from_int(0), edge),
				(edge, Fraction::from_int(0)),
				(edge, edge),
			] {
				let result =
					book_cycles(&mut rig.engine, &pattern, begin, end, 0.0, 1.0, true, None);
				// An empty window books nothing and is not an error; any other huge one is.
				assert!(
					result.is_err() || end <= begin,
					"{begin:?}..{end:?} gave {result:?}"
				);
			}
		}
		assert_eq!(rig.engine.voice_count(), 0);
	}

	#[test]
	fn a_window_wider_than_the_span_bound_is_an_error_without_querying_it() {
		let mut rig = Rig::new();
		let pattern = plain(note("c3"));
		let wide = Fraction::from_int(undertone_sched::MAX_WINDOW_SPAN_CYCLES + 1);
		let result = book_cycles(
			&mut rig.engine,
			&pattern,
			Fraction::from_int(0),
			wide,
			0.0,
			1.0,
			true,
			None,
		);
		assert!(result.is_err());
		assert_eq!(rig.engine.voice_count(), 0);
		// The bound itself is allowed (a sparse pattern keeps this cheap).
		let sparse = plain(note("c3").and_then(|p| p.slow(2_000_000.0)));
		assert!(
			book_cycles(
				&mut rig.engine,
				&sparse,
				Fraction::from_int(0),
				Fraction::from_int(undertone_sched::MAX_WINDOW_SPAN_CYCLES),
				0.0,
				1.0,
				true,
				None
			)
			.is_ok()
		);
	}

	#[test]
	fn times_that_are_not_finite_are_errors() {
		for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
			let mut rig = Rig::new();
			let options = PlayOptions {
				when: Some(bad),
				..PlayOptions::default()
			};
			assert!(
				rig.transport
					.play(&mut rig.engine, &plain(note("c3")), &options)
					.is_err(),
				"when {bad}"
			);
			let handle = rig
				.transport
				.play_loop(&mut rig.engine, &plain(note("c3")), &looping(240.0))
				.unwrap();
			assert!(
				rig.transport
					.seek(&mut rig.engine, handle, Fraction::from_int(0), Some(bad))
					.is_err(),
				"seek when {bad}"
			);
			assert!(rig.transport.is_running(handle));
			// A fade that is not a number is a plain stop, not a failure.
			rig.transport
				.stop_loop(
					&mut rig.engine,
					handle,
					&LoopStop {
						voices: LoopVoices::Cut,
						fade: Some(bad),
					},
				)
				.unwrap();
		}
	}

	#[test]
	fn extreme_tempos_are_errors_or_play_without_panicking() {
		for bpm in [1e-300, 1e-320, f64::MAX, f64::MIN_POSITIVE, 1e300] {
			let mut rig = Rig::new();
			let _ = rig.transport.play(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&PlayOptions {
					bpm: Some(bpm),
					..PlayOptions::default()
				},
			);
			let _ = rig
				.transport
				.play_loop(&mut rig.engine, &plain(note("c3 e3")), &looping(bpm));
			rig.advance_to(1.0);
			let _ = rig.transport.tick(&mut rig.engine);
			let _ = book_window(
				&mut rig.engine,
				&plain(note("c3")),
				0.0,
				1.0,
				&BookOptions {
					bpm: Some(bpm),
					..BookOptions::default()
				},
			);
		}
	}

	#[test]
	fn extreme_scheduler_options_do_not_panic() {
		for value in [1e300, f64::MAX, 1e-300] {
			let clock = ManualClock::new(48_000.0);
			let options = SchedulerOptions {
				look_ahead: value,
				start_latency: value,
				max_catch_up_seconds: value,
				tick_interval: value,
			};
			let mut engine =
				Engine::new(LogGraph::new(48_000.0, 2), OutputSetup::default()).unwrap();
			let mut transport = Transport::new(clock.clone(), options).unwrap();
			let _ = transport.play_loop(&mut engine, &plain(note("c3")), &looping(240.0));
			clock.set(10.0);
			let _ = transport.tick(&mut engine);
		}
	}

	#[test]
	fn a_window_edge_needs_a_positive_finite_cycle_length() {
		for cycle in [f64::INFINITY, -1.0, 0.0, -0.0, f64::NAN, f64::NEG_INFINITY] {
			assert!(
				window_edge(1.0, cycle).is_err(),
				"cycle length {cycle} was accepted"
			);
		}
		assert!(window_edge(1.0, 2.0).is_ok());
	}

	#[test]
	fn book_cycles_needs_a_positive_finite_cycle_length_and_start() {
		let mut rig = Rig::new();
		let pattern = plain(note("c3"));
		let (begin, end) = (Fraction::from_int(0), Fraction::from_int(1));
		for cycle in [f64::INFINITY, -1.0, 0.0, f64::NAN] {
			assert!(
				book_cycles(
					&mut rig.engine,
					&pattern,
					begin,
					end,
					0.0,
					cycle,
					true,
					None
				)
				.is_err(),
				"cycle length {cycle}"
			);
		}
		for start in [f64::INFINITY, f64::NAN] {
			assert!(
				book_cycles(
					&mut rig.engine,
					&pattern,
					begin,
					end,
					start,
					1.0,
					true,
					None
				)
				.is_err(),
				"start {start}"
			);
		}
		assert_eq!(rig.engine.voice_count(), 0);
	}
}

/// D-33: a running loop follows tempo changes unless an explicit `bpm` or `cps` pins it. Ported from the
/// TypeScript's "a running loop and tempo changes" tests.
mod following {
	use super::*;

	/// Ticks every 0.1 s from the clock's now up to `until`.
	fn run(rig: &mut Rig, until: f64) {
		let mut t = rig.clock.now();
		while t <= until + 1e-9 {
			rig.advance_to(t);
			rig.tick();
			t += 0.1;
		}
	}

	/// Four onsets per cycle, so every cycle length gives distinct start times.
	fn start_loop(rig: &mut Rig, options: LoopOptions) {
		rig.transport
			.play_loop(&mut rig.engine, &plain(note("c3 e3 g3 b3")), &options)
			.unwrap();
	}

	fn assert_distinct_and_gaps_between(times: &[f64], low: f64, high: f64) {
		for pair in times.windows(2) {
			let gap = pair[1] - pair[0];
			assert!(
				gap > low - 1e-9 && gap < high + 1e-9,
				"gap {gap} in {times:?}"
			);
		}
		let mut keys: Vec<String> = times.iter().map(|t| format!("{t:.6}")).collect();
		keys.dedup();
		assert_eq!(keys.len(), times.len(), "doubled onsets in {times:?}");
	}

	#[test]
	fn follows_a_faster_tempo_with_no_gap_or_overlap() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(30.0).unwrap(); // 2 s cycles, steps 0.5 s apart
		start_loop(&mut rig, LoopOptions::default());
		run(&mut rig, 1.0);
		rig.transport.set_cpm(60.0).unwrap(); // 1 s cycles, steps 0.25 s apart
		run(&mut rig, 3.0);
		let times = rig.oscillator_starts();
		assert!(times.windows(2).any(|p| p[1] - p[0] < 0.4), "{times:?}");
		assert_distinct_and_gaps_between(&times, 0.25, 0.5);
		approx(times[times.len() - 1] - times[times.len() - 2], 0.25);
	}

	#[test]
	fn follows_a_slower_tempo_with_no_gap_or_overlap() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(60.0).unwrap();
		start_loop(&mut rig, LoopOptions::default());
		run(&mut rig, 1.0);
		rig.transport.set_cpm(30.0).unwrap();
		run(&mut rig, 4.0);
		let times = rig.oscillator_starts();
		assert_distinct_and_gaps_between(&times, 0.25, 0.5);
		approx(times[times.len() - 1] - times[times.len() - 2], 0.5);
	}

	#[test]
	fn keeps_booked_voices_and_continues_from_the_end_of_them() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(30.0).unwrap(); // 2 s cycles
		rig.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&LoopOptions::default(),
			)
			.unwrap();
		rig.advance_to(0.85);
		rig.tick(); // books the onset at 1.1, inside the look-ahead
		let booked = rig.oscillator_starts();
		assert_eq!(booked.len(), 2);
		approx(booked[1], 1.1);

		rig.transport.set_cpm(60.0).unwrap(); // 1 s cycles: onsets 0.5 s apart
		// The window booked so far ends at the grid point just under cycle 0.525, the anchor.
		let anchor = 5291.0 / 10080.0;
		let anchor_time = 0.1 + anchor * 2.0;
		rig.advance_to(1.9);
		rig.tick();
		rig.advance_to(2.9);
		rig.tick();
		let after = rig.oscillator_starts();
		assert_eq!(after[..2], booked[..]);
		approx(after[2], anchor_time + (1.0 - anchor));
		approx(after[3], anchor_time + (1.5 - anchor));
	}

	#[test]
	fn handles_a_change_between_ticks_and_several_in_a_row() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(60.0).unwrap();
		start_loop(&mut rig, LoopOptions::default());
		run(&mut rig, 0.5);
		rig.transport.set_cpm(120.0).unwrap();
		rig.transport.set_cpm(15.0).unwrap(); // only the last value before the next tick counts
		let t = rig.clock.now() + 0.1;
		rig.advance_to(t);
		run(&mut rig, 4.0);
		let times = rig.oscillator_starts();
		assert_distinct_and_gaps_between(&times, 0.25, 1.0);
		approx(times[times.len() - 1] - times[times.len() - 2], 1.0);
	}

	#[test]
	fn follows_reset_tempo_back_to_the_default() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(60.0).unwrap();
		rig.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&LoopOptions::default(),
			)
			.unwrap();
		run(&mut rig, 1.0);
		rig.transport.reset_tempo(); // 2 s cycles, onsets 1 s apart
		run(&mut rig, 5.0);
		let times = rig.oscillator_starts();
		approx(times[times.len() - 1] - times[times.len() - 2], 1.0);
		assert_distinct_and_gaps_between(&times, 0.5, 1.0);
	}

	#[test]
	fn an_explicit_bpm_or_cps_pins_the_loops_tempo() {
		for explicit in [(Some(120.0), None), (None, Some(0.5))] {
			let mut rig = Rig::new();
			let options = LoopOptions {
				bpm: explicit.0,
				cps: explicit.1,
				..LoopOptions::default()
			};
			rig.transport
				.play_loop(&mut rig.engine, &plain(note("c3 e3")), &options)
				.unwrap();
			run(&mut rig, 1.0);
			rig.transport.set_cpm(600.0).unwrap();
			run(&mut rig, 5.0);
			let times = rig.oscillator_starts();
			assert!(times.len() >= 5, "{times:?}");
			for (i, time) in times.iter().enumerate() {
				approx(*time, 0.1 + i as f64);
			}
		}
	}

	#[test]
	fn a_stopped_loop_books_no_more_after_a_tempo_change() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(60.0).unwrap();
		let handle = rig
			.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&LoopOptions::default(),
			)
			.unwrap();
		run(&mut rig, 1.0);
		rig.transport
			.stop_loop(&mut rig.engine, handle, &LoopStop::default())
			.unwrap();
		let count = rig.oscillator_starts().len();
		assert!(count > 0);
		rig.transport.set_cpm(120.0).unwrap();
		run(&mut rig, 3.0);
		assert_eq!(rig.oscillator_starts().len(), count);
	}

	#[test]
	fn an_invalid_set_cpm_fails_at_the_call_and_leaves_the_loop_on_its_tempo() {
		let mut rig = Rig::new();
		rig.transport.set_cpm(60.0).unwrap();
		rig.transport
			.play_loop(
				&mut rig.engine,
				&plain(note("c3 e3")),
				&LoopOptions::default(),
			)
			.unwrap();
		assert!(
			rig.transport
				.set_cpm(0.0)
				.unwrap_err()
				.message()
				.contains("must be positive")
		);
		run(&mut rig, 3.0);
		let times = rig.oscillator_starts();
		approx(times[times.len() - 1] - times[times.len() - 2], 0.5);
	}
}
