// A tick-based score compiled to a looping pattern, from the module; playing and rendering wait for the engine exports
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type {
  LoopHandle,
  LoopOptions,
  PlayOptions,
  PlaybackHandle,
  RenderOptions
} from './engineTypes.js';
import { patternOfHandle } from './pattern.js';
import type { Pattern } from './pattern.js';
import type { ControlPatch, RenderedAudioBufferLike } from './types.js';
import { glue } from './wasm.js';

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
  /**
   * An autopan LFO on this note: one cycle every `periodTicks` (a whole number
   * of ticks), swinging `depth` (0 to 1) either side of the note's pan, with an
   * optional `shape` (default 'sine') and starting `phase` (0 to 1 of a cycle,
   * default 0). Carried into the `autopan` voice controls in Hz.
   */
  autopan?: ScoreAutopan;
  /** Any further voice controls for this one note, such as an instrument from `fmVoice()`. */
  voice?: ControlPatch;
}

/** A score event's autopan, in ticks like the event's other fields. */
export interface ScoreAutopan {
  /** Ticks per LFO cycle, a whole number of at least 1. */
  periodTicks: number;
  /** Swing either side of the note's pan, 0 to 1. */
  depth: number;
  /** The LFO's wave. Default 'sine'. */
  shape?: 'sine' | 'triangle' | 'square';
  /** Where in its cycle the LFO starts, 0 to 1. Default 0. */
  phase?: number;
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
  /**
   * Pan law for every event, in dB at the centre (-6 to 0), as the `panLaw`
   * voice control; an event whose `voice` sets its own `panLaw` keeps it.
   * Default: the stereo panner's -3 dB. Events with no pan are unaffected.
   */
  panLaw?: number;
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

/** What a score's playing methods say until the engine exports land (RF-24 part 2b, wrapped by RF-25c). */
function notYet(method: string): never {
  throw new Error(
    `score().${method}() is not available until the engine exports land: this package has the score's pattern and tempo now, and plays them in the next part`
  );
}

/**
 * Compiles explicitly timed events into a looping pattern. Pattern time stays
 * in exact fractions of the cue (`tick / lengthTicks`), so repeats land on the
 * audio clock without drift, and the tail rest after the last note is part of
 * the loop. Events are not snapped to any grid, which keeps hand-played feel
 * (repeated notes 73, 75, 75, 221 ticks apart) intact.
 */
export function score(definition: ScoreDefinition): Score {
  const handle = glue.score(definition);
  const pattern = patternOfHandle<ControlPatch>(handle.pattern());
  const cps = handle.cps;
  const seconds = handle.seconds;
  // The pattern is its own handle; the score's is not needed until the engine exports play and render through it.
  handle.free();
  return {
    pattern,
    cps,
    seconds,
    loop: () => notYet('loop'),
    play: () => notYet('play'),
    render: () => notYet('render')
  };
}
