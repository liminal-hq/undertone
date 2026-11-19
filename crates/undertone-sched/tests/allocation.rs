// What the scheduler's tick path and the renderer allocate, counted with a global allocator that wraps the system's
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Allocation counting over the tick path (RF-22).
//!
//! This is the only file in the workspace that uses `unsafe`: a `GlobalAlloc` has to be `unsafe` to
//! implement, and counting is what the test is for. `undertone-sched`'s own `[lints]` table is
//! `unsafe_code = "deny"` (the workspace's is `forbid`, which an `allow` cannot lower), and this file
//! alone lowers it. The exception is noted in `AGENTS.md`.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

/// A global allocator that counts, per thread, the calls it makes and the bytes it hands out and takes back,
/// and otherwise does what the system allocator does.
struct Counting;

thread_local! {
	// `const` initialisers with no destructor: reading them never allocates, so the allocator can use them.
	static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
	static FREES: Cell<u64> = const { Cell::new(0) };
	static BYTES_OUT: Cell<u64> = const { Cell::new(0) };
	static BYTES_BACK: Cell<u64> = const { Cell::new(0) };
}

fn bump(cell: &'static std::thread::LocalKey<Cell<u64>>, by: u64) {
	// `try_with` so that a call during thread teardown (after the key is gone) is not a panic in the allocator.
	let _ = cell.try_with(|c| c.set(c.get() + by));
}

// SAFETY: every method forwards to `System`, which upholds the `GlobalAlloc` contract, with the same layout and
// pointer it was given; the only addition is bumping per-thread counters, which neither allocates nor panics
// (`try_with` on `const`-initialised `Cell`s).
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		bump(&ALLOCATIONS, 1);
		bump(&BYTES_OUT, layout.size() as u64);
		// SAFETY: `layout` is the caller's, unchanged.
		unsafe { System.alloc(layout) }
	}

	unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
		bump(&ALLOCATIONS, 1);
		bump(&BYTES_OUT, layout.size() as u64);
		// SAFETY: `layout` is the caller's, unchanged.
		unsafe { System.alloc_zeroed(layout) }
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		bump(&FREES, 1);
		bump(&BYTES_BACK, layout.size() as u64);
		// SAFETY: `ptr` and `layout` are the caller's, from an earlier call on this allocator, which forwarded to `System`.
		unsafe { System.dealloc(ptr, layout) }
	}

	unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		bump(&ALLOCATIONS, 1);
		bump(&FREES, 1);
		bump(&BYTES_OUT, new_size as u64);
		bump(&BYTES_BACK, layout.size() as u64);
		// SAFETY: `ptr`, `layout`, and `new_size` are the caller's, from an earlier call on this allocator.
		unsafe { System.realloc(ptr, layout, new_size) }
	}
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// What a stretch of code did to the heap, on this thread.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Counts {
	allocations: u64,
	frees: u64,
	bytes_out: u64,
	bytes_back: u64,
}

fn snapshot() -> Counts {
	Counts {
		allocations: ALLOCATIONS.with(Cell::get),
		frees: FREES.with(Cell::get),
		bytes_out: BYTES_OUT.with(Cell::get),
		bytes_back: BYTES_BACK.with(Cell::get),
	}
}

/// Runs `body` and says what it allocated and freed.
fn measure<R>(body: impl FnOnce() -> R) -> (R, Counts) {
	let before = snapshot();
	let result = body();
	let after = snapshot();
	(
		result,
		Counts {
			allocations: after.allocations - before.allocations,
			frees: after.frees - before.frees,
			bytes_out: after.bytes_out - before.bytes_out,
			bytes_back: after.bytes_back - before.bytes_back,
		},
	)
}

use undertone_engine::engine::{Engine, OutputSetup};
use undertone_engine::graph::Graph;
use undertone_engine::master::MasterBusOptions;
use undertone_engine::render_graph::RenderGraph;
use undertone_pattern::control::note;
use undertone_sched::{LoopOptions, ManualClock, SchedulerOptions, Transport};

/// 128 frames to the quantum, ten quanta to a 0.1 s tick.
const RATE: f64 = 12_800.0;
const TICK_FRAMES: usize = 1_280;

