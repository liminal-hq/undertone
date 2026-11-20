// The Pattern class over a WebAssembly handle, its haps, and the constructors that build patterns
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction } from './fraction.js';
import type { ControlPatch } from './types.js';
import { glue } from './wasm.js';
import type { WasmPattern } from './wasm.js';

// The rules this file follows are in docs/rust-migration/results/M6-BOUNDARY.md: a Pattern holds one handle; every method returns
// a new Pattern; lists cross as a PatternList of borrowing pushes; `every` and `jux` hand Rust a thunk that calls the user's
// function once with this very Pattern; a query comes back as the flat encoding and is decoded into Hap objects here.

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

/** A point sampler: a continuous pattern's value at one instant of cycle time, or undefined where it has none. */
export type Sampler<T> = (t: Fraction) => T | undefined;

/** True when the hap's part contains the event's onset, i.e. it should trigger. */
export function hasOnset(hap: Hap<unknown>): boolean {
  return hap.whole !== undefined && hap.whole.begin.eq(hap.part.begin);
}

// --- The flat encoding (boundary section 3) ---

type Encoded = [Float64Array, unknown[], string[] | undefined];

/** A fraction from its two slots: two numbers, or NaN and an index into the texts of the fractions beyond 2^53. */
function decodeFraction(n: number, d: number, big: string[] | undefined): Fraction {
  return Number.isNaN(n) ? Fraction.fromText((big as string[])[d]) : new Fraction(n, d);
}

function decodeHaps<T>([times, values, big]: Encoded): Hap<T>[] {
  const haps: Hap<T>[] = [];
  for (let at = 0; at < times.length; at += 9) {
    const part = {
      begin: decodeFraction(times[at], times[at + 1], big),
      end: decodeFraction(times[at + 2], times[at + 3], big)
    };
    const value = values[times[at + 8]] as T;
    if (times[at + 4] === 0 && times[at + 5] === 0 && times[at + 6] === 0 && times[at + 7] === 0) {
      haps.push({ part, value });
    } else {
      const whole = {
        begin: decodeFraction(times[at + 4], times[at + 5], big),
        end: decodeFraction(times[at + 6], times[at + 7], big)
      };
      haps.push({ whole, part, value });
    }
  }
  return haps;
}

/** Writes a fraction into two slots of `times`: its numbers, or NaN and the index of its text in `big`. */
function encodeFraction(f: Fraction, times: Float64Array, at: number, big: string[]): void {
  if (Number.isSafeInteger(f.n) && Number.isSafeInteger(f.d)) {
    times[at] = f.n;
    times[at + 1] = f.d;
  } else {
    times[at] = Number.NaN;
    times[at + 1] = big.length;
    big.push(f.toString());
  }
}

/** Haps in the flat encoding, for a JavaScript query to return to Rust. */
function encodeHaps<T>(haps: readonly Hap<T>[]): Encoded {
  const times = new Float64Array(haps.length * 9);
  const values: unknown[] = [];
  const big: string[] = [];
  haps.forEach((hap, i) => {
    const at = i * 9;
    encodeFraction(hap.part.begin, times, at, big);
    encodeFraction(hap.part.end, times, at + 2, big);
    if (hap.whole) {
      encodeFraction(hap.whole.begin, times, at + 4, big);
      encodeFraction(hap.whole.end, times, at + 6, big);
    }
    times[at + 8] = values.length;
    values.push(hap.value);
  });
  return [times, values, big.length > 0 ? big : undefined];
}

/** The fractions Rust passes to a JavaScript function: two numbers each, or NaN and the text, in order. */
function readTimes(args: unknown[], count: number): Fraction[] {
  const out: Fraction[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const n = args[at] as number;
    const d = args[at + 1];
    if (Number.isNaN(n)) out.push(Fraction.fromText(d as string));
    else out.push(new Fraction(n, d as number));
    at += 2;
  }
  return out;
}

// --- Handles ---

/** Set for the one constructor call that adopts a handle instead of building a foreign leaf. */
let adopting: (() => WasmPattern) | undefined;

