// Playback: one-shot play and the looping look-ahead scheduler, over the module's transport and the wrapper's timer
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The module's `WasmTransport` books; the wrapper owns the timer (M6-BOUNDARY section 14). Each `loop()` has its own
// transport, ticked by its own timer (0.3 gave each loop its own timer and its `timer` option), and every transport is told
// the global `setcpm()` tempo, which a loop without its own `bpm` or `cps` follows from its next window (D-33). One-shots
// share one transport per context.

import { book, playbackHandle } from './engine.js';
import type {
  LoopHandle,
  LoopOptions,
  LoopStopOptions,
  PlaybackHandle,
  PlayOptions,
  TimerLike
} from './engineTypes.js';
import type { AudioContextLike } from './types.js';
import { nodeId, run } from './webaudio.js';
import type { Backend } from './webaudio.js';
import { glue } from './wasm.js';
import type { WasmEngine, WasmLoop, WasmPlayback, WasmTransport } from '../wasm/undertone_wasm.js';

const defaultTimer: TimerLike = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

let sharedContext: AudioContextLike | undefined;

/** The lazily created shared `AudioContext` of calls that pass no `ctx`. */
export function getSharedContext(): AudioContextLike {
  sharedContext ??= new AudioContext() as unknown as AudioContextLike;
  return sharedContext;
}

let defaultCyclesPerMinute: number | undefined;
/** The transports of running loops, told every tempo change. */
const running = new Set<WasmTransport>();
const oneShots = new WeakMap<Backend, WasmTransport>();

/** Gives a transport the current global tempo. */
function tune(transport: WasmTransport): void {
  if (defaultCyclesPerMinute === undefined) transport.resetTempo();
  else transport.setcpm(defaultCyclesPerMinute);
}

/** The `setcpm()` tempo, or `undefined` (renders pass it to the module as `defaultCpm`). */
export function defaultCpm(): number | undefined {
  return defaultCyclesPerMinute;
}

/**
 * Sets a default tempo in cycles per minute, used by play()/loop() calls that
 * don't pass an explicit `bpm` — the top-of-file "set it once" style some
 * scripts prefer over per-call options. An explicit `{ bpm }` or `{ cps }` on
 * a given call always wins over this. Global mutable state: play() reads it
 * once when it is called, while a running loop() started without an explicit
 * tempo follows it, picking up each change from the next scheduling window
 * with no gap or overlap (voices already booked keep their times).
 */
export function setcpm(cyclesPerMinute: number): void {
  if (!(cyclesPerMinute > 0)) {
    throw new Error(`setcpm() must be positive, got ${cyclesPerMinute}`);
  }
  defaultCyclesPerMinute = cyclesPerMinute;
  for (const transport of running) transport.setcpm(cyclesPerMinute);
}

/** Clears any setcpm() override, restoring the plain 120bpm default — test hygiene, not needed in normal use. */
export function resetTempo(): void {
  defaultCyclesPerMinute = undefined;
  for (const transport of running) transport.resetTempo();
}

/** How a one-shot books: a pattern's `transport.play(...)` or a score's `score.play(transport, ...)`. */
type PlayCall = (
  transport: WasmTransport,
  engine: WasmEngine,
  now: number,
  options: object
) => WasmPlayback;
/** How a loop starts: a pattern's `transport.loop(...)` or a score's `score.loop(transport, ...)`. */
type LoopCall = (
  transport: WasmTransport,
  engine: WasmEngine,
  now: number,
  options: object
) => WasmLoop;

/** One cycle (or one pass of a score) as a one-shot. */
export function playOnce(options: PlayOptions, call: PlayCall): PlaybackHandle {
  const ctx = options.ctx ?? getSharedContext();
  return book(ctx, (backend) => {
    let transport = oneShots.get(backend);
    if (!transport) {
      transport = new glue.WasmTransport(ctx.sampleRate, {});
      oneShots.set(backend, transport);
    }
    tune(transport);
    const output = nodeId(backend, options.output);
    const played = run(backend, (engine) =>
      call(transport, engine, ctx.currentTime, {
        bpm: options.bpm,
        cps: options.cps,
        when: options.when,
        gated: options.gated,
        output
      })
    );
    return playbackHandle(backend, played);
  });
}

/** A loop on its own transport and timer. */
export function loopOn(options: LoopOptions, call: LoopCall): LoopHandle {
  const ctx = options.ctx ?? getSharedContext();
  return book(ctx, (backend) => {
    const transport = new glue.WasmTransport(ctx.sampleRate, {});
    tune(transport);
    const output = nodeId(backend, options.output);
    let loop: WasmLoop;
    try {
      loop = run(backend, (engine) =>
        call(transport, engine, ctx.currentTime, { bpm: options.bpm, cps: options.cps, output })
      );
    } catch (error) {
      transport.free();
      throw error;
    }
    running.add(transport);
    const timer = options.timer ?? defaultTimer;
    const tick = (): void => {
      run(backend, (engine) => transport.tick(engine, ctx.currentTime));
    };
    const interval = timer.setInterval(tick, transport.tickInterval * 1000);
    let stopped = false;
    return {
      stop(stopOptions: LoopStopOptions = {}) {
        timer.clearInterval(interval);
        if (stopped) return;
        stopped = true;
        running.delete(transport);
        try {
          run(backend, (engine) =>
            transport.stopLoop(engine, loop, ctx.currentTime, {
              voices: stopOptions.voices,
              fade: stopOptions.fade
            })
          );
        } finally {
          // The voices it booked belong to the context's engine, which still tracks them; the loop's own state can go.
          loop.free();
          transport.free();
        }
      }
    };
  });
}
