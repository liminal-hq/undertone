// The pattern core: patterns as queries from cycle timespans to events, per the TidalCycles papers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction, ONE } from './fraction.js';
import { voicingPitches } from './chord.js';
// mini.ts imports Pattern/cat/silence/stack/timecat/pure from this module, creating an ESM import
// cycle — safe here because both modules only reference each other's bindings inside function
// bodies (never at top-level module evaluation), same reasoning as scheduler.ts's PatternLike cut.
import { mini } from './mini.js';
import { midiToFrequency } from './pitch.js';
import { degreeToMidi, parseScale } from './scale.js';
import {
  loopPattern,
  playPattern,
  type LoopHandle,
  type LoopOptions,
  type PlayOptions
} from './scheduler.js';
import { MAX_CHANNELS, surroundGains } from './surround.js';
import { isSoundType } from './types.js';
import type { ControlPatch, SoundType, VoiceParams } from './types.js';

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

  /**
   * Merges a control whose value may itself be patterned in time: `input` is
   * either a plain number (applied uniformly, like withPatch) or a
   * mini-notation string sampled per event. Structure comes from `this` —
   * for each of its haps, the control is queried at the hap's own onset time
   * and whichever control step covers that instant supplies the value; a rest
   * (`~`) in the control at that instant leaves the key unset for that hap.
   * `validate`/`transform` run once per distinct literal in the control
   * string, at build time (same eager-validation timing as note()'s pitch
   * parsing), before any query happens.
   */
  private withControlPattern(
    this: Pattern<ControlPatch>,
    key: keyof VoiceParams,
    input: number | string,
    options?: { validate?: (v: number) => void; transform?: (v: number) => number }
  ): Pattern<ControlPatch> {
    const transform = options?.transform ?? ((v: number) => v);
    const control = numberPattern(input, options?.validate).fmap(transform);
    return new Pattern((span) => {
      const haps = this.query(span);
      if (haps.length === 0) {
        return haps;
      }
      // One control query covering every hap's onset, instead of one query
      // per hap — a busy pattern with several chained patterned controls
      // would otherwise multiply query work on every onset in the
      // scheduler's per-tick lookahead.
      let minT = haps[0].whole?.begin ?? haps[0].part.begin;
      let maxT = minT;
      for (const hap of haps) {
        const t = hap.whole?.begin ?? hap.part.begin;
        if (t.lt(minT)) minT = t;
        if (t.gt(maxT)) maxT = t;
      }
      const controlHaps = control.query({ begin: minT, end: maxT.add(ONE) });
      return haps.map((hap) => {
        const t = hap.whole?.begin ?? hap.part.begin;
        const covering = controlHaps.find((c) => c.part.begin.lte(t) && t.lt(c.part.end));
        return covering === undefined
          ? hap
          : { ...hap, value: { ...hap.value, [key]: covering.value } };
      });
    });
  }

  /**
   * Sets/overrides the oscillator waveform or noise type across all events,
   * clearing any sample name set by .s() — sampleName otherwise takes
   * precedence over soundType in the engine, so without this a prior .s()
   * would keep playing its sample silently through a later .sound() call.
   */
  sound(this: Pattern<ControlPatch>, type: SoundType): Pattern<ControlPatch> {
    return this.withPatch({ soundType: type, sampleName: undefined });
  }

  /**
   * Sets the voice to a synth SoundType or a registered sample name — a synth
   * type behaves exactly like sound(); anything else becomes a sample name
   * (see samples.ts's registerSample()), clearing any previous sample name or
   * synth type respectively so the two never both apply at once.
   */
  s(this: Pattern<ControlPatch>, name: SoundType | string): Pattern<ControlPatch> {
    return isSoundType(name)
      ? this.withPatch({ soundType: name, sampleName: undefined })
      : this.withPatch({ sampleName: name, soundType: undefined });
  }

  /** Bank prefix for sample lookup — tried as `${name}_${sampleName}` before falling back to bare `sampleName`. */
  bank(this: Pattern<ControlPatch>, name: string): Pattern<ControlPatch> {
    return this.withPatch({ sampleBank: name });
  }

  /**
   * Resolves scale-degree events from n() into real pitches: `spec` is a scale
   * string like `"D5:minor"`. Events without a `degree` (already pitched via
   * note(), or unpitched noise from sound()) pass through unchanged.
   */
  scale(this: Pattern<ControlPatch>, spec: string): Pattern<ControlPatch> {
    // Parsed once here — also serves as eager validation, same timing as
    // note()'s pitch parsing — and reused for every event, instead of
    // re-parsing `spec` from scratch on each one.
    const parsed = parseScale(spec);
    return this.fmap((value) => {
      if (value.degree === undefined) {
        return value;
      }
      const { degree, ...rest } = value;
      return { ...rest, pitch: midiToFrequency(degreeToMidi(parsed, degree)) };
    });
  }

  /**
   * Expands chord-symbol events from chord() into simultaneous note events —
   * one chord onset becomes N notes sharing the same whole/part, exactly the
   * shape stack()ed chords already produce downstream (the scheduler/engine
   * need no changes at all to play them). Events without a `chord` (already
   * pitched via note()/n()) pass through unchanged.
   */
  voicing(
    this: Pattern<ControlPatch>,
    options?: { anchor?: string | number }
  ): Pattern<ControlPatch> {
    // Chord symbols cycle through a small, repeating vocabulary (e.g. a
    // 4-chord progression), so memoizing voicingPitches() by symbol avoids
    // re-parsing and re-voicing the same chord on every single onset.
    const cache = new Map<string, number[]>();
    return new Pattern((span) =>
      this.query(span).flatMap((hap) => {
        const { chord: symbol, ...rest } = hap.value;
        if (symbol === undefined) {
          return [hap];
        }
        let pitches = cache.get(symbol);
        if (pitches === undefined) {
          pitches = voicingPitches(symbol, options);
          cache.set(symbol, pitches);
        }
        return pitches.map((midi) => ({
          ...hap,
          value: { ...rest, pitch: midiToFrequency(midi) }
        }));
      })
    );
  }

  /** Amplitude envelope attack time, in seconds. Accepts a mini-notation string to pattern it. */
  attack(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('attack', seconds);
  }

  /** Amplitude envelope decay time, in seconds. Accepts a mini-notation string to pattern it. */
  decay(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('decay', seconds);
  }

  /**
   * Fraction (0-1) of gain the decay stage settles to before release.
   * Accepts a mini-notation string to pattern it.
   */
  sustain(this: Pattern<ControlPatch>, level: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('sustain', level);
  }

  /** Amplitude envelope release time, in seconds. Accepts a mini-notation string to pattern it. */
  release(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('release', seconds);
  }

  /** Peak amplitude (0-1). Accepts a mini-notation string to pattern it. */
  gain(this: Pattern<ControlPatch>, level: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('gainLevel', level);
  }

  /**
   * Base lowpass cutoff in Hz. Creates a filter stage; omit entirely to skip
   * filtering. Accepts a mini-notation string to pattern it.
   */
  lpf(this: Pattern<ControlPatch>, hz: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('filterCutoff', hz);
  }

  /** Hz the filter envelope adds on top of lpf() at its peak. Accepts a mini-notation string. */
  lpenv(this: Pattern<ControlPatch>, hzAmount: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('filterEnvAmount', hzAmount);
  }

  /** Filter envelope attack time, in seconds. Accepts a mini-notation string to pattern it. */
  lpa(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('filterAttack', seconds);
  }

  /** Filter envelope decay time, in seconds. Accepts a mini-notation string to pattern it. */
  lpd(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('filterDecay', seconds);
  }

  /**
   * Fraction (0-1) between lpf() and its envelope peak the decay stage settles
   * to. Accepts a mini-notation string to pattern it.
   */
  lps(this: Pattern<ControlPatch>, level: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('filterSustain', level);
  }

  /** Filter envelope release time, in seconds. Accepts a mini-notation string to pattern it. */
  lpr(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('filterRelease', seconds);
  }

  /**
   * Pitch glide (portamento): starts an octave above the target note and
   * slides down. Accepts a mini-notation string to pattern it.
   */
  slide(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('slideTime', seconds);
  }

  /**
   * Start-time offset in seconds applied to every event when played. Accepts a
   * mini-notation string to pattern it.
   */
  nudge(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('nudgeTime', seconds);
  }

  /** Delays every event by `seconds` — an alias of nudge() under Strudel's name. */
  late(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('nudgeTime', seconds);
  }

  /** Moves every event `seconds` earlier — the negative of late()/nudge(). */
  early(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('nudgeTime', seconds, { transform: (v) => -v });
  }

  /**
   * Stereo position, -1 (hard left) to 1 (hard right). Accepts a mini-notation
   * string to pattern it; every literal in the string is range-checked.
   */
  pan(this: Pattern<ControlPatch>, position: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('pan', position, {
      validate: (v) => {
        if (v < -1 || v > 1) {
          throw new Error(`pan() position must be between -1 and 1, got ${v}`);
        }
      }
    });
  }

  /**
   * Static highpass cutoff in Hz, in series after lpf(). Creates a filter
   * stage; omit entirely to skip it. Accepts a mini-notation string.
   */
  hpf(this: Pattern<ControlPatch>, hz: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('hpfCutoff', hz);
  }

  /**
   * LFO rate in Hz driving a 4-stage allpass phaser. Creates the phaser stage;
   * omit entirely to skip it. Accepts a mini-notation string.
   */
  phaser(this: Pattern<ControlPatch>, rateHz: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('phaserRate', rateHz);
  }

  /**
   * Reverb send level (0-1) to this voice's orbit bus (see orbit()). No send
   * at all when omitted. Accepts a mini-notation string.
   */
  room(this: Pattern<ControlPatch>, level: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('roomLevel', level);
  }

  /**
   * Reverb decay character for the orbit's shared bus, roughly 1 (short) to
   * 10 (long) — see effects.ts's getOrbitBus(). Accepts a mini-notation
   * string.
   */
  roomsize(this: Pattern<ControlPatch>, size: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('roomSize', size);
  }

  /**
   * Delay send level (0-1) to this voice's orbit bus (see orbit()). No send
   * at all when omitted. Accepts a mini-notation string.
   */
  delay(this: Pattern<ControlPatch>, level: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('delayLevel', level);
  }

  /** Delay time in seconds for the orbit's shared delay bus. Accepts a mini-notation string. */
  delaytime(this: Pattern<ControlPatch>, seconds: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('delayTime', seconds);
  }

  /** Feedback (0-1) for the orbit's shared delay bus. Accepts a mini-notation string. */
  delayfeedback(this: Pattern<ControlPatch>, amount: number | string): Pattern<ControlPatch> {
    return this.withControlPattern('delayFeedback', amount);
  }

  /**
   * Which shared effects bus (see effects.ts's getOrbitBus()) this voice's
   * room()/delay() sends target. Default 0. Every voice sending to the same
   * orbit shares one reverb and one delay line, so give a voice its own orbit
   * number when it needs a distinct room size or delay time from its
   * neighbours. Scalar only — not a mini-notation-patterned control.
   */
  orbit(this: Pattern<ControlPatch>, n: number): Pattern<ControlPatch> {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`orbit() must be a non-negative integer, got ${n}`);
    }
    return this.withPatch({ orbit: n });
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