/** The wasm handle behind a Pattern, throwing when it was freed. Set by the class's static block. */
let handleOf: (pattern: Pattern<unknown>) => WasmPattern;
/** A Pattern around a handle, or around a function that makes one the first time it is needed. */
let wrap: <T>(handle: WasmPattern | (() => WasmPattern)) => Pattern<T>;

/**
 * A pattern is a function from a timespan (in cycles) to the events overlapping
 * it. Patterns are immutable: every combinator returns a new Pattern, so a
 * partially-built pattern is always safe to branch or reuse.
 *
 * A pattern holds a handle to the Rust tree in WebAssembly memory. The garbage
 * collector frees it eventually, but it cannot see that memory, so a long loop
 * that builds many patterns should call `free()` (or declare the pattern with
 * `using`) when it is done with one.
 *
 * A continuous pattern (a signal: `sine`, `rand`, ...) also carries a point
 * sampler, its exact value at one instant; see `sampleAt()`.
 */
export class Pattern<T> {
  #handle: WasmPattern | undefined;
  #make: (() => WasmPattern) | undefined;
  #freed = false;
  #query: ((span: TimeSpan) => Hap<T>[]) | undefined;

  /**
   * A pattern from your own query function, and optionally a point sampler. The pattern runs on the thread that made it:
   * the worklet backend refuses a pattern that holds one of these.
   */
  constructor(query: (span: TimeSpan) => Hap<T>[], sample?: Sampler<T>) {
    if (adopting) {
      this.#make = adopting;
      adopting = undefined;
      return;
    }
    this.#handle = glue.fromQuery(
      (...args: unknown[]) => {
        const [begin, end] = readTimes(args, 2);
        return encodeHaps(query({ begin, end }));
      },
      sample
        ? (...args: unknown[]) => {
            const [t] = readTimes(args, 1);
            return sample(t);
          }
        : undefined
    );
  }

  static {
    handleOf = (pattern) => pattern.#get();
    wrap = <U>(handle: WasmPattern | (() => WasmPattern)) => {
      adopting = typeof handle === 'function' ? handle : () => handle;
      return new Pattern<U>(undefined as never);
    };
  }

  #get(): WasmPattern {
    if (this.#freed) {
      throw new Error('this pattern was freed and cannot be used again');
    }
    if (!this.#handle) {
      this.#handle = (this.#make as () => WasmPattern)();
      this.#make = undefined;
    }
    return this.#handle;
  }

  /**
   * Queries the pattern: the events overlapping the span, each with exact
   * `Fraction` times. Every query returns new objects.
   */
  get query(): (span: TimeSpan) => Hap<T>[] {
    return (this.#query ??= (span) => {
      const { begin, end } = span;
      const handle = this.#get();
      const safe = [begin.n, begin.d, end.n, end.d].every(Number.isSafeInteger);
      const encoded = safe
        ? handle.query(begin.n, begin.d, end.n, end.d)
        : handle.queryRatio(begin.toString(), end.toString());
      return decodeHaps<T>(encoded as unknown as Encoded);
    });
  }

  /** The point sampler of a continuous pattern, or undefined for a discrete one. */
  get sample(): Sampler<T> | undefined {
    return this.#get().hasSampler() ? (t) => this.sampleAt(t) : undefined;
  }

  /**
   * The pattern's value at the instant `t`: the sampler's when there is one,
   * otherwise the value of the first event covering `t` (undefined in a rest).
   */
  sampleAt(t: Fraction): T | undefined {
    const handle = this.#get();
    const value =
      Number.isSafeInteger(t.n) && Number.isSafeInteger(t.d)
        ? handle.sampleAt(t.n, t.d)
        : handle.sampleAtRatio(t.toString());
    return value as T | undefined;
  }

  /** Transforms every event value, keeping the pattern's structure. */
  fmap<U>(fn: (value: T) => U): Pattern<U> {
    return wrap(this.#get().fmap((values: T[]) => values.map((value) => fn(value))));
  }

  /** Speeds the pattern up: `fast(2)` squeezes two cycles into every one. */
  fast(factor: number): Pattern<T> {
    return wrap(this.#get().fast(factor));
  }

  /** Slows the pattern down: `slow(2)` stretches one cycle over two. */
  slow(factor: number): Pattern<T> {
    return wrap(this.#get().slow(factor));
  }

  /** Reverses each cycle in time (cycle-local mirror, the classic `rev`). */
  rev(): Pattern<T> {
    return wrap(this.#get().rev());
  }

  /** Applies `fn` to the pattern on every nth cycle (cycles 0, n, 2n, ...). `fn` is called once, here. */
  every(n: number, fn: (pat: Pattern<T>) => Pattern<T>): Pattern<T> {
    return wrap(this.#get().every(n, () => thunkResult(fn(this))));
  }

  /**
   * Distributes the pattern over a euclidean rhythm: `pulses` onsets spread as
   * evenly as possible across `steps` slots (Bjorklund's algorithm), optionally
   * rotated left by `rotation` slots.
   */
  euclid(pulses: number, steps: number, rotation = 0): Pattern<T> {
    return wrap(this.#get().euclid(pulses, steps, rotation));
  }

  /** `count` evenly spaced events per cycle, each holding this pattern's value at its onset. */
  segment(count: number): Pattern<T> {
    return wrap(this.#get().segment(count));
  }

  /** Chooses the seed of a random signal; it works only directly on the random signal. */
  seed(seed: number | string): Pattern<T> {
    return wrap(this.#get().seed(seed));
  }

  /** Maps values from 0..1 onto lo..hi, linearly (no clamping). */
  range(this: Pattern<number>, lo: number, hi: number): Pattern<number> {
    return wrap(handleOf(this).range(lo, hi));
  }

  /** Maps values from -1..1 onto lo..hi, linearly (no clamping). */
  range2(this: Pattern<number>, lo: number, hi: number): Pattern<number> {
    return wrap(handleOf(this).range2(lo, hi));
  }

  /** Maps values from 0..1 onto lo..hi exponentially (`lo·(hi/lo)^v`). Both bounds must be above 0. */
  rangex(this: Pattern<number>, lo: number, hi: number): Pattern<number> {
    return wrap(handleOf(this).rangex(lo, hi));
  }

  /** Combines each value with a number, or with a pattern read at the value's onset. */
  private arithmetic(
    this: Pattern<number>,
    name: string,
    other: number | Pattern<number>
  ): Pattern<number> {
    const handle = handleOf(this);
    if (typeof other === 'number') {
      return wrap(handle.arith(name, other));
    }
    if (!(other instanceof Pattern)) {
      throw new Error(`${name}() needs a number or a pattern of numbers`);
    }
    return wrap(handle.arithPattern(name, handleOf(other)));
  }

  /** Adds a number, or a pattern read at each onset. */
  add(this: Pattern<number>, other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('add', other);
  }

  /** Subtracts a number, or a pattern read at each onset. */
  sub(this: Pattern<number>, other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('sub', other);
  }

  /** Multiplies by a number, or by a pattern read at each onset. */
  mul(this: Pattern<number>, other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('mul', other);
  }

  /** Divides by a number, or by a pattern read at each onset (by 0 gives Infinity). */
  div(this: Pattern<number>, other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('div', other);
  }

  /** Rounds each value to the nearest whole number (halves round up). */
  round(this: Pattern<number>): Pattern<number> {
    return wrap(handleOf(this).round());
  }

  /** Rounds each value down (-4.2 becomes -5). */
  floor(this: Pattern<number>): Pattern<number> {
    return wrap(handleOf(this).floor());
  }

  /** Plays the pattern as it is on one side and transformed by `fn` on the other. `fn` is called once, here. */
  jux(
    this: Pattern<ControlPatch>,
    fn: (pat: Pattern<ControlPatch>) => Pattern<ControlPatch>
  ): Pattern<ControlPatch> {
    return wrap(handleOf(this).jux(() => thunkResult(fn(this))));
  }

  /**
   * Frees the pattern's WebAssembly memory at once. Safe to call twice. The
   * pattern cannot be used afterwards; other patterns made from it are not
   * affected.
   */
  free(): void {
    if (this.#freed) return;
    this.#freed = true;
    this.#handle?.free();
    this.#handle = undefined;
    this.#make = undefined;
    this.#query = undefined;
  }

  /** Lets `using pattern = ...` free the pattern at the end of the block. */
  [Symbol.dispose](): void {
    this.free();
  }
}

/**
 * What Rust gets back from a transform's thunk: a fresh clone of the handle of the pattern the user's function returned (so
 * nothing the user holds is taken). Anything else goes back as it is, and Rust refuses it with its own message.
 */
function thunkResult(result: unknown): unknown {
  return result instanceof Pattern ? handleOf(result).clone() : result;
}

// --- Constructors ---

/** The empty pattern: querying it never returns events. */
export const silence: Pattern<never> = wrap(() => glue.silence());

/** A pattern that repeats `value` once per cycle. */
export function pure<T>(value: T): Pattern<T> {
  return wrap(glue.pure(value));
}

/** Standalone cycle-reversal, for point-free style: `pat.jux(rev)`. */
export function rev<T>(pat: Pattern<T>): Pattern<T> {
  return pat.rev();
}

/** Runs `build` with a list of the patterns, then frees the list (it only borrowed them). */
function withList<T>(
  pats: readonly Pattern<T>[],
  push: (list: InstanceType<typeof glue.PatternList>, pat: Pattern<T>, index: number) => void,
  build: (list: InstanceType<typeof glue.PatternList>) => WasmPattern
): Pattern<T> {
  const list = new glue.PatternList();
  try {
    pats.forEach((pat, index) => push(list, pat, index));
    return wrap(build(list));
  } finally {
    list.free();
  }
}

/** Plays all patterns simultaneously (polyphony: chords, layers, parallel lines). */
export function stack<T>(...pats: Pattern<T>[]): Pattern<T> {
  return withList(
    pats,
    (list, pat) => list.push(handleOf(pat)),
    (list) => glue.stack(list)
  );
}

/**
 * Concatenates patterns within a single cycle, each taking `weight` of the
 * cycle proportionally. `seq` is timecat with equal weights.
 */
export function timecat<T>(pairs: [number, Pattern<T>][]): Pattern<T> {
  const list = new glue.PatternList();
  try {
    for (const [weight, pat] of pairs) list.pushWeighted(weight, handleOf(pat));
    return wrap(glue.timecat(list));
  } finally {
    list.free();
  }
}

/** Plays the given patterns one after another within each single cycle. */
export function seq<T>(...pats: Pattern<T>[]): Pattern<T> {
  return withList(
    pats,
    (list, pat) => list.push(handleOf(pat)),
    (list) => glue.seq(list)
  );
}

/** Plays one pattern per cycle, in rotation (Tidal's slowcat). */
export function cat<T>(...pats: Pattern<T>[]): Pattern<T> {
  return withList(
    pats,
    (list, pat) => list.push(handleOf(pat)),
    (list) => glue.cat(list)
  );
}

/**
 * Plays each pattern for its own span of whole cycles, in order, looping the
 * whole arrangement once the total cycle count is reached — the backbone of a
 * multi-section song (`arrange([8, intro], [16, verse], [8, outro])`).
 */
export function arrange<T>(...sections: [cycles: number, pat: Pattern<T>][]): Pattern<T> {
  const list = new glue.PatternList();
  try {
    for (const [cycles, pat] of sections) list.pushWeighted(cycles, handleOf(pat));
    return wrap(glue.arrange(list));
  } finally {
    list.free();
  }
}

/**
 * Parses mini-notation (`"a b*2 [c d]"`, `<a b>`, `a(3,8)`, ...) into a pattern.
 * `leaf` turns each word into a value, and is called once per word, here.
 */
export function mini<T>(source: string, leaf: (word: string) => T): Pattern<T> {
  return wrap(glue.mini(source, leaf));
}

// --- Signals (continuous patterns) ---

/** A signal constant: its handle is made the first time it is used, so importing the package does not need the module. */
function signalConstant(name: string): Pattern<number> {
  return wrap(() => glue.signalNamed(name));
}

/**
 * A signal from your own function of cycle time: `fn` receives the time in
 * cycles as a number (3.25 a quarter into cycle 3, not its phase), so
 * `signal((t) => t % 1)` is `saw`.
 */
export function signal(fn: (cycle: number) => number): Pattern<number> {
  return wrap(glue.signal(fn));
}

/** Rises linearly from 0 to 1 over each cycle, then jumps back to 0. */
export const saw: Pattern<number> = signalConstant('saw');
/** Falls linearly from 1 to 0 over each cycle, then jumps back to 1. */
export const isaw: Pattern<number> = signalConstant('isaw');
/** A sine from 0 to 1, at 0.5 rising at the start of each cycle. */
export const sine: Pattern<number> = signalConstant('sine');
/** A cosine from 0 to 1: `sine` a quarter cycle ahead, at 1 at the start of each cycle. */
export const cosine: Pattern<number> = signalConstant('cosine');
/** A triangle: 0 at the start of each cycle, 1 halfway, back to 0. */
export const tri: Pattern<number> = signalConstant('tri');
/** A square: 0 for the first half of each cycle, 1 for the second. */
export const square: Pattern<number> = signalConstant('square');

/** `saw` from -1 to 1. */
export const saw2: Pattern<number> = signalConstant('saw2');
/** `isaw` from -1 to 1 (Undertone's own addition, for symmetry). */
export const isaw2: Pattern<number> = signalConstant('isaw2');
/** `sine` from -1 to 1: a full pan sweep is `.pan(sine2)`. */
export const sine2: Pattern<number> = signalConstant('sine2');
/** `cosine` from -1 to 1. */
export const cosine2: Pattern<number> = signalConstant('cosine2');
/** `tri` from -1 to 1. */
export const tri2: Pattern<number> = signalConstant('tri2');
/** `square` from -1 to 1. */
export const square2: Pattern<number> = signalConstant('square2');

/**
 * A random number from 0 up to (not including) 1 at each instant: the same
 * instant always gives the same number for the same seed (default 0; choose
 * one with `rand.seed(n)`).
 */
export const rand: Pattern<number> = signalConstant('rand');
/** `rand` from -1 up to 1: `2·rand - 1`, from the same stream. */
export const rand2: Pattern<number> = signalConstant('rand2');
/**
 * Smooth random motion from 0 to 1: a random value at each whole cycle (its
 * own stream, apart from `rand`'s) and Perlin's smootherstep between
 * neighbours, so it passes exactly through those values and never jumps.
 */
export const perlin: Pattern<number> = signalConstant('perlin');
/** 0 or 1 at random, evenly: `brandBy(0.5)`. */
export const brand: Pattern<number> = signalConstant('brand');

/** A random whole number from 0 to n - 1: `floor(rand·n)`, from the same stream as `rand`. */
export function irand(n: number): Pattern<number> {
  return wrap(glue.irand(n));
}

/** One of `values` at random at each instant: `values[floor(rand·length)]`, from the same stream as `rand`. */
export function choose<T>(...values: T[]): Pattern<T> {
  return wrap(glue.choose(values));
}

/** 1 with probability `p` (0 to 1), otherwise 0: `rand < p`, from the same stream as `rand`. */
export function brandBy(p: number): Pattern<number> {
  return wrap(glue.brandBy(p));
}

// --- For the package's own modules (not exported from api.ts) ---

/** The handle behind a pattern; throws when the pattern was freed. */
export function handleOfPattern(pattern: Pattern<unknown>): WasmPattern {
  return handleOf(pattern);
}

/** A pattern around a handle Rust just returned. */
export function patternOfHandle<T>(handle: WasmPattern): Pattern<T> {
  return wrap(handle);
}
