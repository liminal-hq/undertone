// What the audio callback allocates, counted with a global allocator that wraps the system's
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Allocation counting over the audio callback (RF-28).
//!
//! With `tests/allocation.rs` of `undertone-sched`, this is one of the only two files in the workspace that use
//! `unsafe`: a `GlobalAlloc` has to be `unsafe` to implement, and counting is what the test is for.
//! `undertone-native`'s own `[lints]` table is `unsafe_code = "deny"` (the workspace's is `forbid`, which an
//! `allow` cannot lower), and this file alone lowers it. The pattern is the scheduler's, copied.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use undertone::prelude::*;
use undertone_native::{ManualSink, Output, OutputOptions, StreamFormat};

/// A global allocator that counts, per thread, the calls it makes, and otherwise does what the system's does.
struct Counting;

thread_local! {
	// `const` initialisers with no destructor: reading them never allocates, so the allocator can use them.
	static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
	static FREES: Cell<u64> = const { Cell::new(0) };
}

fn bump(cell: &'static std::thread::LocalKey<Cell<u64>>) {
	// `try_with` so that a call during thread teardown (after the key is gone) is not a panic in the allocator.
	let _ = cell.try_with(|c| c.set(c.get() + 1));
}

// SAFETY: every method forwards to `System`, which upholds the `GlobalAlloc` contract, with the same layout and
// pointer it was given; the only addition is bumping per-thread counters, which neither allocates nor panics
// (`try_with` on `const`-initialised `Cell`s).
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		bump(&ALLOCATIONS);
		// SAFETY: `layout` is the caller's, unchanged.
		unsafe { System.alloc(layout) }
	}

	unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
		bump(&ALLOCATIONS);
		// SAFETY: `layout` is the caller's, unchanged.
		unsafe { System.alloc_zeroed(layout) }
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		bump(&FREES);
		// SAFETY: `ptr` and `layout` are the caller's, from an earlier call on this allocator, which forwarded to `System`.
		unsafe { System.dealloc(ptr, layout) }
	}

	unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		bump(&ALLOCATIONS);
		bump(&FREES);
		// SAFETY: `ptr`, `layout`, and `new_size` are the caller's, from an earlier call on this allocator.
		unsafe { System.realloc(ptr, layout, new_size) }
	}
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// What `body` allocated and freed on this thread.
fn measure<R>(body: impl FnOnce() -> R) -> (R, u64, u64) {
	let (a0, f0) = (ALLOCATIONS.with(Cell::get), FREES.with(Cell::get));
	let result = body();
	let (a1, f1) = (ALLOCATIONS.with(Cell::get), FREES.with(Cell::get));
	(result, a1 - a0, f1 - f0)
}

/// Sanity check of the counter itself: a test that counts nothing would pass for the wrong reason.
#[test]
fn the_counter_sees_an_allocation_on_this_thread() {
	let (_, allocations, _) = measure(|| std::hint::black_box(vec![1_u8; 64]));
	assert!(allocations >= 1);
}

#[test]
fn the_audio_callback_does_not_allocate() {
	let format = StreamFormat::new(16_000, 2);
	let (sink, driver) = ManualSink::new(format);
	let mut player = Player::new(&format.player_options()).unwrap();
	player
		.play_loop(
			&note("c3 e3 g3 c4").unwrap().sound("triangle"),
			&LoopOptions {
				bpm: Some(240.0),
				..LoopOptions::default()
			},
		)
		.unwrap();
	let mut output = Output::open(sink, player, &OutputOptions::default()).unwrap();
	// The audio thread's side: take the callback out of the sink and run it here, the way a device's thread would.
	let mut callback = driver.take_callback().unwrap();

	// Buffers made before counting starts, as a device would hand them over.
	let mut buffer = vec![0.0_f32; 2 * 480];
	// Wait, before counting, for the control thread's first rendered audio to reach the ring: on a slow machine the
	// measured pulls below could otherwise all find it empty and prove nothing.
	let started = std::time::Instant::now();
	while started.elapsed() < std::time::Duration::from_secs(10) {
		callback.fill(&mut buffer);
		if buffer.iter().any(|sample| *sample != 0.0) {
			break;
		}
		std::thread::sleep(std::time::Duration::from_millis(5));
	}
	let mut heard = false;
	let mut calls = 0;
	let ((), allocations, frees) = measure(|| {
		// Pull faster than real time for a stretch (so underruns happen too: they must not allocate either),
		// then at the pace of the control thread.
		for _ in 0..400 {
			callback.fill(&mut buffer);
			heard |= buffer.iter().any(|sample| *sample != 0.0);
			calls += 1;
			if calls % 4 == 0 {
				std::thread::sleep(std::time::Duration::from_millis(1));
			}
		}
	});
	output.close();
	let health = callback.health();

	assert_eq!(calls, 400);
	assert!(
		heard,
		"the callback delivered audio, so the count means something"
	);
	assert!(health.underruns() > 0, "the run included underruns");
	assert_eq!(
		(allocations, frees),
		(0, 0),
		"the audio callback allocated or freed"
	);
}

#[test]
fn the_audio_callback_does_not_allocate_when_it_never_underruns() {
	let format = StreamFormat::new(16_000, 2);
	let (sink, driver) = ManualSink::new(format);
	let mut player = Player::new(&format.player_options()).unwrap();
	player
		.play(
			&note("c4").unwrap().sound("triangle"),
			&PlayOptions::default(),
		)
		.unwrap();
	let mut output = Output::open(sink, player, &OutputOptions::default()).unwrap();
	let mut callback = driver.take_callback().unwrap();
	let mut buffer = vec![0.0_f32; 2 * 100];
	let mut heard = false;
	let mut allocations = 0;
	for _ in 0..100 {
		while callback.buffered_frames() < 100 {
			std::thread::sleep(std::time::Duration::from_micros(200));
		}
		let ((), a, _) = measure(|| callback.fill(&mut buffer));
		allocations += a;
		heard |= buffer.iter().any(|sample| *sample != 0.0);
	}
	output.close();
	assert!(heard);
	assert_eq!(callback.health().underruns(), 0);
	assert_eq!(allocations, 0);
}
