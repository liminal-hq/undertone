// The scheduler as exports: WasmTransport plays and loops patterns on a WasmEngine, ticked by the JavaScript timer
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`WasmTransport`] is `undertone-sched`'s [`Transport`] for the wrapper's `play()`, `loop()`, `.play()`, `.loop()`, and
//! a score's `play` and `loop` (section 14 of `docs/rust-migration/results/M6-BOUNDARY.md`). **The wrapper owns the
//! timer:** Rust starts nothing and sleeps never. Every call takes `now`, the context's `currentTime`, which becomes
//! both the transport's clock and the engine's graph clock; the wrapper calls [`WasmTransport::tick`] from its
//! `setInterval` (every [`WasmTransport::tick_interval`] seconds, 0.1 by default) and replays what the engine recorded
//! ([`WasmEngine::take`]) after every call, a failing one included.
//!
//! - **Tempo (D-29):** the wrapper holds the global `setcpm()` value and gives it to each transport with
//!   [`WasmTransport::setcpm`] and [`WasmTransport::reset_tempo`]; a loop without its own `bpm` or `cps` follows a
//!   change at its next tick (D-33).
//! - **Rollback (D-38):** a `play` or a first loop window that fails cuts what it booked and returns the error.
//! - **Handles:** `play` returns a [`WasmPlayback`]; `loop` a [`WasmLoop`], stopped with [`WasmTransport::stop_loop`].
//!   One transport may run many loops on one engine; a tick ticks all of them, so a wrapper that gives each loop its
//!   own timer (the reference's `timer` option) makes one transport per loop.

use js_sys::{Object, Reflect};
use undertone::pattern::Fraction;
use undertone::sched::{
	Clock, LoopHandle, LoopOptions, LoopStop, LoopVoices, ManualClock, PlayOptions,
	SchedulerOptions, Transport,
};
use wasm_bindgen::prelude::*;

use crate::booking::{WasmEngine, WasmPlayback};
use crate::convert::{error, rust_error};
use crate::encode::fraction_from_parts;
use crate::foreign::guarded;
use crate::options::{field, flag, number};
use crate::pattern::WasmPattern;
use crate::score::WasmScore;
use crate::warnings::queried;

/// A running loop of a [`WasmTransport`]: stop it with [`WasmTransport::stop_loop`]. A handle of a loop that stopped, or
/// of another transport, is ignored.
#[wasm_bindgen]
pub struct WasmLoop(LoopHandle);

/// The scheduler of one engine (or of one loop). See the [module documentation](self).
#[wasm_bindgen]
pub struct WasmTransport {
	clock: ManualClock,
	transport: Transport<ManualClock>,
}

impl WasmTransport {
	/// Moves the clock and the engine's graph clock to `now`.
	fn at(&self, engine: &mut WasmEngine, now: f64) {
		self.clock.set(now);
		engine.set_time(now);
	}
}

fn scheduler_options(value: &JsValue) -> SchedulerOptions {
	let defaults = SchedulerOptions::default();
	let or = |key: &str, default: f64| number(&field(value, key)).unwrap_or(default);
	SchedulerOptions {
		look_ahead: or("lookAhead", defaults.look_ahead),
		tick_interval: or("tickInterval", defaults.tick_interval),
		start_latency: or("startLatency", defaults.start_latency),
		max_catch_up_seconds: or("maxCatchUpSeconds", defaults.max_catch_up_seconds),
	}
}

/// The node a call's `output` names, as [`WasmEngine`] numbers them.
fn output(engine: &WasmEngine, value: &JsValue) -> undertone::engine::graph::NodeId {
	engine.output(number(&field(value, "output")))
}

/// Runs a call that queries a pattern: control warnings print, and a JavaScript leaf's exception is rethrown.
fn querying<T>(run: impl FnOnce() -> undertone::pattern::Result<T>) -> Result<T, JsValue> {
	guarded(|| queried(run))?.map_err(rust_error)
}

#[wasm_bindgen]
impl WasmTransport {
	/// A transport at the default tempo (120 bpm) for a context of `sampleRate` hertz, paced by `options`
	/// (`{ lookAhead, tickInterval, startLatency, maxCatchUpSeconds }` in seconds; defaults 0.3, 0.1, 0.1, 5).
	#[wasm_bindgen(constructor)]
	pub fn new(sample_rate: f64, options: JsValue) -> Result<WasmTransport, JsValue> {
		let clock = ManualClock::new(sample_rate);
		let transport =
			Transport::new(clock.clone(), scheduler_options(&options)).map_err(rust_error)?;
		Ok(WasmTransport { clock, transport })
	}

