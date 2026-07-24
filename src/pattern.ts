// The pattern core: patterns as queries from cycle timespans to events, per the TidalCycles papers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction, ONE } from './fraction.js';
import {
  loopPattern,
  playPattern,
  type LoopHandle,
  type LoopOptions,
  type PlayOptions
} from './scheduler.js';
import { MAX_CHANNELS, surroundGains } from './surround.js';
import type { ControlPatch, SoundType } from './types.js';

/** A half-open span of cycle time [begin, end). */
export interface TimeSpan {
  readonly begin: Fraction;
  readonly end: Fraction;
}

/**
 * One event returned by querying a pattern. `part` is the fragment of the event
 * inside the queried span; `whole` is the event's full extent, which may reach
 * outside the query. An event is an onset (actually triggers a voice) only when
 * `part` starts exactly where `whole` does — see hasOnset().
 */
export interface Hap<T> {
  readonly whole?: TimeSpan;
  readonly part: TimeSpan;
  readonly value: T;
}

/** True when the hap's part contains the event's onset, i.e. it should trigger. */
export function hasOnset(hap: Hap<unknown>): boolean {
  return hap.whole !== undefined && hap.whole.begin.eq(hap.part.begin);
}

function intersect(a: TimeSpan, b: TimeSpan): TimeSpan | undefined {
  const begin = a.begin.max(b.begin);
  const end = a.end.min(b.end);
  return begin.lt(end) ? { begin, end } : undefined;
}

/** Splits a span at cycle boundaries so per-cycle constructs can reason one cycle at a time. */
function splitIntoCycles(span: TimeSpan): TimeSpan[] {
  const spans: TimeSpan[] = [];
  let begin = span.begin;
  while (begin.lt(span.end)) {
    const end = begin.nextSam().min(span.end);
    spans.push({ begin, end });
    begin = end;
  }
  return spans;
}

function mapSpan(span: TimeSpan, fn: (t: Fraction) => Fraction): TimeSpan {
  return { begin: fn(span.begin), end: fn(span.end) };
}

function mapHapTime<T>(hap: Hap<T>, fn: (t: Fraction) => Fraction): Hap<T> {
  return {
    whole: hap.whole && mapSpan(hap.whole, fn),
    part: mapSpan(hap.part, fn),
    value: hap.value
  };
}

/**
 * A pattern is a function from a timespan (in cycles) to the events overlapping
 * it. Patterns are immutable: every combinator returns a new Pattern wrapping
 * the old query, so a partially-built pattern is always safe to branch or reuse.
 */
export class Pattern<T> {
  constructor(readonly query: (span: TimeSpan) => Hap<T>[]) {}

  /** Transforms every event value, keeping the pattern's structure. */
  fmap<U>(fn: (value: T) => U): Pattern<U> {
    return new Pattern((span) => this.query(span).map((hap) => ({ ...hap, value: fn(hap.value) })));
  }

  private withTime(
    queryTime: (t: Fraction) => Fraction,
    hapTime: (t: Fraction) => Fraction
  ): Pattern<T> {
    return new Pattern((span) =>
      this.query(mapSpan(span, queryTime)).map((hap) => mapHapTime(hap, hapTime))
    );
  }

  /** Speeds the pattern up: `fast(2)` squeezes two cycles into every one. */
  fast(factor: number): Pattern<T> {
    const f = Fraction.from(factor);
    if (f.n <= 0) {
      throw new Error(`fast() factor must be positive, got ${factor}`);
    }
    return this.withTime(
      (t) => t.mul(f),
      (t) => t.div(f)
    );
  }

  /** Slows the pattern down: `slow(2)` stretches one cycle over two. */
  slow(factor: number): Pattern<T> {
    const f = Fraction.from(factor);
    if (f.n <= 0) {
      throw new Error(`slow() factor must be positive, got ${factor}`);
    }
    return this.withTime(
      (t) => t.div(f),
      (t) => t.mul(f)
    );
  }

