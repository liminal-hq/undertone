// Loads the built WebAssembly module and wraps it in a test-only Pattern, the shape the corpus interpreter calls
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// This is NOT the bridge package (RF-25 writes that in packages/undertone/src/). It is the smallest wrapper that lets the
// smoke test and the layer 1 corpus runner drive the exports through the reference's own names, so it doubles as a sketch
// of what RF-25 does at each boundary rule (docs/rust-migration/results/M6-BOUNDARY.md):
//   - a Pattern holds a WasmPattern handle; every method returns a new Pattern;
//   - `every` and `jux` hand Rust a thunk that calls the user's function with this very Pattern and returns a clone of the
//     handle it gets back;
//   - `new Pattern(query, sampler)`, `fmap(fn)`, and `signal(fn)` become foreign leaves (`fmap` batched over a query's values);
//   - list constructors push each handle into a PatternList (never an array of handles);
//   - `.query` decodes the flat encoding into Hap objects with the reference's Fraction class;
//   - `free()` is idempotent (the glue's is not).
// Runs under Node 22 (type stripping) and Bun; it reads the module from disk (packages/undertone/wasm/, scripts/build-wasm.sh).

import { readFileSync } from 'node:fs';
import { Fraction } from '../../../../src/fraction.ts';
import * as wasm from '../../../../packages/undertone/wasm/undertone_wasm.js';

wasm.initSync({
  module: readFileSync(
    new URL('../../../../packages/undertone/wasm/undertone_wasm_bg.wasm', import.meta.url)
  )
});

export { wasm, Fraction };

export interface TimeSpan {
  readonly begin: Fraction;
  readonly end: Fraction;
}

export interface Hap<T = unknown> {
  readonly whole?: TimeSpan;
  readonly part: TimeSpan;
  readonly value: T;
}

export type Sampler<T = unknown> = (t: Fraction) => T | undefined;

type Encoded = [Float64Array, unknown[], string[] | undefined];

/** A fraction from its two slots: two numbers, or NaN and an index into the big texts (the test wrapper cannot hold one). */
function fraction(n: number, d: number, big: string[] | undefined): Fraction {
  if (Number.isNaN(n)) {
    throw new Error(
      `a fraction beyond 2^53 crossed (${big?.[d]}); the test wrapper's Fraction cannot hold it`
    );
  }
  return new Fraction(n, d);
}

/** The flat encoding (nine numbers per hap) as Hap objects. */
export function decodeHaps([times, values, big]: Encoded): Hap[] {
  const haps: Hap[] = [];
  for (let at = 0; at < times.length; at += 9) {
    const part = {
      begin: fraction(times[at], times[at + 1], big),
      end: fraction(times[at + 2], times[at + 3], big)
    };
    const value = values[times[at + 8]];
    if (times[at + 4] === 0 && times[at + 5] === 0 && times[at + 6] === 0 && times[at + 7] === 0) {
      haps.push({ part, value });
    } else {
      const whole = {
        begin: fraction(times[at + 4], times[at + 5], big),
        end: fraction(times[at + 6], times[at + 7], big)
      };
      haps.push({ whole, part, value });
    }
  }
  return haps;
}

/** Hap objects in the flat encoding, for a JavaScript query to return. */
export function encodeHaps(haps: readonly Hap[]): [Float64Array, unknown[]] {
  const times = new Float64Array(haps.length * 9);
  const values: unknown[] = [];
  haps.forEach((hap, i) => {
    const at = i * 9;
    times.set([hap.part.begin.n, hap.part.begin.d, hap.part.end.n, hap.part.end.d], at);
    if (hap.whole) {
      times.set([hap.whole.begin.n, hap.whole.begin.d, hap.whole.end.n, hap.whole.end.d], at + 4);
    }
    times[at + 8] = values.length;
    values.push(hap.value);
  });
  return [times, values];
}

function list(patterns: readonly Pattern[]): wasm.PatternList {
  const out = new wasm.PatternList();
  for (const pattern of patterns) out.push(pattern.handle);
  return out;
}

function weighted(pairs: readonly (readonly [number, Pattern])[]): wasm.PatternList {
  const out = new wasm.PatternList();
  for (const [weight, pattern] of pairs) out.pushWeighted(weight, pattern.handle);
  return out;
}

/** The test wrapper's Pattern over a WasmPattern handle. */
export class Pattern<T = unknown> {
  handle!: wasm.WasmPattern;

  constructor(query?: (span: TimeSpan) => Hap<T>[], sample?: Sampler<T>) {
    if (query) {
      this.handle = wasm.fromQuery(
        (bn: number, bd: number, en: number, ed: number) =>
          encodeHaps(query({ begin: new Fraction(bn, bd), end: new Fraction(en, ed) })),
        sample ? (n: number, d: number) => sample(new Fraction(n, d)) : undefined
      );
    }
  }

  static of<U = unknown>(handle: wasm.WasmPattern): Pattern<U> {
    const pattern = new Pattern<U>();
    pattern.handle = handle;
    return pattern;
  }

  get query(): (span: TimeSpan) => Hap<T>[] {
    return (span) =>
      decodeHaps(
        this.handle.query(span.begin.n, span.begin.d, span.end.n, span.end.d) as Encoded
      ) as Hap<T>[];
  }

  get sample(): Sampler<T> | undefined {
    return this.handle.hasSampler() ? (t) => this.sampleAt(t) : undefined;
  }

