// The Pattern class over a WebAssembly handle, its haps, and the constructors that build patterns
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction } from './fraction.js';
import type {
  ControlInput,
  ControlPatch,
  OscType,
  PanPoint,
  ShapedWaveType,
  SoundType
} from './types.js';
import type {
  LoopHandle,
  LoopOptions,
  PlayOptions,
  PlaybackHandle
} from './engineTypes.js';
import { loopOn, playOnce } from './scheduler.js';
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
let adopting: { handle?: WasmPattern; make?: () => WasmPattern } | undefined;

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
// The control methods are declared in the interface below, which merges with this class.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
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
      this.#handle = adopting.handle;
      this.#make = adopting.make;
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
      adopting = typeof handle === 'function' ? { make: handle } : { handle };
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
   * Plays one cycle's worth of events as a one-shot. Envelopes are percussive
   * by default (0.1.x SFX behaviour) — pass `{ gated: true }` to hold each
   * event for its own share of the cycle instead, like loop(). Uses a
   * lazily-created shared AudioContext when none is passed — call from a
   * user gesture the first time (autoplay policy).
   */
  play(this: Pattern<ControlPatch>, options: PlayOptions = {}): PlaybackHandle {
    const handle = handleOf(this);
    return playOnce(options, (transport, engine, now, settings) =>
      transport.play(engine, handle, now, settings)
    );
  }

  /** Loops the pattern until stop() is called on the returned handle. */
  loop(this: Pattern<ControlPatch>, options: LoopOptions = {}): LoopHandle {
    const handle = handleOf(this);
    return loopOn(options, (transport, engine, now, settings) =>
      transport.loop(engine, handle, now, settings)
    );
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
 * The control methods of a pattern of voice parameters (`.gain()`, `.lpf()`, `.pan()`, ...). They are declared here, by hand,
 * as 0.4.0 declares them, and installed on the prototype from the module's control table when an entry loads it
 * (controlsWiring.ts); a test checks that every row of the table has a declaration.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface Pattern<T> {
  /**
   * Applies a whole instrument at once: merges a plain `ControlPatch` (such as
   * one from fmVoice() or fmPresets, or loaded from saved data) into every
   * event. Fields the patch sets overwrite the events', so call it before the
   * per-note controls you want to win — `note('e5 g5').voice(bell).gain(0.2)`.
   */
  voice(this: Pattern<ControlPatch>, patch: ControlPatch): Pattern<ControlPatch>;

  /**
   * Sets/overrides the oscillator waveform or noise type across all events,
   * clearing any sample name set by .s() — sampleName otherwise takes
   * precedence over soundType in the engine, so without this a prior .s()
   * would keep playing its sample silently through a later .sound() call.
   */
  sound(this: Pattern<ControlPatch>, type: SoundType): Pattern<ControlPatch>;

  /**
   * Sets the voice to a synth SoundType or a registered sample name — a synth
   * type behaves exactly like sound(); anything else becomes a sample name
   * (see samples.ts's registerSample()), clearing any previous sample name or
   * synth type respectively so the two never both apply at once.
   */
  s(this: Pattern<ControlPatch>, name: SoundType | string): Pattern<ControlPatch>;

  /** Bank prefix for sample lookup — tried as `${name}_${sampleName}` before falling back to bare `sampleName`. */
  bank(this: Pattern<ControlPatch>, name: string): Pattern<ControlPatch>;

  /**
   * Resolves scale-degree events from n() into real pitches: `spec` is a scale
   * string like `"D5:minor"`. Events without a `degree` (already pitched via
   * note(), or unpitched noise from sound()) pass through unchanged.
   */
  scale(this: Pattern<ControlPatch>, spec: string): Pattern<ControlPatch>;

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
  ): Pattern<ControlPatch>;

  /** Amplitude envelope attack time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  attack(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Amplitude envelope decay time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  decay(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /**
   * Fraction (0-1) of gain the decay stage settles to before release.
   * Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  sustain(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch>;

  /** Amplitude envelope release time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  release(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Peak amplitude (0-1). Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  gain(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch>;

  /**
   * Base lowpass cutoff in Hz. Creates a filter stage; omit entirely to skip
   * filtering. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  lpf(this: Pattern<ControlPatch>, hz: ControlInput): Pattern<ControlPatch>;

  /** Hz the filter envelope adds on top of lpf() at its peak. Accepts a number, a mini-notation string or a pattern. */
  lpenv(this: Pattern<ControlPatch>, hzAmount: ControlInput): Pattern<ControlPatch>;

  /** Filter envelope attack time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  lpa(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Filter envelope decay time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  lpd(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /**
   * Fraction (0-1) between lpf() and its envelope peak the decay stage settles
   * to. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  lps(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch>;

  /** Filter envelope release time, in seconds. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset). */
  lpr(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /**
   * Pitch glide (portamento): starts an octave above the target note and
   * slides down. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  slide(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /**
   * FM modulation index (Strudel's `fm`): the modulator swings the carrier's
   * frequency by index × the modulator's frequency, so the sound is equally
   * bright at every pitch. 0 turns it off. Synth voices only. Accepts a
   * number, a mini-notation string or a pattern.
   */
  fm(this: Pattern<ControlPatch>, index: ControlInput): Pattern<ControlPatch>;

  /** Alias of fm() under Strudel's `fmi` name. */
  fmi(this: Pattern<ControlPatch>, index: ControlInput): Pattern<ControlPatch>;

  /**
   * FM harmonicity (Strudel's `fmh`): the modulator's frequency as a multiple of
   * the carrier's. Whole numbers give harmonic tones; fractions such as 3.5 or
   * 2.76 give bells and metal. Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  fmh(this: Pattern<ControlPatch>, ratio: ControlInput): Pattern<ControlPatch>;

  /** Seconds for the FM depth to reach the full index. Accepts a number, a mini-notation string or a pattern. */
  fmattack(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Seconds for the FM depth to fall to fmsustain() × the index (toward silence when fmsustain() is unset). Accepts a number, a mini-notation string or a pattern. */
  fmdecay(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Fraction (0-1) of the index the FM depth settles to (default 1, or 0 when only fmdecay() is set). Accepts a number, a mini-notation string or a pattern. */
  fmsustain(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch>;

  /** Seconds for the FM depth to fall to 0 after the gate closes. Accepts a number, a mini-notation string or a pattern. */
  fmrelease(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Ramp shape of the FM depth envelope: 'exp' (default, as in Strudel) or 'lin'. Not patternable. */
  fmenv(this: Pattern<ControlPatch>, curve: 'lin' | 'exp'): Pattern<ControlPatch>;

  /** The modulator's waveform: sine (default), triangle, square, sawtooth, or a shaped wave (halfsine, abssine, pulsesine). Not patternable. */
  fmwave(this: Pattern<ControlPatch>, type: OscType | ShapedWaveType): Pattern<ControlPatch>;

  /**
   * Pitch envelope depth in semitones (Strudel's `penv`): each note starts that
   * far from its pitch (negative = below) and returns to it over pdecay().
   * Rising and falling sweeps alike. Synth voices only. Accepts a
   * number, a mini-notation string or a pattern.
   */
  penv(this: Pattern<ControlPatch>, semitones: ControlInput): Pattern<ControlPatch>;

  /** Seconds the pitch envelope takes to reach its offset (default 0: it starts there). Accepts a number, a mini-notation string or a pattern. */
  pattack(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Seconds the pitch envelope takes to return to the note (default 0.1). Accepts a number, a mini-notation string or a pattern. */
  pdecay(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

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
  ): Pattern<ControlPatch>;

  /**
   * Explicit gate length in seconds: the envelopes hold at their sustain level
   * for this long, then release — independent of the event's length in the
   * pattern, and also in a one-shot play(). Needs a sustain above 0 to hold.
   * Accepts a number, a mini-notation string or a pattern (a signal is read at each onset).
   */
  duration(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /**
   * Gate length as a fraction of each event's own length (`.legato(0.5)` holds
   * half of it, `.legato(1)` all of it). Gates even in a one-shot play(), and
   * is overridden by an explicit duration(). Accepts a mini-notation string to
   * pattern it.
   */
  legato(this: Pattern<ControlPatch>, fraction: ControlInput): Pattern<ControlPatch>;

  /**
   * Note strength: multiplies the peak amplitude only, so one instrument keeps
   * its timbre from a ghost note (0.3) to an accent (1). Accepts a
   * number, a mini-notation string or a pattern.
   */
  velocity(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch>;

  /**
   * Cut group (Strudel/Tidal `cut`): a new event in the same group stops the
   * previous one with a very short fade — a closed hi-hat choking an open one,
   * or a monophonic line retriggering. The same number on different patterns
   * shares one group. Not patternable, like orbit().
   */
  cut(this: Pattern<ControlPatch>, group: number): Pattern<ControlPatch>;

  /**
   * Start-time offset in seconds applied to every event when played. Accepts a
   * number, a mini-notation string or a pattern.
   */
  nudge(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Delays every event by `seconds` — an alias of nudge() under Strudel's name. */
  late(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Moves every event `seconds` earlier — the negative of late()/nudge(). */
  early(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /**
   * Stereo position, -1 (hard left) to 1 (hard right). Accepts a mini-notation
   * string to pattern it; every literal in the string is range-checked.
   */
  pan(this: Pattern<ControlPatch>, position: ControlInput): Pattern<ControlPatch>;

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
  ): Pattern<ControlPatch>;

  /**
   * Autopan: an LFO at `hz` swings each note's pan either side of its pan()
   * (or its panpath() or panslide()), from the onset through the release, as
   * a real oscillator on the panner, not booked points. Shape it with
   * autopandepth(), autopanshape() and autopanphase(). Accepts a
   * number, a mini-notation string or a pattern.
   */
  autopan(this: Pattern<ControlPatch>, hz: ControlInput): Pattern<ControlPatch>;

  /** How far autopan() swings either side of the pan, 0 to 1 (default 1). Accepts a number, a mini-notation string or a pattern. */
  autopandepth(this: Pattern<ControlPatch>, depth: ControlInput): Pattern<ControlPatch>;

  /** The autopan() LFO's wave: 'sine' (default), 'triangle' or 'square'. Not patternable. */
  autopanshape(
    this: Pattern<ControlPatch>,
    shape: 'sine' | 'triangle' | 'square'
  ): Pattern<ControlPatch>;

  /**
   * Where in its cycle autopan() starts, 0 to 1 of a cycle (default 0: a sine
   * or triangle starts at the pan moving right, a square on the right; 0.5
   * starts the other way). Accepts a number, a mini-notation string or a
   * pattern, so a note's LFO can start where the last one left off:
   * `.autopanphase(saw.fast(hz * secondsPerCycle))`, which is the phase of an LFO running
   * under the whole loop (a cycle is 240 / bpm seconds). A pattern's values are clamped to 0 to 1.
   */
  autopanphase(this: Pattern<ControlPatch>, phase: ControlInput): Pattern<ControlPatch>;

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
  ): Pattern<ControlPatch>;

  /**
   * Pan law: each side's level at the centre in dB, from -6 to 0. The default,
   * -3, is the stereo panner's equal-power law; 0 keeps the louder side full
   * like a balance control, and -6 dips the centre further. Shapes only voices
   * that are panned (pan() or a panPath). Scalar only, like orbit().
   */
  panlaw(this: Pattern<ControlPatch>, db: number): Pattern<ControlPatch>;

  /**
   * Static highpass cutoff in Hz, in series after lpf(). Creates a filter
   * stage; omit entirely to skip it. Accepts a number, a mini-notation string or a pattern.
   */
  hpf(this: Pattern<ControlPatch>, hz: ControlInput): Pattern<ControlPatch>;

  /**
   * LFO rate in Hz driving a 4-stage allpass phaser. Creates the phaser stage;
   * omit entirely to skip it. Accepts a number, a mini-notation string or a pattern.
   */
  phaser(this: Pattern<ControlPatch>, rateHz: ControlInput): Pattern<ControlPatch>;

  /**
   * Reverb send level (0-1) to this voice's orbit bus (see orbit()). No send
   * at all when omitted. Accepts a number, a mini-notation string or a pattern.
   */
  room(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch>;

  /**
   * Reverb decay character for the orbit's shared bus, roughly 1 (short) to
   * 10 (long) — see effects.ts's getOrbitBus(). Accepts a mini-notation
   * string.
   */
  roomsize(this: Pattern<ControlPatch>, size: ControlInput): Pattern<ControlPatch>;

  /**
   * Delay send level (0-1) to this voice's orbit bus (see orbit()). No send
   * at all when omitted. Accepts a number, a mini-notation string or a pattern.
   */
  delay(this: Pattern<ControlPatch>, level: ControlInput): Pattern<ControlPatch>;

  /** Delay time in seconds for the orbit's shared delay bus. Accepts a number, a mini-notation string or a pattern. */
  delaytime(this: Pattern<ControlPatch>, seconds: ControlInput): Pattern<ControlPatch>;

  /** Feedback (0-1) for the orbit's shared delay bus. Accepts a number, a mini-notation string or a pattern. */
  delayfeedback(this: Pattern<ControlPatch>, amount: ControlInput): Pattern<ControlPatch>;

  /**
   * Which shared effects bus (see effects.ts's getOrbitBus()) this voice's
   * room()/delay() sends target. Default 0. Every voice sending to the same
   * orbit shares one reverb and one delay line, so give a voice its own orbit
   * number when it needs a distinct room size or delay time from its
   * neighbours. Scalar only — not a mini-notation-patterned control.
   */
  orbit(this: Pattern<ControlPatch>, n: number): Pattern<ControlPatch>;

  /**
   * Multichannel (up to 7.1) placement: per-speaker output gains in the order
   * FL, FR, C, LFE, SL, SR, RL, RR (1-8 entries). Takes precedence over
   * pan(). On destinations that can't address that many speakers (or without
   * enableMultichannel()), the voice folds down to stereo automatically.
   */
  channels(this: Pattern<ControlPatch>, gains: number[]): Pattern<ControlPatch>;

  /**
   * Places the voice at an angle on the 7.1 speaker ring: 0° front-centre,
   * ±30° front, ±90° sides, ±150° rears, ±180° dead-behind — equal-power
   * panned between the two nearest speakers. Sugar for channels(surroundGains(angle)).
   */
  surround(this: Pattern<ControlPatch>, angleDegrees: number): Pattern<ControlPatch>;
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