  /** Reverses each cycle in time (cycle-local mirror, the classic `rev`). */
  rev(): Pattern<T> {
    return new Pattern((span) =>
      splitIntoCycles(span).flatMap((cycleSpan) => {
        const cycle = cycleSpan.begin.sam();
        // Mirror around the cycle's midpoint: t -> cycle + (cycle + 1 - t)
        const mirror = (t: Fraction) => cycle.add(cycle.add(ONE).sub(t));
        const reflect = (s: TimeSpan) => ({ begin: mirror(s.end), end: mirror(s.begin) });
        return this.query(reflect(cycleSpan)).map((hap) => ({
          whole: hap.whole && reflect(hap.whole),
          part: reflect(hap.part),
          value: hap.value
        }));
      })
    );
  }

  /** Applies `fn` to the pattern on every nth cycle (cycles 0, n, 2n, ...). */
  every(n: number, fn: (pat: Pattern<T>) => Pattern<T>): Pattern<T> {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`every() cycle count must be a positive integer, got ${n}`);
    }
    const transformed = fn(this);
    return new Pattern((span) =>
      splitIntoCycles(span).flatMap((cycleSpan) => {
        const cycle = cycleSpan.begin.floor();
        const target = ((cycle % n) + n) % n === 0 ? transformed : this;
        return target.query(cycleSpan);
      })
    );
  }

  /**
   * Distributes the pattern over a euclidean rhythm: `pulses` onsets spread as
   * evenly as possible across `steps` slots per cycle (Bjorklund's algorithm),
   * optionally rotated left by `rotation` slots. The whole pattern is squeezed
   * into each onset slot, which for single-value patterns matches Strudel's
   * `"x(3,8)"` exactly.
   */
  euclid(pulses: number, steps: number, rotation = 0): Pattern<T> {
    const slots = rotate(bjorklund(pulses, steps), rotation);
    return seq(...slots.map((on) => (on ? this : (silence as Pattern<T>))));
  }

  // --- Voice-control methods (only available on patterns of voice parameters) ---

  private withPatch(this: Pattern<ControlPatch>, patch: ControlPatch): Pattern<ControlPatch> {
    return this.fmap((value) => ({ ...value, ...patch }));
  }

  /** Sets/overrides the oscillator waveform or noise type across all events. */
  sound(this: Pattern<ControlPatch>, type: SoundType): Pattern<ControlPatch> {
    return this.withPatch({ soundType: type });
  }

  attack(this: Pattern<ControlPatch>, seconds: number): Pattern<ControlPatch> {
    return this.withPatch({ attack: seconds });
  }

  decay(this: Pattern<ControlPatch>, seconds: number): Pattern<ControlPatch> {
    return this.withPatch({ decay: seconds });
  }

  /** Fraction (0-1) of gain the decay stage settles to before release. */
  sustain(this: Pattern<ControlPatch>, level: number): Pattern<ControlPatch> {
    return this.withPatch({ sustain: level });
  }

  release(this: Pattern<ControlPatch>, seconds: number): Pattern<ControlPatch> {
    return this.withPatch({ release: seconds });
  }

  gain(this: Pattern<ControlPatch>, level: number): Pattern<ControlPatch> {
    return this.withPatch({ gainLevel: level });
  }

  /** Base lowpass cutoff in Hz. Creates a filter stage; omit to skip filtering entirely. */
  lpf(this: Pattern<ControlPatch>, hz: number): Pattern<ControlPatch> {
    return this.withPatch({ filterCutoff: hz });
  }

  /** Hz the filter envelope adds on top of lpf() at its peak. */
  lpenv(this: Pattern<ControlPatch>, hzAmount: number): Pattern<ControlPatch> {
    return this.withPatch({ filterEnvAmount: hzAmount });
  }

  lpa(this: Pattern<ControlPatch>, seconds: number): Pattern<ControlPatch> {
    return this.withPatch({ filterAttack: seconds });
  }

  lpd(this: Pattern<ControlPatch>, seconds: number): Pattern<ControlPatch> {
    return this.withPatch({ filterDecay: seconds });
  }

  /** Fraction (0-1) between lpf() and its envelope peak the decay stage settles to. */
  lps(this: Pattern<ControlPatch>, level: number): Pattern<ControlPatch> {
    return this.withPatch({ filterSustain: level });
  }

  lpr(this: Pattern<ControlPatch>, seconds: number): Pattern<ControlPatch> {
    return this.withPatch({ filterRelease: seconds });
  }

  /** Pitch glide (portamento): starts an octave above the target note and slides down. */
  slide(this: Pattern<ControlPatch>, seconds: number): Pattern<ControlPatch> {
    return this.withPatch({ slideTime: seconds });
  }

  /** Start-time offset in seconds applied to every event when played. */
  nudge(this: Pattern<ControlPatch>, seconds: number): Pattern<ControlPatch> {
    return this.withPatch({ nudgeTime: seconds });
  }

  /** Stereo position, -1 (hard left) to 1 (hard right). */
  pan(this: Pattern<ControlPatch>, position: number): Pattern<ControlPatch> {
    if (position < -1 || position > 1) {
      throw new Error(`pan() position must be between -1 and 1, got ${position}`);
    }
    return this.withPatch({ pan: position });
  }

  /**
   * Multichannel (up to 7.1) placement: per-speaker output gains in the order
   * FL, FR, C, LFE, SL, SR, RL, RR (1-8 entries). Takes precedence over
   * pan(). On destinations that can't address that many speakers (or without
   * enableMultichannel()), the voice folds down to stereo automatically.
   */
  channels(this: Pattern<ControlPatch>, gains: number[]): Pattern<ControlPatch> {
    if (gains.length < 1 || gains.length > MAX_CHANNELS) {
      throw new Error(`channels() takes 1-${MAX_CHANNELS} gains, got ${gains.length}`);
    }
    for (const level of gains) {
      if (!Number.isFinite(level) || level < 0) {
        throw new Error(`channels() gains must be finite and >= 0, got ${level}`);
      }
    }
    return this.withPatch({ channelGains: [...gains] });
  }

  /**
   * Places the voice at an angle on the 7.1 speaker ring: 0° front-centre,
   * ±30° front, ±90° sides, ±150° rears, ±180° dead-behind — equal-power
   * panned between the two nearest speakers. Sugar for channels(surroundGains(angle)).
   */
  surround(this: Pattern<ControlPatch>, angleDegrees: number): Pattern<ControlPatch> {
    return this.withPatch({ channelGains: surroundGains(angleDegrees) });
  }

  /**
   * Juxtaposes the pattern with a transformed copy of itself: the original
   * plays hard left, `fn(pattern)` plays hard right — e.g. `pat.jux(rev)`.
   */
  jux(
    this: Pattern<ControlPatch>,
    fn: (pat: Pattern<ControlPatch>) => Pattern<ControlPatch>
  ): Pattern<ControlPatch> {
    return stack(this.pan(-1), fn(this).pan(1));
  }

  /**
   * Plays one cycle's worth of events as a one-shot sound effect (each event's
   * gate length comes from its share of the cycle). Uses a lazily-created
   * shared AudioContext when none is passed — call from a user gesture the
   * first time (autoplay policy).
   */
  play(this: Pattern<ControlPatch>, options: PlayOptions = {}): void {
    playPattern(this, options);
  }

  /** Loops the pattern until stop() is called on the returned handle. */
  loop(this: Pattern<ControlPatch>, options: LoopOptions = {}): LoopHandle {
    return loopPattern(this, options);
  }
}

