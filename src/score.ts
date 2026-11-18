// A tick-based score: explicitly timed events compiled to a sample-accurate looping pattern
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { PlaybackHandle } from './engine.js';
import { Fraction } from './fraction.js';
import { midiToFrequency } from './pitch.js';
import { Pattern } from './pattern.js';
import type { Hap, TimeSpan } from './pattern.js';
import type { RenderOptions } from './render.js';
import type { LoopHandle, LoopOptions, PlayOptions } from './scheduler.js';
import type { ControlPatch, PanPoint, RenderedAudioBufferLike } from './types.js';

/** One point of a score event's `panPath`: a stereo position some ticks after the onset. */
export interface ScorePanPoint {
  /** Whole ticks from the event's onset (0 is the onset itself). */
  tick: number;
  /** Stereo position, -1 to 1; clamped. */
  pan: number;
}

/** One note in a score. Times are whole ticks, so they stay exact. */
export interface ScoreEvent {
  /** Onset, in ticks from the start of the cue (0 up to but not including `lengthTicks`). */
  tick: number;
  /** Pitch as a note name ("e4") or Hz — or give `midi` instead. */
  note?: string | number;
  /** MIDI note number, as an alternative to `note`. */
  midi?: number;
  /** Key-down length in ticks (default 1). The instrument's release rings on after it. */
  gate?: number;
  /** Strength, as the `velocity` control. */
  level?: number;
  /** Stereo position, -1 to 1. */
  pan?: number;
  /**
   * Pan automation inside the note, in ticks from the onset, in order. The
   * first point is the pan at the onset (replacing `pan`); the pan moves
   * linearly from each point to the next, jumps when two points share a tick,
   * and holds the last value, through the release too.
   */
  panPath?: readonly ScorePanPoint[];
  /** Any further voice controls for this one note, such as an instrument from `fmVoice()`. */
  voice?: ControlPatch;
}

export interface ScoreDefinition {
  /** Tick rate in ticks per second — for example 560 for AdLib IMF data. */
  ticksPerSecond: number;
  /** Length of one pass of the cue in ticks, *including* any rest at the end. This is the loop length. */
  lengthTicks: number;
  events: readonly ScoreEvent[];
  /**
   * What happens to a note still held when the cue loops. 'cut' (default)
   * closes its gate at the seam, as classic chip music does; 'ring' lets the
   * gate run on past it. Either way the instrument's release rings on.
   */
  seam?: 'cut' | 'ring';
}

/** A compiled score: a one-cycle pattern, the tempo that makes one cycle equal one pass, and shortcuts to play it. */
export interface Score {
  /** One cycle is exactly `lengthTicks` ticks. */
  readonly pattern: Pattern<ControlPatch>;
  /** The `cps` that plays `pattern` at the score's own tick rate. */
  readonly cps: number;
  /** Cue length in seconds. */
  readonly seconds: number;
  /** Loops the cue at its own tempo; the seam is exact because cycle times are rational. */
  loop(options?: Omit<LoopOptions, 'bpm' | 'cps'>): LoopHandle;
  /** Plays one pass of the cue. */
  play(options?: Omit<PlayOptions, 'bpm' | 'cps'>): PlaybackHandle;
  /** Renders one pass of the cue offline at its own tempo. Add a `tail` to let releases ring out, or `wrap` it for a seamless loop. */
  render(
    options?: Omit<RenderOptions, 'bpm' | 'cps' | 'seconds'>
  ): Promise<RenderedAudioBufferLike>;
}

function requireInteger(value: number, label: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`score() ${label} must be an integer of at least ${min}, got ${value}`);
  }
}

/** A score event's pan path in seconds from its onset, checked: whole ticks that never go backwards, finite pans. */
function compilePanPath(
  points: readonly ScorePanPoint[],
  onset: number,
  ticksPerSecond: number
): PanPoint[] {
  let previous = 0;
  return points.map((point) => {
    requireInteger(point.tick, 'panPath tick', 0);
    if (point.tick < previous) {
      throw new Error(
        `score() panPath ticks must not go backwards, got ${point.tick} after ${previous} (event at tick ${onset})`
      );
    }
    if (!Number.isFinite(point.pan)) {
      throw new Error(
        `score() panPath pan must be a number, got ${point.pan} (event at tick ${onset})`
      );
    }
    previous = point.tick;
    return { time: point.tick / ticksPerSecond, pan: Math.max(-1, Math.min(1, point.pan)) };
  });
}

/**
 * Compiles explicitly timed events into a looping pattern. Pattern time stays
 * in exact fractions of the cue (`tick / lengthTicks`), so repeats land on the
 * audio clock without drift, and the tail rest after the last note is part of
 * the loop. Events are not snapped to any grid, which keeps hand-played feel
 * (repeated notes 73, 75, 75, 221 ticks apart) intact.
 */
export function score(definition: ScoreDefinition): Score {
  const { ticksPerSecond, lengthTicks } = definition;
  if (!(ticksPerSecond > 0)) {
    throw new Error(`score() ticksPerSecond must be positive, got ${ticksPerSecond}`);
  }
  requireInteger(lengthTicks, 'lengthTicks', 1);
  const seam = definition.seam ?? 'cut';

  const compiled = definition.events.map((event) => {
    requireInteger(event.tick, 'event tick', 0);
    if (event.tick >= lengthTicks) {
      throw new Error(
        `score() event tick ${event.tick} is outside the cue (length ${lengthTicks})`
      );
    }
    const gate = event.gate ?? 1;
    requireInteger(gate, 'event gate', 1);
    if (event.note === undefined && event.midi === undefined) {
      throw new Error(`score() event at tick ${event.tick} needs a note or midi`);
    }

    // The gate in seconds is what holds the envelope; 'cut' stops it at the seam.
    const gateTicks = seam === 'cut' ? Math.min(gate, lengthTicks - event.tick) : gate;
    const value: ControlPatch = {
      ...event.voice,
      pitch: event.note ?? midiToFrequency(event.midi as number),
      duration: gateTicks / ticksPerSecond
    };
    if (event.level !== undefined) value.velocity = event.level;
    if (event.pan !== undefined) value.pan = event.pan;
    if (event.panPath !== undefined && event.panPath.length > 0) {
      value.panPath = compilePanPath(event.panPath, event.tick, ticksPerSecond);
    }

    return {
      begin: new Fraction(event.tick, lengthTicks),
      // The event's own extent in pattern time; the gate itself is carried by `duration`.
      end: new Fraction(event.tick + gateTicks, lengthTicks),
      value
    };
  });
  compiled.sort((a, b) => a.begin.cmp(b.begin));

  const pattern = new Pattern<ControlPatch>((span: TimeSpan) => {
    const haps: Hap<ControlPatch>[] = [];
    for (let cycle = span.begin.floor(); new Fraction(cycle).lt(span.end); cycle++) {
      const offset = new Fraction(cycle);
      for (const event of compiled) {
        const whole = { begin: offset.add(event.begin), end: offset.add(event.end) };
        const begin = whole.begin.max(span.begin);
        const end = whole.end.min(span.end);
        if (begin.lt(end)) {
          haps.push({ whole, part: { begin, end }, value: event.value });
        }
      }
    }
    return haps;
  });

  const cps = ticksPerSecond / lengthTicks;
  return {
    pattern,
    cps,
    seconds: lengthTicks / ticksPerSecond,
    loop: (options = {}) => pattern.loop({ ...options, cps }),
    play: (options = {}) => pattern.play({ ...options, cps }),
    render: (options = {}) => pattern.render({ ...options, cps })
  };
}