	/// How often the wrapper's timer should call [`WasmTransport::tick`], in seconds.
	#[wasm_bindgen(getter, js_name = tickInterval)]
	pub fn tick_interval(&self) -> f64 {
		self.transport.tick_interval()
	}

	/// `setcpm(cyclesPerMinute)`: the default tempo of later calls and of running loops without their own tempo.
	pub fn setcpm(&mut self, cycles_per_minute: f64) -> Result<(), JsValue> {
		self.transport
			.set_cpm(cycles_per_minute)
			.map_err(rust_error)
	}

	/// `resetTempo()`: back to 120 bpm.
	#[wasm_bindgen(js_name = resetTempo)]
	pub fn reset_tempo(&mut self) {
		self.transport.reset_tempo();
	}

	/// `pattern.play(options)`: one cycle as a one-shot from `options.when` (default `now`), `{ bpm, cps, when, gated,
	/// output }`; ungated unless `gated`.
	pub fn play(
		&mut self,
		engine: &mut WasmEngine,
		pattern: &WasmPattern,
		now: f64,
		options: JsValue,
	) -> Result<WasmPlayback, JsValue> {
		self.at(engine, now);
		let options = PlayOptions {
			bpm: number(&field(&options, "bpm")),
			cps: number(&field(&options, "cps")),
			when: number(&field(&options, "when")),
			from: Fraction::from_int(0),
			gated: flag(&field(&options, "gated")).unwrap_or(false),
			output: Some(output(engine, &options)),
		};
		let transport = &mut self.transport;
		engine
			.run(|engine| querying(|| transport.play(engine, pattern.pattern(), &options)))
			.map(WasmPlayback::played)
	}

	/// `pattern.loop(options)`: loops from `now` plus the start latency, `{ bpm, cps, output }`; the first window is
	/// booked at once.
	#[wasm_bindgen(js_name = loop)]
	pub fn play_loop(
		&mut self,
		engine: &mut WasmEngine,
		pattern: &WasmPattern,
		now: f64,
		options: JsValue,
	) -> Result<WasmLoop, JsValue> {
		self.at(engine, now);
		let options = LoopOptions {
			bpm: number(&field(&options, "bpm")),
			cps: number(&field(&options, "cps")),
			output: Some(output(engine, &options)),
		};
		let transport = &mut self.transport;
		engine
			.run(|engine| querying(|| transport.play_loop(engine, pattern.pattern(), &options)))
			.map(WasmLoop)
	}

	/// One tick at `now`: books every running loop's look-ahead. Returns how many voices it booked. A loop whose window
	/// fails is tried again at the next tick; the first error is thrown after every loop ticked.
	pub fn tick(&mut self, engine: &mut WasmEngine, now: f64) -> Result<usize, JsValue> {
		self.at(engine, now);
		let transport = &mut self.transport;
		engine
			.run(|engine| querying(|| transport.tick(engine)))
			.map(|report| report.booked)
	}

	/// `handle.stop({ voices, fade })`: no more cycles; `voices: 'cut'` fades out what is booked (`fade`, default
	/// 0.01 s), `'ring'` (the default) lets it finish.
	#[wasm_bindgen(js_name = stopLoop)]
	pub fn stop_loop(
		&mut self,
		engine: &mut WasmEngine,
		handle: &WasmLoop,
		now: f64,
		options: JsValue,
	) -> Result<(), JsValue> {
		self.at(engine, now);
		let voices = field(&options, "voices");
		let options = LoopStop {
			voices: if voices.as_string().as_deref() == Some("cut") {
				LoopVoices::Cut
			} else {
				LoopVoices::Ring
			},
			fade: number(&field(&options, "fade")),
		};
		let transport = &mut self.transport;
		engine
			.run(|engine| transport.stop_loop(engine, handle.0, &options))
			.map_err(rust_error)
	}

	/// Moves a running loop to pattern position `fromN / fromD` cycles, sounding at `when` (default `now` plus the start
	/// latency); what is booked is cut there. `false` for a loop that stopped.
	pub fn seek(
		&mut self,
		engine: &mut WasmEngine,
		handle: &WasmLoop,
		now: f64,
		from_n: f64,
		from_d: f64,
		when: Option<f64>,
	) -> Result<bool, JsValue> {
		let from = fraction_from_parts(from_n, from_d).map_err(|message| error(&message))?;
		self.at(engine, now);
		let transport = &mut self.transport;
		engine.run(|engine| querying(|| transport.seek(engine, handle.0, from, when)))
	}