/** Standalone cycle-reversal, for point-free style: `pat.jux(rev)`. */
export function rev<T>(pat: Pattern<T>): Pattern<T> {
  return pat.rev();
}

/** The empty pattern: querying it never returns events. */
export const silence: Pattern<never> = new Pattern(() => []);

/** A pattern that repeats `value` once per cycle. */
export function pure<T>(value: T): Pattern<T> {
  return new Pattern((span) =>
    splitIntoCycles(span).map((part) => ({
      whole: { begin: part.begin.sam(), end: part.begin.nextSam() },
      part,
      value
    }))
  );
}

/**
 * Squeezes each cycle of `pat` into the window [winBegin, winEnd) of each cycle
 * (both in [0, 1]). The building block for seq/timecat.
 */
function compress<T>(winBegin: Fraction, winEnd: Fraction, pat: Pattern<T>): Pattern<T> {
  const width = winEnd.sub(winBegin);
  if (width.n <= 0) {
    return silence as Pattern<T>;
  }
  return new Pattern((span) =>
    splitIntoCycles(span).flatMap((cycleSpan) => {
      const cycle = cycleSpan.begin.sam();
      const window: TimeSpan = { begin: cycle.add(winBegin), end: cycle.add(winEnd) };
      const clipped = intersect(cycleSpan, window);
      if (!clipped) {
        return [];
      }
      const toInner = (t: Fraction) => cycle.add(t.sub(window.begin).div(width));
      const toOuter = (t: Fraction) => window.begin.add(t.sub(cycle).mul(width));
      return pat.query(mapSpan(clipped, toInner)).map((hap) => mapHapTime(hap, toOuter));
    })
  );
}