  sampleAt(t: Fraction): T | undefined {
    return this.handle.sampleAt(t.n, t.d) as T | undefined;
  }

  fmap<U>(fn: (value: T) => U): Pattern<U> {
    return Pattern.of(this.handle.fmap((values: T[]) => values.map(fn)));
  }

  fast(factor: number): Pattern<T> {
    return Pattern.of(this.handle.fast(factor));
  }

  slow(factor: number): Pattern<T> {
    return Pattern.of(this.handle.slow(factor));
  }

  rev(): Pattern<T> {
    return Pattern.of(this.handle.rev());
  }

  euclid(pulses: number, steps: number, rotation = 0): Pattern<T> {
    return Pattern.of(this.handle.euclid(pulses, steps, rotation));
  }

  every(n: number, fn: (pattern: Pattern<T>) => Pattern<T>): Pattern<T> {
    return Pattern.of(this.handle.every(n, () => fn(this).handle.clone()));
  }

  jux(fn: (pattern: Pattern<T>) => Pattern<T>): Pattern<T> {
    return Pattern.of(this.handle.jux(() => fn(this).handle.clone()));
  }

  segment(count: number): Pattern<T> {
    return Pattern.of(this.handle.segment(count));
  }

  seed(seed: number | string): Pattern<T> {
    return Pattern.of(this.handle.seed(seed));
  }

  range(lo: number, hi: number): Pattern<number> {
    return Pattern.of(this.handle.range(lo, hi));
  }

  range2(lo: number, hi: number): Pattern<number> {
    return Pattern.of(this.handle.range2(lo, hi));
  }

  rangex(lo: number, hi: number): Pattern<number> {
    return Pattern.of(this.handle.rangex(lo, hi));
  }

  private arithmetic(name: string, other: number | Pattern<number>): Pattern<number> {
    if (typeof other === 'number') return Pattern.of(this.handle.arith(name, other));
    if (!(other instanceof Pattern))
      throw new Error(`${name}() needs a number or a pattern of numbers`);
    return Pattern.of(this.handle.arithPattern(name, other.handle));
  }

  add(other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('add', other);
  }

  sub(other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('sub', other);
  }

  mul(other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('mul', other);
  }

  div(other: number | Pattern<number>): Pattern<number> {
    return this.arithmetic('div', other);
  }

  round(): Pattern<number> {
    return Pattern.of(this.handle.round());
  }

  floor(): Pattern<number> {
    return Pattern.of(this.handle.floor());
  }

  private freed = false;

  /** Frees the handle at once. Idempotent here: the glue's own `free()` throws "null pointer passed to rust" the second time. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.handle.free();
  }
}

const signalNamed = (name: string) => Pattern.of<number>(wasm.signalNamed(name));

/** The reference's names that part 1 exports, as the corpus interpreter looks them up (`ref.lib`). */
export const lib = {
  Pattern,
  Fraction,
  hasOnset: (hap: Hap) => hap.whole !== undefined && hap.whole.begin.eq(hap.part.begin),
  silence: Pattern.of<never>(wasm.silence()),
  pure: <T>(value: T) => Pattern.of<T>(wasm.pure(value)),
  stack: <T>(...patterns: Pattern<T>[]) => Pattern.of<T>(wasm.stack(list(patterns))),
  seq: <T>(...patterns: Pattern<T>[]) => Pattern.of<T>(wasm.seq(list(patterns))),
  cat: <T>(...patterns: Pattern<T>[]) => Pattern.of<T>(wasm.cat(list(patterns))),
  timecat: <T>(pairs: [number, Pattern<T>][]) => Pattern.of<T>(wasm.timecat(weighted(pairs))),
  arrange: <T>(...sections: [number, Pattern<T>][]) =>
    Pattern.of<T>(wasm.arrange(weighted(sections))),
  rev: <T>(pattern: Pattern<T>) => pattern.rev(),
  mini: <T>(source: string, leaf: (word: string) => T) => Pattern.of<T>(wasm.mini(source, leaf)),
  signal: (fn: (t: number) => number) => Pattern.of<number>(wasm.signal(fn)),
  saw: signalNamed('saw'),
  saw2: signalNamed('saw2'),
  isaw: signalNamed('isaw'),
  isaw2: signalNamed('isaw2'),
  sine: signalNamed('sine'),
  sine2: signalNamed('sine2'),
  cosine: signalNamed('cosine'),
  cosine2: signalNamed('cosine2'),
  tri: signalNamed('tri'),
  tri2: signalNamed('tri2'),
  square: signalNamed('square'),
  square2: signalNamed('square2'),
  rand: signalNamed('rand'),
  rand2: signalNamed('rand2'),
  perlin: signalNamed('perlin'),
  brand: signalNamed('brand'),
  irand: (n: number) => Pattern.of<number>(wasm.irand(n)),
  brandBy: (p: number) => Pattern.of<number>(wasm.brandBy(p)),
  choose: <T>(...values: T[]) => Pattern.of<T>(wasm.choose(values)),
  noteToMidi: (name: string) => wasm.noteToMidi(name),
  midiToFrequency: (midi: number) => wasm.midiToFrequency(midi),
  noteToFrequency: (pitch: string | number) => wasm.noteToFrequency(pitch),
  seededRandom: (seed: number | string) => {
    const random = wasm.seededRandom(seed);
    return () => random.next();
  }
};