struct Rig {
	engine: Engine<RenderGraph>,
	transport: Transport<ManualClock>,
	clock: ManualClock,
	left: Vec<f32>,
	right: Vec<f32>,
}

impl Rig {
	fn new() -> Self {
		let clock = ManualClock::new(RATE);
		let setup = OutputSetup {
			master: Some(MasterBusOptions::default()),
			..OutputSetup::default()
		};
		Self {
			engine: Engine::new(RenderGraph::new(RATE, 2, 1 << 26), setup).unwrap(),
			transport: Transport::new(clock.clone(), SchedulerOptions::default()).unwrap(),
			clock,
			left: vec![0.0; TICK_FRAMES],
			right: vec![0.0; TICK_FRAMES],
		}
	}

	/// The host's tick: render 0.1 s, move the clock to where the graph is, and tick the transport. Says what
	/// the render and then the tick allocated, and how many voices the tick booked.
	fn step(&mut self) -> (Counts, Counts, usize) {
		let (rendered, render_counts) = measure(|| {
			self.engine
				.graph_mut()
				.render_block(&mut [self.left.as_mut_slice(), self.right.as_mut_slice()])
		});
		assert_eq!(rendered, TICK_FRAMES);
		self.clock.set(self.engine.graph().current_time());
		let (result, tick_counts) = measure(|| self.transport.tick(&mut self.engine));
		(render_counts, tick_counts, result.unwrap().booked)
	}
}

/// A pattern with a filter, a pan, a reverb send, and a delay send on every note: the whole voice chain.
fn busy_pattern() -> undertone_pattern::Pattern<undertone_pattern::ControlMap> {
	note("c3 e3 g3 b3 c4 b3 g3 e3")
		.unwrap()
		.lpf(1200.0)
		.unwrap()
		.pan(0.3)
		.unwrap()
		.room(0.3)
		.unwrap()
		.delay(0.2)
		.unwrap()
}

#[test]
fn a_tick_with_nothing_due_allocates_nothing() {
	let mut rig = Rig::new();
	let options = LoopOptions {
		bpm: Some(120.0),
		..LoopOptions::default()
	};
	rig.transport
		.play_loop(&mut rig.engine, &busy_pattern(), &options)
		.unwrap();
	// Ticking again without the clock moving: the window to book is empty.
	let mut worst = Counts::default();
	for _ in 0..1_000 {
		let (result, counts) = measure(|| rig.transport.tick(&mut rig.engine));
		result.unwrap();
		if counts.allocations > worst.allocations {
			worst = counts;
		}
	}
	assert_eq!(worst.allocations, 0, "{worst:?}");
	// The clock, statistics, and options are plain reads.
	let (_, counts) = measure(|| (rig.transport.stats(), rig.transport.tick_interval()));
	assert_eq!(counts.allocations, 0);
}

#[test]
fn the_renderer_allocates_nothing_between_bookings() {
	let mut rig = Rig::new();
	let options = LoopOptions {
		bpm: Some(120.0),
		..LoopOptions::default()
	};
	rig.transport
		.play_loop(&mut rig.engine, &busy_pattern(), &options)
		.unwrap();
	// Settle: render until the plan for what is booked is built, and everything has had its first quantum.
	for _ in 0..3 {
		rig.step();
	}
	// Now render without booking (no tick): the steady state of the audio callback.
	let (_, counts) = measure(|| {
		for _ in 0..50 {
			rig.engine
				.graph_mut()
				.render_block(&mut [rig.left.as_mut_slice(), rig.right.as_mut_slice()]);
		}
	});
	println!("render_block x50 between bookings: {counts:?}");
	assert_eq!(counts.allocations, 0, "{counts:?}");
}

/// What the ticks of one steady-state run allocated, kept as running figures (a growing `Vec` of samples
/// would itself show up in the heap this test watches).
#[derive(Debug, Default)]
struct Tally {
	query_only_ticks: u64,
	query_only_least: u64,
	query_only_most: u64,
	booking_ticks: u64,
	booking_most: u64,
	booking_most_per_voice: u64,
	/// The most allocations in a render block that followed a tick that booked (the plan is rebuilt).
	render_after_booking_most: u64,
	/// The most allocations in a render block that followed a tick that booked nothing.
	render_after_quiet_most: u64,
}

