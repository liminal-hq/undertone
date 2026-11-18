// The pattern core: patterns as queries from cycle timespans to events, per the TidalCycles papers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction, ONE } from './fraction.js';
import { reseedFor } from './random.js';
import { voicingPitches } from './chord.js';
// mini.ts imports Pattern/cat/silence/stack/timecat/pure from this module, creating an ESM import
// cycle — safe here because both modules only reference each other's bindings inside function
// bodies (never at top-level module evaluation), same reasoning as scheduler.ts's PatternLike cut.
import type { PlaybackHandle } from './engine.js';
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
import { AUTOPAN_SHAPES } from './autopan.js';
import { renderToBuffer } from './render.js';
import type { RenderOptions } from './render.js';
import type { RenderedAudioBufferLike } from './types.js';
import { MAX_CHANNELS, surroundGains } from './surround.js';
import { isSoundType } from './types.js';
import { warnOnce } from './warn.js';
import type {
  ControlInput,
  ControlPatch,
  OscType,
  PanPoint,
  ShapedWaveType,
  SoundType,
  VoiceParams
} from './types.js';

const MODULATOR_WAVES: readonly (OscType | ShapedWaveType)[] = [
  'sine',
  'triangle',
  'square',
  'sawtooth',
  'halfsine',
  'abssine',
  'pulsesine'
];

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

/** Where an event reads a signal: its onset (the whole's begin), or its part's begin when it has no whole. */
function onsetOf(hap: Hap<unknown>): Fraction {
  return hap.whole?.begin ?? hap.part.begin;
}

function mapHapTime<T>(hap: Hap<T>, fn: (t: Fraction) => Fraction): Hap<T> {
  return {
    whole: hap.whole && mapSpan(hap.whole, fn),
    part: mapSpan(hap.part, fn),
    value: hap.value
  };
}

/** Frames per second for panpath()'s stepped form, as for pitchsteps(): the frame rate of classic AdLib effects. */
const DEFAULT_PAN_STEP_RATE = 140;

/** A frame-stepped pan as a pan path: each frame's pan holds until the next frame, then jumps. */
function steppedPanPath(pans: readonly number[], rateHz: number): PanPoint[] {
  const points: PanPoint[] = [{ time: 0, pan: pans[0] }];
  for (let frame = 1; frame < pans.length; frame++) {
    if (pans[frame] === pans[frame - 1]) {
      continue; // a held frame needs no point of its own
    }
    const time = frame / rateHz;
    points.push({ time, pan: pans[frame - 1] }, { time, pan: pans[frame] });
  }
  return points;
}

/** A point sampler: a continuous pattern's value at one instant of cycle time, or undefined where it has none. */
export type Sampler<T> = (t: Fraction) => T | undefined;

/**
 * A pattern is a function from a timespan (in cycles) to the events overlapping
 * it. Patterns are immutable: every combinator returns a new Pattern wrapping
 * the old query, so a partially-built pattern is always safe to branch or reuse.
 *
 * A continuous pattern (a signal: `sine`, `rand`, ...) also carries a point
 * `sample`r, its exact value at one instant. A discrete pattern carries none.
 * A single-child combinator (fast, rev, range, ...) passes its child's sampler
 * on, mapping time the same way its query does. A combinator over several
 * children (cat, seq, timecat, stack, arrange, every) carries a sampler when
 * any child has one, and at an instant reads the child that is active there
 * through its sampleAt(): a continuous child gives its exact value, a
 * discrete child the value of the event covering the instant (undefined in a
 * rest). So a mixed composition reads the same at an instant however a query
 * is cut up. Only a few things are not point-defined and stay query-only: a
 * discrete pattern's structure (a signal's `euclid()` and `segment()` read it
 * at each onset instead), and stack() of overlapping layers, which reads the
 * first layer with a value. See sampleAt().
 */
export class Pattern<T> {
  constructor(
    readonly query: (span: TimeSpan) => Hap<T>[],
    readonly sample?: Sampler<T>
  ) {}

  /**
   * The pattern's value at the instant `t`: the sampler's when there is one,
   * otherwise the value of the first event the query returns over
   * [t, next cycle) whose part covers `t` (undefined in a rest). The sampler
   * exists because the query route is wrong for a reversed signal (a query
   * over a mirrored span starts at the mirrored end) and costs a query per
   * read; wherever both are defined and the query route is right, they agree.
   */
  sampleAt(t: Fraction): T | undefined {
    if (this.sample) {
      return this.sample(t);
    }
    const covering = this.query({ begin: t, end: t.nextSam() }).find(
      (hap) => hap.part.begin.lte(t) && t.lt(hap.part.end)
    );
    return covering?.value;
  }

  /** Transforms every event value, keeping the pattern's structure. */
  fmap<U>(fn: (value: T) => U): Pattern<U> {
    const sample = this.sample;
    return new Pattern(
      (span) => this.query(span).map((hap) => ({ ...hap, value: fn(hap.value) })),
      sample &&
        ((t) => {
          const value = sample(t);
          return value === undefined ? undefined : fn(value);
        })
    );
  }