// Deliberately stricter than JS's own Number() coercion (no exponents, no
// leading '+', no bare "Infinity") and, unlike note()/sound()'s leaf regexes,
// accepts a leading-dot form like ".155" — the natural way to write levels
// under 1 in a patterned-parameter string.
const NUMBER_WORD_PATTERN = /^-?(\d+(\.\d+)?|\.\d+)$/;

function parseNumberWord(word: string): number {
  if (!NUMBER_WORD_PATTERN.test(word)) {
    throw new Error(`Invalid number in pattern: "${word}"`);
  }
  return Number(word);
}

/**
 * Builds a Pattern<number> from a scalar or a mini-notation string of numbers
 * (e.g. ".1 .2", "<.25 .72>") — the value side of a patterned control.
 * `validate` runs once per distinct literal at build time, matching the eager
 * validation timing note()/sound() already use for their own leaf words.
 */
function numberPattern(input: number | string, validate?: (v: number) => void): Pattern<number> {
  if (typeof input === 'number') {
    validate?.(input);
    return pure(input);
  }
  return mini<number>(input, (word) => {
    const value = parseNumberWord(word);
    validate?.(value);
    return value;
  });
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
  for (const [weight] of pairs) {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`timecat() weights must be positive, got ${weight}`);
    }
  }
  if (pairs.length === 0) {
    return silence as Pattern<T>;
  }
  const total = pairs.reduce((sum, [weight]) => sum.add(Fraction.from(weight)), new Fraction(0));
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
 * Plays each pattern for its own span of whole cycles, in order, looping the
 * whole arrangement once the total cycle count is reached — the backbone of a
 * multi-section song (`arrange([8, intro], [16, verse], [8, outro])`). Each
 * section's pattern experiences its own cycles starting at 0 whenever its span
 * begins, so `<a b c>` inside a section always opens on `a` no matter where that
 * section falls within the overall arrangement.
 */
export function arrange<T>(...sections: [cycles: number, pat: Pattern<T>][]): Pattern<T> {
  for (const [cycles] of sections) {
    if (!Number.isInteger(cycles) || cycles <= 0) {
      throw new Error(`arrange() cycle counts must be positive integers, got ${cycles}`);
    }
  }
  if (sections.length === 0) {
    return silence as Pattern<T>;
  }
  const starts: number[] = [];
  let total = 0;
  for (const [cycles] of sections) {
    starts.push(total);
    total += cycles;
  }
  return new Pattern((span) =>
    splitIntoCycles(span).flatMap((cycleSpan) => {
      const cycle = cycleSpan.begin.floor();
      const local = ((cycle % total) + total) % total;
      const index = sections.findIndex((section, i) => local < starts[i] + section[0]);
      const sectionStart = starts[index];
      const pat = sections[index][1];
      // Shift time so the section pattern experiences its own cycles from 0,
      // restarting at the top of every pass through the arrangement.
      const offset = new Fraction(cycle - (local - sectionStart));
      const shifted = mapSpan(cycleSpan, (t) => t.sub(offset));
      return pat.query(shifted).map((hap) => mapHapTime(hap, (t) => t.add(offset)));
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
