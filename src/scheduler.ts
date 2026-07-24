// The playback layer: one-shot play and the looping lookahead cycle scheduler
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { playVoice, resolveParams } from './engine.js';
import { Fraction } from './fraction.js';
import type { Hap, TimeSpan } from './pattern.js';
import type { AudioContextLike, ControlPatch } from './types.js';

/** The minimal pattern surface the scheduler needs (avoids a runtime import cycle). */
interface PatternLike {
  query(span: TimeSpan): Hap<ControlPatch>[];
}

export interface TimerLike {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PlayOptions {
  /** Audio context to schedule against; a lazily-created shared AudioContext when omitted. */
  ctx?: AudioContextLike;
  /** Tempo in beats per minute, four beats to a cycle. Default 120 (2-second cycles). */
  bpm?: number;
  /** Absolute start time on the context's clock. Default: now. */
  when?: number;
}

export interface LoopOptions {
  /** Audio context to schedule against; a lazily-created shared AudioContext when omitted. */
  ctx?: AudioContextLike;
  /** Tempo in beats per minute, four beats to a cycle. Default 120 (2-second cycles). */
  bpm?: number;
  /** Injectable timer (tests tick it by hand); defaults to global setInterval/clearInterval. */
  timer?: TimerLike;
}

/** Returned by loop(): call stop() to stop scheduling new cycles. Already-scheduled voices ring out. */
export interface LoopHandle {
  stop(): void;
}

const DEFAULT_BPM = 120;
const SECONDS_PER_CYCLE_AT_1_BPM = 240; // four beats per cycle
const LOOKAHEAD_SECONDS = 0.3; // how far ahead of the audio clock each tick schedules
const TICK_MS = 100;
// Headroom between loop() being called and pattern time zero, so the very
// first onset isn't scheduled at exactly "now" (already in the past by the
// time the nodes are built, which would clamp its attack).
const START_LATENCY_SECONDS = 0.1;
// Scheduling-window boundaries are quantized to this per-cycle grid so their
// denominators stay small — Fraction arithmetic must never leave integer-safe
// range even after days of looping. Event times are unaffected: a rational
// onset falls in exactly one half-open window wherever the boundaries land.
const WINDOW_GRID = 10080;

const defaultTimer: TimerLike = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

let sharedContext: AudioContextLike | undefined;

function getSharedContext(): AudioContextLike {
  if (!sharedContext) {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

function cycleSecondsFor(bpm: number | undefined): number {
  const beats = bpm ?? DEFAULT_BPM;
  if (!(beats > 0)) {
    throw new Error(`bpm must be positive, got ${beats}`);
  }
  return SECONDS_PER_CYCLE_AT_1_BPM / beats;
}

/**
 * Realizes every event onset in `span` as a voice on the context's clock.
 * When `gated`, each voice's envelope holds until its event's share of the
 * cycle ends (note length); otherwise envelopes run their percussive course.
 */
function scheduleSpan(
  ctx: AudioContextLike,
  pattern: PatternLike,
  span: TimeSpan,
  patternStartTime: number,
  cycleSeconds: number,
  gated: boolean
): void {
  for (const hap of pattern.query(span)) {
    if (!hap.whole || !hap.whole.begin.eq(hap.part.begin)) {
      continue; // a tail overlapping the window, not an onset — already scheduled
    }
    const startTime = patternStartTime + hap.whole.begin.toNumber() * cycleSeconds;
    const patch = gated
      ? { duration: hap.whole.end.sub(hap.whole.begin).toNumber() * cycleSeconds, ...hap.value }
      : hap.value;
    playVoice(ctx, resolveParams(patch), startTime);
  }
}

/**
 * Plays one cycle's worth of the pattern as a one-shot sound effect. One-shots
 * are ungated — envelopes stay percussive, exactly like the 0.1.x SFX
 * behaviour; note-length gating belongs to loop().
 */
export function playPattern(pattern: PatternLike, options: PlayOptions = {}): void {
  const ctx = options.ctx ?? getSharedContext();
  const cycleSeconds = cycleSecondsFor(options.bpm);
  const start = options.when ?? ctx.currentTime;
  scheduleSpan(
    ctx,
    pattern,
    { begin: new Fraction(0), end: new Fraction(1) },
    start,
    cycleSeconds,
    false
  );
}

/**
 * Loops the pattern indefinitely using the standard two-clock approach: a
 * coarse timer tick queries the pattern for the window between what's already
 * scheduled and a short lookahead past the audio clock, and schedules those
 * voices at exact audio-clock times.
 */
export function loopPattern(pattern: PatternLike, options: LoopOptions = {}): LoopHandle {
  const ctx = options.ctx ?? getSharedContext();
  const cycleSeconds = cycleSecondsFor(options.bpm);
  const timer = options.timer ?? defaultTimer;
  const startTime = ctx.currentTime + START_LATENCY_SECONDS;
  let scheduledUntil = new Fraction(0); // pattern time, in cycles

  const tick = (): void => {
    const horizonSeconds = ctx.currentTime + LOOKAHEAD_SECONDS - startTime;
    const horizonCycles = horizonSeconds / cycleSeconds;
    const horizon = new Fraction(Math.floor(horizonCycles * WINDOW_GRID), WINDOW_GRID);
    if (horizon.lte(scheduledUntil)) {
      return;
    }
    scheduleSpan(
      ctx,
      pattern,
      { begin: scheduledUntil, end: horizon },
      startTime,
      cycleSeconds,
      true
    );
    scheduledUntil = horizon;
  };

  tick();
  const handle = timer.setInterval(tick, TICK_MS);
  return { stop: () => timer.clearInterval(handle) };
}