  private withTime(
    queryTime: (t: Fraction) => Fraction,
    hapTime: (t: Fraction) => Fraction
  ): Pattern<T> {
    const sample = this.sample;
    return new Pattern(
      (span) => this.query(mapSpan(span, queryTime)).map((hap) => mapHapTime(hap, hapTime)),
      sample && ((t) => sample(queryTime(t)))
    );
  }

  /**
   * Events from `structure`, each holding this pattern's value at its onset
   * (dropped where this pattern has none). The reading side of segment() and
   * of euclid() on a signal.
   */
  private readAt(structure: Pattern<unknown>): Pattern<T> {
    return new Pattern((span) =>
      structure.query(span).flatMap((hap) => {
        const value = this.sampleAt(onsetOf(hap));
        return value === undefined ? [] : [{ whole: hap.whole, part: hap.part, value }];
      })
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
    const sample = this.sample;
    return new Pattern(
      (span) =>
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
        }),
      // A point mirrors to a point: c + x reads c + 1 - x.
      sample &&
        ((t) => {
          const cycle = t.sam();
          return sample(cycle.add(cycle.add(ONE).sub(t)));
        })
    );
  }

  /** Applies `fn` to the pattern on every nth cycle (cycles 0, n, 2n, ...). */
  every(n: number, fn: (pat: Pattern<T>) => Pattern<T>): Pattern<T> {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`every() cycle count must be a positive integer, got ${n}`);
    }
    const transformed = fn(this);
    const pick = (cycle: number) => (((cycle % n) + n) % n === 0 ? transformed : this);
    return new Pattern(
      (span) =>
        splitIntoCycles(span).flatMap((cycleSpan) =>
          pick(cycleSpan.begin.floor()).query(cycleSpan)
        ),
      // Either side being continuous makes the result readable at a point.
      (this.sample || transformed.sample) && ((t) => pick(t.floor()).sampleAt(t))
    );
  }

  /**
   * Distributes the pattern over a euclidean rhythm: `pulses` onsets spread as
   * evenly as possible across `steps` slots per cycle (Bjorklund's algorithm),
   * optionally rotated left by `rotation` slots. The whole pattern is squeezed
   * into each onset slot, which for single-value patterns matches Strudel's
   * `"x(3,8)"` exactly. On a signal (a pattern with a sampler) it acts as a
   * structure instead: the rhythm's events, each holding the signal's value
   * at its onset.
   */
  euclid(pulses: number, steps: number, rotation = 0): Pattern<T> {
    const slots = rotate(bjorklund(pulses, steps), rotation);
    if (this.sample) {
      return this.readAt(seq(...slots.map((on) => (on ? pure(true) : silence))));
    }
    return seq(...slots.map((on) => (on ? this : (silence as Pattern<T>))));
  }

  /**
   * `count` evenly spaced events per cycle, each holding this pattern's value
   * at its onset (none where the pattern has no value there). The way to give
   * a signal a rhythm: `sine.segment(4)` is 0.5, 1, 0.5, 0.
   */
  segment(count: number): Pattern<T> {
    if (!(count > 0) || !Number.isFinite(count)) {
      throw new Error(`segment() count must be positive, got ${count}`);
    }
    return this.readAt(pure(true).fast(count));
  }

  /**
   * Chooses the seed of a random signal (`rand`, `rand2`, `perlin`, `irand()`,
   * `choose()`, `brand`, `brandBy()`); the default is 0. It works only
   * directly on the random signal, before range(), segment() or anything else.
   */
  seed(seed: number | string): Pattern<T> {
    const reseed = reseedFor(this);
    if (!reseed) {
      throw new Error(
        'seed() works directly on rand, rand2, perlin, irand(), choose() and brand — call it before range() or segment()'
      );
    }
    if (typeof seed === 'number' ? !Number.isFinite(seed) : typeof seed !== 'string') {
      throw new Error(`seed() needs a finite number or a string, got ${String(seed)}`);
    }
    return reseed(seed) as Pattern<T>;
  }

  // --- Numeric methods (patterns of numbers, signals among them) ---

  /** Maps values from 0..1 onto lo..hi, linearly (no clamping). */
  range(this: Pattern<number>, lo: number, hi: number): Pattern<number> {
    return this.fmap((v) => lo + v * (hi - lo));
  }

  /** Maps values from -1..1 onto lo..hi, linearly (no clamping). */
  range2(this: Pattern<number>, lo: number, hi: number): Pattern<number> {
    return this.fmap((v) => lo + ((v + 1) / 2) * (hi - lo));
  }

  /** Maps values from 0..1 onto lo..hi exponentially (`lo·(hi/lo)^v`), the curve for frequencies. Both bounds must be above 0. */
  rangex(this: Pattern<number>, lo: number, hi: number): Pattern<number> {
    if (!(lo > 0 && hi > 0 && Number.isFinite(lo) && Number.isFinite(hi))) {
      throw new Error(`rangex() bounds must be positive, got ${lo} and ${hi}`);
    }
    const ratio = hi / lo;
    return this.fmap((v) => lo * ratio ** v);
  }

  /**
   * Combines each value with a number, or with a pattern read at the value's
   * onset (structure from the left; an event is dropped where the right side
   * has no value). The result keeps a sampler when this pattern has one: the
   * right side is read through its own sampleAt(), whatever kind it is.
   */
  private arithmetic(
    this: Pattern<number>,
    name: string,
    other: number | Pattern<number>,
    op: (a: number, b: number) => number
  ): Pattern<number> {
    if (typeof other === 'number') {
      return this.fmap((v) => op(v, other));
    }
    if (!(other instanceof Pattern)) {
      throw new Error(`${name}() needs a number or a pattern of numbers`);
    }
    const sample = this.sample;
    return new Pattern(
      (span) =>
        this.query(span).flatMap((hap) => {
          const right = other.sampleAt(onsetOf(hap));
          return right === undefined ? [] : [{ ...hap, value: op(hap.value, right) }];
        }),
      sample &&
        ((t) => {
          const left = sample(t);
          const right = left === undefined ? undefined : other.sampleAt(t);
          return left === undefined || right === undefined ? undefined : op(left, right);
        })
    );
  }

  /** Adds a number, or a pattern read at each onset. */
  add(this: Pattern<number>, other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('add', other, (a, b) => a + b);
  }

  /** Subtracts a number, or a pattern read at each onset. */
  sub(this: Pattern<number>, other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('sub', other, (a, b) => a - b);
  }

  /** Multiplies by a number, or by a pattern read at each onset. */
  mul(this: Pattern<number>, other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('mul', other, (a, b) => a * b);
  }

  /** Divides by a number, or by a pattern read at each onset (by 0 gives Infinity). */
  div(this: Pattern<number>, other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('div', other, (a, b) => a / b);
  }

  /** Rounds each value to the nearest whole number (halves round up). */
  round(this: Pattern<number>): Pattern<number> {
    return this.fmap(Math.round);
  }

  /** Rounds each value down (-4.2 becomes -5). */
  floor(this: Pattern<number>): Pattern<number> {
    return this.fmap(Math.floor);
  }

  // --- Voice-control methods (only available on patterns of voice parameters) ---

  private withPatch(this: Pattern<ControlPatch>, patch: ControlPatch): Pattern<ControlPatch> {
    return this.fmap((value) => ({ ...value, ...patch }));
  }

  /**
   * Applies a whole instrument at once: merges a plain `ControlPatch` (such as
   * one from fmVoice() or fmPresets, or loaded from saved data) into every
   * event. Fields the patch sets overwrite the events', so call it before the
   * per-note controls you want to win — `note('e5 g5').voice(bell).gain(0.2)`.
   */
  voice(this: Pattern<ControlPatch>, patch: ControlPatch): Pattern<ControlPatch> {
    return this.withPatch(patch);
  }

  /**
   * Merges a control whose value may itself be patterned in time: `input` is
   * a plain number (applied uniformly, like withPatch), a mini-notation
   * string sampled per event, or a `Pattern<number>`. Structure comes from
   * `this` — for each of its haps, the control is read at the hap's own onset
   * time. A number or string keeps the covering-step search: whichever
   * control step covers that instant supplies the value, and a rest (`~`)
   * leaves the key unset for that hap. `validate`/`transform` run once per
   * distinct literal in a string, at build time (same eager-validation timing
   * as note()'s pitch parsing), before any query happens.
   *
   * A pattern with a sampler (a signal) is read at each onset with
   * sampleAt(), so the value depends only on the onset and never on how the
   * query was cut up; a pattern without one uses the same batched covering
   * search as a string. Values a pattern gives are sanitised and never
   * throw (see sanitiseControl()).
   */
  private withControlPattern(
    this: Pattern<ControlPatch>,
    key: keyof VoiceParams,
    input: ControlInput,
    options?: ControlOptions
  ): Pattern<ControlPatch> {
    const transform = options?.transform ?? ((v: number) => v);
    if (input instanceof Pattern) {
      return this.withControlSignal(key, input, options);
    }
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

  /** The Pattern branch of withControlPattern(): reads `input` per event, sanitising what it gives. */
  private withControlSignal(
    this: Pattern<ControlPatch>,
    key: keyof VoiceParams,
    input: Pattern<number>,
    options?: ControlOptions
  ): Pattern<ControlPatch> {
    const transform = options?.transform ?? ((v: number) => v);
    const apply = (hap: Hap<ControlPatch>, raw: unknown): Hap<ControlPatch> => {
      const value = sanitiseControl(raw, options);
      return value === undefined
        ? hap
        : { ...hap, value: { ...hap.value, [key]: transform(value) } };
    };
    if (input.sample) {
      return new Pattern((span) =>
        this.query(span).map((hap) => apply(hap, input.sampleAt(onsetOf(hap))))
      );
    }
    return new Pattern((span) => {
      const haps = this.query(span);
      if (haps.length === 0) {
        return haps;
      }
      let minT = onsetOf(haps[0]);
      let maxT = minT;
      for (const hap of haps) {
        const t = onsetOf(hap);
        if (t.lt(minT)) minT = t;
        if (t.gt(maxT)) maxT = t;
      }
      const controlHaps = input.query({ begin: minT, end: maxT.add(ONE) });
      return haps.map((hap) => {
        const t = onsetOf(hap);
        const covering = controlHaps.find((c) => c.part.begin.lte(t) && t.lt(c.part.end));
        return covering === undefined ? hap : apply(hap, covering.value);
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

  /** Amplitude envelope attack time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  attack(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('attack', seconds, { name: 'attack' });
  }

  /** Amplitude envelope decay time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  decay(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('decay', seconds, { name: 'decay' });
  }

  /**
   * Fraction (0-1) of gain the decay stage settles to before release.
   * Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  sustain(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('sustain', level, { name: 'sustain' });
  }

  /** Amplitude envelope release time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  release(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('release', seconds, { name: 'release' });
  }

  /** Peak amplitude (0-1). Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  gain(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('gainLevel', level, { name: 'gain' });
  }

  /**
   * Base lowpass cutoff in Hz. Creates a filter stage; omit entirely to skip
   * filtering. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  lpf(this: Pattern<ControlPatch>, hz: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('filterCutoff', hz, { name: 'lpf' });
  }

  /** Hz the filter envelope adds on top of lpf() at its peak. Accepts a number, a mini-notation string or a pattern. */
  lpenv(this: Pattern<ControlPatch>, hzAmount: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('filterEnvAmount', hzAmount, { name: 'lpenv' });
  }

  /** Filter envelope attack time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  lpa(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('filterAttack', seconds, { name: 'lpa' });
  }

  /** Filter envelope decay time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  lpd(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('filterDecay', seconds, { name: 'lpd' });
  }

  /**
   * Fraction (0-1) between lpf() and its envelope peak the decay stage settles
   * to. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  lps(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('filterSustain', level, { name: 'lps' });
  }

  /** Filter envelope release time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  lpr(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('filterRelease', seconds, { name: 'lpr' });
  }

  /**
   * Pitch glide (portamento): starts an octave above the target note and
   * slides down. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  slide(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('slideTime', seconds, { name: 'slide' });
  }

  /**
   * FM modulation index (Strudel's `fm`): the modulator swings the carrier's
   * frequency by index × the modulator's frequency, so the sound is equally
   * bright at every pitch. 0 turns it off. Synth voices only. Accepts a
   * number, a mini-notation string or a pattern.
   */
  fm(this: Pattern<ControlPatch>, index: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('fmIndex', index, {
      name: 'fm',
      unset: { when: (v) => v < 0, needs: '0 or more' },
      validate: (v) => {
        if (v < 0) {
          throw new Error(`fm() must not be negative, got ${v}`);
        }
      }
    });
  }

  /** Alias of fm() under Strudel's `fmi` name. */
  fmi(this: Pattern<ControlPatch>, index: ControlInput): Pattern<ControlPatch> {
    return this.fm(index);
  }

  /**
   * FM harmonicity (Strudel's `fmh`): the modulator's frequency as a multiple of
   * the carrier's. Whole numbers give harmonic tones; fractions such as 3.5 or
   * 2.76 give bells and metal. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  fmh(this: Pattern<ControlPatch>, ratio: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('fmHarmonicity', ratio, {
      name: 'fmh',
      unset: { when: (v) => !(v > 0), needs: 'more than 0' },
      validate: (v) => {
        if (!(v > 0)) {
          throw new Error(`fmh() must be positive, got ${v}`);
        }
      }
    });
  }

  /** Seconds for the FM depth to reach the full index. Accepts a number, a mini-notation string or a pattern. */
  fmattack(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('fmAttack', seconds, { name: 'fmattack' });
  }

  /** Seconds for the FM depth to fall to fmsustain() × the index (toward silence when fmsustain() is unset). Accepts a number, a mini-notation string or a pattern. */
  fmdecay(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('fmDecay', seconds, { name: 'fmdecay' });
  }

  /** Fraction (0-1) of the index the FM depth settles to (default 1, or 0 when only fmdecay() is set). Accepts a number, a mini-notation string or a pattern. */
  fmsustain(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('fmSustain', level, { name: 'fmsustain' });
  }

  /** Seconds for the FM depth to fall to 0 after the gate closes. Accepts a number, a mini-notation string or a pattern. */
  fmrelease(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('fmRelease', seconds, { name: 'fmrelease' });
  }

  /** Ramp shape of the FM depth envelope: 'exp' (default, as in Strudel) or 'lin'. Not patternable. */
  fmenv(this: Pattern<ControlPatch>, curve: 'lin' | 'exp'): Pattern<ControlPatch> {
    rejectPattern('fmenv', curve);
    if (curve !== 'lin' && curve !== 'exp') {
      throw new Error(`fmenv() must be 'lin' or 'exp', got "${String(curve)}"`);
    }
    return this.withPatch({ fmEnvCurve: curve });
  }

  /** The modulator's waveform: sine (default), triangle, square, sawtooth, or a shaped wave (halfsine, abssine, pulsesine). Not patternable. */
  fmwave(this: Pattern<ControlPatch>, type: OscType | ShapedWaveType): Pattern<ControlPatch> {
    rejectPattern('fmwave', type);
    if (!(MODULATOR_WAVES as readonly string[]).includes(type)) {
      throw new Error(
        `fmwave() must be one of ${MODULATOR_WAVES.join(', ')}, got "${String(type)}"`
      );
    }
    return this.withPatch({ fmWave: type });
  }

  /**
   * Pitch envelope depth in semitones (Strudel's `penv`): each note starts that
   * far from its pitch (negative = below) and returns to it over pdecay().
   * Rising and falling sweeps alike. Synth voices only. Accepts a
   * number, a mini-notation string or a pattern.
   */
  penv(this: Pattern<ControlPatch>, semitones: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('pitchEnvAmount', semitones, { name: 'penv' });
  }

  /** Seconds the pitch envelope takes to reach its offset (default 0: it starts there). Accepts a number, a mini-notation string or a pattern. */
  pattack(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('pitchAttack', seconds, { name: 'pattack' });
  }

  /** Seconds the pitch envelope takes to return to the note (default 0.1). Accepts a number, a mini-notation string or a pattern. */
  pdecay(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('pitchDecay', seconds, { name: 'pdecay' });
  }

  /**
   * A frame-stepped pitch curve: semitone offsets from each note, one per frame
   * at `rateHz` (default 140, the frame rate of classic AdLib effects), holding
   * the last offset. Falling and rising sweeps, wobbles and trills are all
   * just arrays of numbers. Plain data, not patternable. Overrides penv()
   * and slide().
   */
  pitchsteps(
    this: Pattern<ControlPatch>,
    semitones: readonly number[],
    rateHz?: number
  ): Pattern<ControlPatch> {
    rejectPattern('pitchsteps', semitones);
    if (semitones.length === 0 || !semitones.every((v) => Number.isFinite(v))) {
      throw new Error('pitchsteps() needs a non-empty array of finite semitone offsets');
    }
    if (rateHz !== undefined && !(rateHz > 0)) {
      throw new Error(`pitchsteps() rate must be positive, got ${rateHz}`);
    }
    return this.withPatch({
      pitchSteps: [...semitones],
      ...(rateHz !== undefined ? { pitchStepRate: rateHz } : {})
    });
  }

  /**
   * Explicit gate length in seconds: the envelopes hold at their sustain level
   * for this long, then release — independent of the event's length in the
   * pattern, and also in a one-shot play(). Needs a sustain above 0 to hold.
   * Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  duration(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('duration', seconds, {
      name: 'duration',
      unset: { when: (v) => v < 0, needs: '0 or more' },
      validate: (v) => {
        if (v < 0) {
          throw new Error(`duration() must not be negative, got ${v}`);
        }
      }
    });
  }

  /**
   * Gate length as a fraction of each event's own length (`.legato(0.5)` holds
   * half of it, `.legato(1)` all of it). Gates even in a one-shot play(), and
   * is overridden by an explicit duration(). Accepts a mini-notation string to
   * pattern it.
   */
  legato(this: Pattern<ControlPatch>, fraction: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('legato', fraction, {
      name: 'legato',
      unset: { when: (v) => v < 0, needs: '0 or more' },
      validate: (v) => {
        if (v < 0) {
          throw new Error(`legato() must not be negative, got ${v}`);
        }
      }
    });
  }

  /**
   * Note strength: multiplies the peak amplitude only, so one instrument keeps
   * its timbre from a ghost note (0.3) to an accent (1). Accepts a
   * number, a mini-notation string or a pattern.
   */
  velocity(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('velocity', level, {
      name: 'velocity',
      unset: { when: (v) => v < 0, needs: '0 or more' },
      validate: (v) => {
        if (v < 0) {
          throw new Error(`velocity() must not be negative, got ${v}`);
        }
      }
    });
  }

  /**
   * Cut group (Strudel/Tidal `cut`): a new event in the same group stops the
   * previous one with a very short fade — a closed hi-hat choking an open one,
   * or a monophonic line retriggering. The same number on different patterns
   * shares one group. Not patternable, like orbit().
   */
  cut(this: Pattern<ControlPatch>, group: number): Pattern<ControlPatch> {
    rejectPattern('cut', group);
    if (!Number.isInteger(group) || group < 0) {
      throw new Error(`cut() must be a non-negative integer, got ${group}`);
    }
    return this.withPatch({ cutGroup: group });
  }

  /**
   * Start-time offset in seconds applied to every event when played. Accepts a
   * number, a mini-notation string or a pattern.
   */
  nudge(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('nudgeTime', seconds, { name: 'nudge' });
  }

  /** Delays every event by `seconds` — an alias of nudge() under Strudel's name. */
  late(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('nudgeTime', seconds, { name: 'late' });
  }

  /** Moves every event `seconds` earlier — the negative of late()/nudge(). */
  early(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('nudgeTime', seconds, {
      name: 'early',
      transform: (v) => -v
    });
  }

  /**
   * Stereo position, -1 (hard left) to 1 (hard right). Accepts a mini-notation
   * string to pattern it; every literal in the string is range-checked.
   */
  pan(this: Pattern<ControlPatch>, position: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('pan', position, {
      name: 'pan',
      clamp: [-1, 1],
      validate: (v) => {
        if (v < -1 || v > 1) {
          throw new Error(`pan() position must be between -1 and 1, got ${v}`);
        }
      }
    });
  }

  /**
   * Pan slide (the pan's own slide()): each note starts at pan `from` and
   * moves linearly to its pan (the centre without one) over `seconds`, or over
   * the note's attack when omitted. Accepts a number, a mini-notation string or a pattern for `from` (clamped to -1 to 1);
   * `seconds` is scalar. A panpath() takes precedence.
   */
  panslide(
    this: Pattern<ControlPatch>,
    from: ControlInput,
    seconds?: number
  ): Pattern<ControlPatch> {
    rejectPattern('panslide', seconds);
    if (seconds !== undefined && !(seconds >= 0 && Number.isFinite(seconds))) {
      throw new Error(`panslide() time must be zero or more seconds, got ${seconds}`);
    }
    const timed = seconds === undefined ? this : this.withPatch({ panSlideTime: seconds });
    return timed.withControlPattern('panSlideFrom', from, {
      name: 'panslide',
      clamp: [-1, 1],
      validate: (v) => {
        if (v < -1 || v > 1) {
          throw new Error(`panslide() start must be between -1 and 1, got ${v}`);
        }
      }
    });
  }

  /**
   * Autopan: an LFO at `hz` swings each note's pan either side of its pan()
   * (or its panpath() or panslide()), from the onset through the release, as
   * a real oscillator on the panner, not booked points. Shape it with
   * autopandepth(), autopanshape() and autopanphase(). Accepts a
   * number, a mini-notation string or a pattern.
   */
  autopan(this: Pattern<ControlPatch>, hz: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('autopan', hz, {
      name: 'autopan',
      unset: { when: (v) => !(v > 0), needs: 'more than 0' },
      validate: (v) => {
        if (!(v > 0) || !Number.isFinite(v)) {
          throw new Error(`autopan() rate must be positive, got ${v}`);
        }
      }
    });
  }

  /** How far autopan() swings either side of the pan, 0 to 1 (default 1). Accepts a number, a mini-notation string or a pattern. */
  autopandepth(this: Pattern<ControlPatch>, depth: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('autopanDepth', depth, {
      name: 'autopandepth',
      clamp: [0, 1],
      validate: (v) => {
        if (!(v >= 0 && v <= 1)) {
          throw new Error(`autopandepth() must be between 0 and 1, got ${v}`);
        }
      }
    });
  }

  /** The autopan() LFO's wave: 'sine' (default), 'triangle' or 'square'. Not patternable. */
  autopanshape(
    this: Pattern<ControlPatch>,
    shape: 'sine' | 'triangle' | 'square'
  ): Pattern<ControlPatch> {
    rejectPattern('autopanshape', shape);
    if (!AUTOPAN_SHAPES.includes(shape)) {
      throw new Error(`autopanshape() must be sine, triangle or square, got ${String(shape)}`);
    }
    return this.withPatch({ autopanShape: shape });
  }

  /**
   * Where in its cycle autopan() starts, 0 to 1 of a cycle (default 0: a sine
   * or triangle starts at the pan moving right, a square on the right; 0.5
   * starts the other way). Accepts a number, a mini-notation string or a
   * pattern, so a note's LFO can start where the last one left off:
   * `.autopanphase(saw.slow(4))`. A pattern's values are clamped to 0 to 1.
   */
  autopanphase(this: Pattern<ControlPatch>, phase: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('autopanPhase', phase, {
      name: 'autopanphase',
      clamp: [0, 1],
      validate: (v) => {
        if (!(v >= 0 && v <= 1)) {
          throw new Error(`autopanphase() must be between 0 and 1, got ${v}`);
        }
      }
    });
  }

  /**
   * Pan automation inside each note, as plain data. Give an array of pans for
   * a frame-stepped path, one per frame at `rateHz` (default 140, the frame
   * rate of classic AdLib effects), jumping from frame to frame and holding
   * the last; or give `{ time, pan }` points in seconds from the onset, which
   * ramp linearly (two points at one time make a jump). Either way it becomes
   * the voice's `panPath`, replacing pan(). Pans are -1 to 1. Not patternable.
   */
  panpath(
    this: Pattern<ControlPatch>,
    path: readonly number[] | readonly PanPoint[],
    rateHz?: number
  ): Pattern<ControlPatch> {
    rejectPattern('panpath', path);
    if (path.length === 0) {
      throw new Error('panpath() needs a non-empty array of pans or { time, pan } points');
    }
    const inRange = (pan: unknown) => typeof pan === 'number' && pan >= -1 && pan <= 1;
    if (path.every((item) => typeof item === 'number')) {
      const pans = path as readonly number[];
      if (!pans.every(inRange)) {
        throw new Error('panpath() needs pans between -1 and 1');
      }
      if (rateHz !== undefined && !(rateHz > 0 && Number.isFinite(rateHz))) {
        throw new Error(`panpath() rate must be positive, got ${rateHz}`);
      }
      return this.withPatch({ panPath: steppedPanPath(pans, rateHz ?? DEFAULT_PAN_STEP_RATE) });
    }
    if (rateHz !== undefined) {
      throw new Error(
        'panpath() takes a rate only with an array of pans, not with { time, pan } points'
      );
    }
    let previous = 0;
    for (const point of path as readonly PanPoint[]) {
      if (
        typeof point !== 'object' ||
        point === null ||
        !Number.isFinite(point.time) ||
        !inRange(point.pan)
      ) {
        throw new Error('panpath() points need a finite time and a pan between -1 and 1');
      }
      if (point.time < previous) {
        throw new Error(
          `panpath() times must not go backwards, got ${point.time} after ${previous}`
        );
      }
      previous = point.time;
    }
    return this.withPatch({
      panPath: (path as readonly PanPoint[]).map(({ time, pan }) => ({ time, pan }))
    });
  }

  /**
   * Pan law: each side's level at the centre in dB, from -6 to 0. The default,
   * -3, is the stereo panner's equal-power law; 0 keeps the louder side full
   * like a balance control, and -6 dips the centre further. Shapes only voices
   * that are panned (pan() or a panPath). Scalar only, like orbit().
   */
  panlaw(this: Pattern<ControlPatch>, db: number): Pattern<ControlPatch> {
    rejectPattern('panlaw', db);
    if (!Number.isFinite(db) || db < -6 || db > 0) {
      throw new Error(`panlaw() must be between -6 and 0 dB, got ${db}`);
    }
    return this.withPatch({ panLaw: db });
  }

  /**
   * Static highpass cutoff in Hz, in series after lpf(). Creates a filter
   * stage; omit entirely to skip it. Accepts a number, a mini-notation string or a pattern.
   */
  hpf(this: Pattern<ControlPatch>, hz: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('hpfCutoff', hz, { name: 'hpf' });
  }

  /**
   * LFO rate in Hz driving a 4-stage allpass phaser. Creates the phaser stage;
   * omit entirely to skip it. Accepts a number, a mini-notation string or a pattern.
   */
  phaser(this: Pattern<ControlPatch>, rateHz: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('phaserRate', rateHz, { name: 'phaser' });
  }

  /**
   * Reverb send level (0-1) to this voice's orbit bus (see orbit()). No send
   * at all when omitted. Accepts a number, a mini-notation string or a pattern.
   */
  room(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('roomLevel', level, { name: 'room' });
  }

  /**
   * Reverb decay character for the orbit's shared bus, roughly 1 (short) to
   * 10 (long) — see effects.ts's getOrbitBus(). Accepts a mini-notation
   * string.
   */
  roomsize(this: Pattern<ControlPatch>, size: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('roomSize', size, { name: 'roomsize' });
  }

  /**
   * Delay send level (0-1) to this voice's orbit bus (see orbit()). No send
   * at all when omitted. Accepts a number, a mini-notation string or a pattern.
   */
  delay(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('delayLevel', level, { name: 'delay' });
  }

  /** Delay time in seconds for the orbit's shared delay bus. Accepts a number, a mini-notation string or a pattern. */
  delaytime(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('delayTime', seconds, { name: 'delaytime' });
  }

  /** Feedback (0-1) for the orbit's shared delay bus. Accepts a number, a mini-notation string or a pattern. */
  delayfeedback(this: Pattern<ControlPatch>, amount: ControlInput): Pattern<ControlPatch> {
    return this.withControlPattern('delayFeedback', amount, { name: 'delayfeedback' });
  }

  /**
   * Which shared effects bus (see effects.ts's getOrbitBus()) this voice's
   * room()/delay() sends target. Default 0. Every voice sending to the same
   * orbit shares one reverb and one delay line, so give a voice its own orbit
   * number when it needs a distinct room size or delay time from its
   * neighbours. Scalar only — not a mini-notation-patterned control.
   */
  orbit(this: Pattern<ControlPatch>, n: number): Pattern<ControlPatch> {
    rejectPattern('orbit', n);
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
    rejectPattern('channels', gains);
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
    rejectPattern('surround', angleDegrees);
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
   * Plays one cycle's worth of events as a one-shot. Envelopes are percussive
   * by default (0.1.x SFX behaviour) — pass `{ gated: true }` to hold each
   * event for its own share of the cycle instead, like loop(). Uses a
   * lazily-created shared AudioContext when none is passed — call from a
   * user gesture the first time (autoplay policy).
   */
  play(this: Pattern<ControlPatch>, options: PlayOptions = {}): PlaybackHandle {
    return playPattern(this, options);
  }

  /** Loops the pattern until stop() is called on the returned handle. */
  loop(this: Pattern<ControlPatch>, options: LoopOptions = {}): LoopHandle {
    return loopPattern(this, options);
  }

  /**
   * Renders the pattern offline to an audio buffer, with no real-time clock and
   * a seeded random source, so the same pattern gives the same samples on the
   * same engine. Pass the result to `encodeWav` to write a file.
   */
  render(
    this: Pattern<ControlPatch>,
    options: RenderOptions = {}
  ): Promise<RenderedAudioBufferLike> {
    return renderToBuffer(this, options);
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

/** Options for withControlPattern(): the control's name for messages, build-time checks for literals, and the rule for what a pattern may give. */
interface ControlOptions {
  /** The method's name, for warnings: `pan` reads as `pan()`. */
  name: string;
  /** Build-time check of each literal in a number or string (throws). */
  validate?: (v: number) => void;
  transform?: (v: number) => number;
  /** A bounded range: a value a pattern gives outside it is clamped, with one warning. */
  clamp?: readonly [number, number];
  /** An open bound: a value a pattern gives that matches `when` leaves the key unset, with one warning saying what `needs`. */
  unset?: { when: (v: number) => boolean; needs: string };
}

/**
 * The value a pattern gives a control, made safe: reading a pattern must never
 * throw (a throw would end a loop's tick), so a bad value is dealt with and
 * warned about once per control and kind of problem. A rest (`undefined`)
 * leaves the key unset silently; NaN, Infinity and anything that is not a
 * number leave it unset with a warning; a bounded control clamps; an open
 * bound (`unset`) leaves the key unset. Returns undefined for "leave unset".
 */
function sanitiseControl(raw: unknown, options?: ControlOptions): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const name = options?.name ?? 'control';
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    warnOnce(
      `signal-nan-${name}`,
      `undertone: ${name}() got ${String(raw)} from a pattern; left unset.`
    );
    return undefined;
  }
  if (options?.clamp) {
    const [lo, hi] = options.clamp;
    const clamped = Math.min(hi, Math.max(lo, raw));
    if (clamped !== raw) {
      warnOnce(
        `signal-range-${name}`,
        `undertone: ${name}() got ${raw} from a pattern; clamped to ${clamped}.`
      );
    }
    return clamped;
  }
  if (options?.unset?.when(raw)) {
    warnOnce(
      `signal-range-${name}`,
      `undertone: ${name}() got ${raw} from a pattern; it needs ${options.unset.needs}, so it is left unset.`
    );
    return undefined;
  }
  return raw;
}

/** Throws a clear error when a scalar-only control is given a pattern. */
function rejectPattern(name: string, value: unknown): void {
  if (value instanceof Pattern) {
    throw new Error(
      `${name}() takes a plain value, not a pattern; it cannot change from event to event`
    );
  }
}

/**
 * Builds a `Pattern<number>` from a scalar or a mini-notation string of numbers
 * (e.g. `".1 .2"`, `"<.25 .72>"`) — the value side of a patterned control.
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
  const sample = pat.sample;
  return new Pattern(
    (span) =>
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
      }),
    // Inside the window a point maps in as the query does; outside it there is no value.
    sample &&
      ((t) => {
        const cycle = t.sam();
        const pos = t.sub(cycle);
        if (pos.lt(winBegin) || pos.gte(winEnd)) {
          return undefined;
        }
        return sample(cycle.add(pos.sub(winBegin).div(width)));
      })
  );
}

/**
 * Plays all patterns simultaneously (polyphony: chords, layers, parallel
 * lines). When any layer is continuous it carries a sampler that reads the
 * first layer with a value at the instant (overlapping layers have no single
 * value, so the first one wins, as sampleAt() always did for a stack).
 */
export function stack<T>(...pats: Pattern<T>[]): Pattern<T> {
  return new Pattern(
    (span) => pats.flatMap((pat) => pat.query(span)),
    pats.some((pat) => pat.sample)
      ? (t) => {
          for (const pat of pats) {
            const value = pat.sampleAt(t);
            if (value !== undefined) {
              return value;
            }
          }
          return undefined;
        }
      : undefined
  );
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
  // The windows never overlap, so at most one part has a value at any instant,
  // and stack() reading the first part with a value is exact.
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
  // The chosen pattern and the shift that makes it experience its own
  // consecutive cycles — what makes nested alternations like <a <b c>>
  // unfold as a b a c.
  const choose = (cycle: number) => ({
    pat: pats[((cycle % pats.length) + pats.length) % pats.length],
    offset: new Fraction(cycle - Math.floor(cycle / pats.length))
  });
  return new Pattern(
    (span) =>
      splitIntoCycles(span).flatMap((cycleSpan) => {
        const { pat, offset } = choose(cycleSpan.begin.floor());
        const shifted = mapSpan(cycleSpan, (t) => t.sub(offset));
        return pat.query(shifted).map((hap) => mapHapTime(hap, (t) => t.add(offset)));
      }),
    pats.some((pat) => pat.sample)
      ? (t) => {
          const { pat, offset } = choose(t.floor());
          return pat.sampleAt(t.sub(offset));
        }
      : undefined
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
  // The section playing in `cycle`, and the shift that makes its pattern
  // experience its own cycles from 0, restarting at the top of every pass
  // through the arrangement.
  const sectionAt = (cycle: number) => {
    const local = ((cycle % total) + total) % total;
    const index = sections.findIndex((section, i) => local < starts[i] + section[0]);
    return { pat: sections[index][1], offset: new Fraction(cycle - (local - starts[index])) };
  };
  return new Pattern(
    (span) =>
      splitIntoCycles(span).flatMap((cycleSpan) => {
        const { pat, offset } = sectionAt(cycleSpan.begin.floor());
        const shifted = mapSpan(cycleSpan, (t) => t.sub(offset));
        return pat.query(shifted).map((hap) => mapHapTime(hap, (t) => t.add(offset)));
      }),
    sections.some(([, pat]) => pat.sample)
      ? (t) => {
          const { pat, offset } = sectionAt(t.floor());
          return pat.sampleAt(t.sub(offset));
        }
      : undefined
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