	/// Whether the loop is still running.
	#[wasm_bindgen(js_name = isRunning)]
	pub fn is_running(&self, handle: &WasmLoop) -> bool {
		self.transport.is_running(handle.0)
	}

	/// How many loops are running.
	#[wasm_bindgen(getter, js_name = loopCount)]
	pub fn loop_count(&self) -> usize {
		self.transport.loop_count()
	}

	/// The pattern time a running loop has booked up to, as exact text (`"3/10"`), or `undefined`.
	#[wasm_bindgen(js_name = scheduledUntil)]
	pub fn scheduled_until(&self, handle: &WasmLoop) -> Option<String> {
		self.transport
			.scheduled_until(handle.0)
			.map(|until| format!("{}/{}", until.numerator(), until.denominator()))
	}

	/// The counters: `{ ticks, bookingTicks, voicesBooked, lateVoices, droppedVoices, badClockReads, underruns,
	/// callbacks, callbackSecondsTotal, callbackSecondsMax, callbackSecondsLast, framesPlayed, outputLatency }`.
	pub fn stats(&self) -> Object {
		let stats = self.transport.stats();
		let out = Object::new();
		let rows: [(&str, f64); 13] = [
			("ticks", stats.ticks as f64),
			("bookingTicks", stats.booking_ticks as f64),
			("voicesBooked", stats.voices_booked as f64),
			("lateVoices", stats.late_voices as f64),
			("droppedVoices", stats.dropped_voices as f64),
			("badClockReads", stats.bad_clock_reads as f64),
			("underruns", stats.underruns as f64),
			("callbacks", stats.callbacks as f64),
			("callbackSecondsTotal", stats.callback_seconds_total),
			("callbackSecondsMax", stats.callback_seconds_max),
			("callbackSecondsLast", stats.callback_seconds_last),
			("framesPlayed", stats.frames_played as f64),
			("outputLatency", stats.output_latency),
		];
		for (key, value) in rows {
			let _ = Reflect::set(&out, &JsValue::from_str(key), &JsValue::from_f64(value));
		}
		out
	}

	/// Zeroes the counters.
	#[wasm_bindgen(js_name = resetStats)]
	pub fn reset_stats(&mut self) {
		self.transport.reset_stats();
	}

	/// Counts an underrun the host saw.
	#[wasm_bindgen(js_name = recordUnderrun)]
	pub fn record_underrun(&mut self) {
		self.transport.record_underrun();
	}

	/// The time the clock was last set to (for a test).
	#[wasm_bindgen(getter)]
	pub fn now(&self) -> f64 {
		self.clock.now()
	}
}

#[wasm_bindgen]
impl WasmScore {
	/// `score.play(options)`: one pass at the score's own tempo, `{ when, gated, output }`, as a one-shot.
	#[wasm_bindgen(js_name = play)]
	pub fn play_js(
		&self,
		transport: &mut WasmTransport,
		engine: &mut WasmEngine,
		now: f64,
		options: JsValue,
	) -> Result<WasmPlayback, JsValue> {
		let options = score_options(&options, self.cps());
		let pattern = WasmPattern::new(self.score().pattern().clone());
		transport.play(engine, &pattern, now, options)
	}

	/// `score.loop(options)`: loops the cue at its own tempo, `{ output }`.
	#[wasm_bindgen(js_name = loop)]
	pub fn loop_js(
		&self,
		transport: &mut WasmTransport,
		engine: &mut WasmEngine,
		now: f64,
		options: JsValue,
	) -> Result<WasmLoop, JsValue> {
		let options = score_options(&options, self.cps());
		let pattern = WasmPattern::new(self.score().pattern().clone());
		transport.play_loop(engine, &pattern, now, options)
	}
}

/// A score's play or loop options: the caller's, with the score's `cps` (so a caller's `bpm` fails as in the reference).
fn score_options(options: &JsValue, cps: f64) -> JsValue {
	let copy = Object::new();
	if options.is_object() {
		let _ = Object::assign(&copy, wasm_bindgen::JsCast::unchecked_ref(options));
	}
	let _ = Reflect::set(&copy, &JsValue::from_str("cps"), &JsValue::from_f64(cps));
	copy.into()
}