/** Plays all patterns simultaneously (polyphony: chords, layers, parallel lines). */
export function stack<T>(...pats: Pattern<T>[]): Pattern<T> {
  return new Pattern((span) => pats.flatMap((pat) => pat.query(span)));
}

/**
 * Concatenates patterns within a single cycle, each taking `weight` of the
 * cycle proportionally. `seq` is timecat with equal weights.
 */
export function timecat<T>(pairs: [number, Pattern<T>][]): Pattern<T> {
  const total = pairs.reduce((sum, [weight]) => sum.add(Fraction.from(weight)), new Fraction(0));
  if (total.n <= 0) {
    return silence as Pattern<T>;
  }
  let pos = new Fraction(0);
  const parts = pairs.map(([weight, pat]) => {
    const w = Fraction.from(weight);
    const begin = pos.div(total);
    pos = pos.add(w);
    return compress(begin, pos.div(total), pat);
  });
  return stack(...parts);
}

/** Plays the given patterns one after another within each single cycle. */
export function seq<T>(...pats: Pattern<T>[]): Pattern<T> {
  return timecat(pats.map((pat) => [1, pat] as [number, Pattern<T>]));
}

/** Plays one pattern per cycle, in rotation (Tidal's slowcat). */
export function cat<T>(...pats: Pattern<T>[]): Pattern<T> {
  if (pats.length === 0) {
    return silence as Pattern<T>;
  }
  return new Pattern((span) =>
    splitIntoCycles(span).flatMap((cycleSpan) => {
      const cycle = cycleSpan.begin.floor();
      const index = ((cycle % pats.length) + pats.length) % pats.length;
      // Shift time so the chosen pattern experiences its own consecutive cycles —
      // this is what makes nested alternations like <a <b c>> unfold as a b a c.
      const offset = new Fraction(cycle - Math.floor(cycle / pats.length));
      const shifted = mapSpan(cycleSpan, (t) => t.sub(offset));
      return pats[index].query(shifted).map((hap) => mapHapTime(hap, (t) => t.add(offset)));
    })
  );
}

/**
 * Bjorklund's algorithm: distributes `pulses` onsets as evenly as possible
 * across `steps` slots, matching the canonical euclidean rhythms (E(3,8) is the
 * tresillo x..x..x.).
 */
export function bjorklund(pulses: number, steps: number): boolean[] {
  if (!Number.isInteger(pulses) || !Number.isInteger(steps) || steps <= 0) {
    throw new Error(`Invalid euclidean rhythm: (${pulses},${steps})`);
  }
  if (pulses < 0 || pulses > steps) {
    throw new Error(`Euclidean pulses must be between 0 and steps, got (${pulses},${steps})`);
  }
  if (pulses === 0) {
    return new Array<boolean>(steps).fill(false);
  }
  let a: boolean[][] = Array.from({ length: pulses }, () => [true]);
  let b: boolean[][] = Array.from({ length: steps - pulses }, () => [false]);
  while (b.length > 1) {
    const take = Math.min(a.length, b.length);
    const combined = a.slice(0, take).map((group, i) => [...group, ...b[i]]);
    const leftoverA = a.slice(take);
    const leftoverB = b.slice(take);
    a = combined;
    b = leftoverA.length > 0 ? leftoverA : leftoverB;
  }
  return [...a, ...b].flat();
}

function rotate(slots: boolean[], rotation: number): boolean[] {
  if (!Number.isInteger(rotation)) {
    throw new Error(`Euclidean rotation must be an integer, got ${rotation}`);
  }
  const len = slots.length;
  const shift = ((rotation % len) + len) % len;
  return slots.map((_, i) => slots[(i + shift) % len]);
}