/// Runs the busy loop for `ticks` ticks and reports what the ticks after the first 100 allocated, and the live
/// heap (bytes asked for and not given back) at the end of each cycle after that.
fn run_busy(ticks: usize) -> (Tally, [i64; 4]) {
	let mut rig = Rig::new();
	let options = LoopOptions {
		bpm: Some(120.0),
		..LoopOptions::default()
	};
	rig.transport
		.play_loop(&mut rig.engine, &busy_pattern(), &options)
		.unwrap();
	let mut tally = Tally {
		query_only_least: u64::MAX,
		..Tally::default()
	};
	let mut live = [0_i64; 4];
	let mut samples = 0;
	let mut was_booking = false;
	for tick in 0..ticks {
		let (render, counts, booked) = rig.step();
		if tick >= 100 {
			// The render in this step came after the previous tick, which booked or not as `was_booking` says.
			if was_booking {
				tally.render_after_booking_most =
					tally.render_after_booking_most.max(render.allocations);
			} else {
				tally.render_after_quiet_most =
					tally.render_after_quiet_most.max(render.allocations);
			}
		}
		was_booking = booked > 0;
		if tick >= 100 {
			if booked == 0 {
				tally.query_only_ticks += 1;
				tally.query_only_least = tally.query_only_least.min(counts.allocations);
				tally.query_only_most = tally.query_only_most.max(counts.allocations);
			} else {
				tally.booking_ticks += 1;
				tally.booking_most = tally.booking_most.max(counts.allocations);
				tally.booking_most_per_voice = tally
					.booking_most_per_voice
					.max(counts.allocations / booked as u64);
			}
		}
		// One pattern cycle is two seconds, twenty ticks: sample the heap at the same phase of it, over the last
		// four cycles of the run.
		if tick % 20 == 19 && tick + 80 >= ticks {
			let totals = snapshot();
			live[samples] = totals.bytes_out as i64 - totals.bytes_back as i64;
			samples += 1;
		}
	}
	(tally, live)
}

/// The measured steady state, as bounds. These are **not zero**, and the numbers say why: a tick that books
/// queries the pattern (which builds the events, their control maps, and the resolved voice parameters) and
/// the engine makes a voice's nodes, each with its own parameter timelines and blocks. Making that
/// allocation-free means a different pattern core and a node pool in the graph; neither is in this work package.
/// What the pooling does give is the second assertion: the heap does not grow.
///
/// Measured on 1,200 ticks (two minutes of audio) of `busy_pattern`, in a debug build (allocation counts do not
/// depend on the build profile):
///
/// - a tick whose window holds no onset: 38 allocations, all of them the pattern query;
/// - a tick that books one voice: up to 103, so about 65 for the voice;
/// - the render block after a tick that booked: 57 (the graph rebuilds its plan; a block after a tick that
///   booked nothing allocates none).
///
/// The bounds leave about a quarter of headroom, so an unrelated change does not trip them, but a change that
/// doubles the cost of a tick does.
#[test]
fn steady_state_allocations_are_bounded_and_the_heap_does_not_grow() {
	let (tally, live) = run_busy(1_200);
	println!("{tally:?}\nlive heap over the last four cycles: {live:?}");
	assert!(
		tally.query_only_ticks > 100 && tally.booking_ticks > 100,
		"{tally:?}"
	);
	assert!(tally.query_only_most <= 48, "{tally:?}");
	assert!(tally.booking_most <= 130, "{tally:?}");
	assert!(tally.render_after_booking_most <= 72, "{tally:?}");
	assert_eq!(
		tally.render_after_quiet_most, 0,
		"a block after a quiet tick must not allocate: {tally:?}"
	);
	// Pooling: at the same phase of the pattern the live heap is the same to the byte, cycle after cycle.
	assert!(
		live.windows(2).all(|pair| pair[0] == pair[1]),
		"the heap grew: {live:?}"
	);
}
