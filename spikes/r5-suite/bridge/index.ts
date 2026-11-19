// A Rust-backed Pattern for the TypeScript suite: wraps the R1 pattern core behind the reference's public names
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { Fraction } from '../../../src/fraction';
import type { Hap, Sampler, TimeSpan } from '../../../src/pattern';
import * as wasm from '../pkg/r5_suite.js';

wasm.initSync({ module: readFileSync(new URL('../pkg/r5_suite_bg.wasm', import.meta.url)) });

export { Fraction };
export type { Hap, Sampler, TimeSpan };
export type ControlPatch = Record<string, unknown>;

const frac = (n: number, d: number): Fraction => new Fraction(n, d);
let nextId = 1;

function rowsToHaps(rows: any[][]): Hap<any>[] {
  return rows.map((r) => {
    const hap: Hap<any> = {
      part: { begin: frac(r[0], r[1]), end: frac(r[2], r[3]) },
      value: r[8]
    } as Hap<any>;
    if (r[4] !== null) {
      (hap as any).whole = { begin: frac(r[4], r[5]), end: frac(r[6], r[7]) };
    }
    return hap;
  });
}

function hapsToRows(haps: Hap<any>[]): any[][] {
  return haps.map((h) => [
    h.part.begin.n,
    h.part.begin.d,
    h.part.end.n,
    h.part.end.d,
    ...(h.whole
      ? [h.whole.begin.n, h.whole.begin.d, h.whole.end.n, h.whole.end.d]
      : [null, null, null, null]),
    h.value
  ]);
}

/** The reference's Pattern, over a Rust handle. Every method returns a new wrapper. */
export class Pattern<T> {
  h!: wasm.Handle;

  constructor(query?: (span: TimeSpan) => Hap<T>[], sample?: Sampler<T>) {
    if (query) {
      this.h = wasm.custom_handle(
        (bn: number, bd: number, en: number, ed: number) => {
          return hapsToRows(query({ begin: frac(bn, bd), end: frac(en, ed) }));
        },
        nextId++,
        sample ? (n: number, d: number) => sample(frac(n, d)) : undefined
      );
    }
  }

  static of<U>(h: wasm.Handle): Pattern<U> {
    const p = new Pattern<U>();
    p.h = h;
    return p;
  }

  get query(): (span: TimeSpan) => Hap<T>[] {
    return (span) => rowsToHaps(this.h.query(span.begin.n, span.begin.d, span.end.n, span.end.d));
  }

  get sample(): Sampler<T> | undefined {
    return this.h.has_sampler() ? (t) => this.sampleAt(t) : undefined;
  }

  sampleAt(t: Fraction): T | undefined {
    return this.h.sample_at(t.n, t.d) as T | undefined;
  }
  fmap<U>(fn: (value: T) => U): Pattern<U> {
    return Pattern.of(this.h.fmap_foreign(fn as any, nextId++));
  }
  fast(factor: number): Pattern<T> {
    return Pattern.of(this.h.fast(factor));
  }
  slow(factor: number): Pattern<T> {
    return Pattern.of(this.h.slow(factor));
  }
  rev(): Pattern<T> {
    return Pattern.of(this.h.rev());
  }
  every(n: number, fn: (pat: Pattern<T>) => Pattern<T>): Pattern<T> {
    return Pattern.of(this.h.every_with(n, fn(this).h));
  }
  euclid(pulses: number, steps: number, rotation = 0): Pattern<T> {
    return Pattern.of(this.h.euclid(pulses, steps, rotation));
  }
  segment(count: number): Pattern<T> {
    return Pattern.of(this.h.segment(count));
  }
  seed(seed: number | string): Pattern<T> {
    return Pattern.of(this.h.seed(seed));
  }
  range(lo: number, hi: number): Pattern<number> {
    return Pattern.of(this.h.range(lo, hi));
  }
  range2(lo: number, hi: number): Pattern<number> {
    return Pattern.of(this.h.range2(lo, hi));
  }
  rangex(lo: number, hi: number): Pattern<number> {
    return Pattern.of(this.h.rangex(lo, hi));
  }
  private arith(op: string, other: number | Pattern<number>): Pattern<number> {
    return Pattern.of(
      typeof other === 'number' ? this.h.arith_number(op, other) : this.h.arith_pattern(op, other.h)
    );
  }
  add(other: number | Pattern<number>): Pattern<number> {
    return this.arith('add', other);
  }
  sub(other: number | Pattern<number>): Pattern<number> {
    return this.arith('sub', other);
  }
  mul(other: number | Pattern<number>): Pattern<number> {
    return this.arith('mul', other);
  }
  div(other: number | Pattern<number>): Pattern<number> {
    return this.arith('div', other);
  }
  round(): Pattern<number> {
    return Pattern.of(this.h.round());
  }
  floor(): Pattern<number> {
    return Pattern.of(this.h.floor());
  }
  private control(name: string, v: any): Pattern<ControlPatch> {
    return Pattern.of(
      v instanceof Pattern ? this.h.control_pattern(name, v.h) : this.h.control(name, v)
    );
  }
  // Controls the Rust core binds (gain, lpf, pan, attack) and the voice-map helpers it has
  gain(v: any): Pattern<ControlPatch> {
    return this.control('gain', v);
  }
  lpf(v: any): Pattern<ControlPatch> {
    return this.control('lpf', v);
  }
  pan(v: any): Pattern<ControlPatch> {
    return this.control('pan', v);
  }
  attack(v: any): Pattern<ControlPatch> {
    return this.control('attack', v);
  }
  sound(t: string): Pattern<ControlPatch> {
    return Pattern.of(this.h.with_sound(t));
  }
  s(t: string): Pattern<ControlPatch> {
    return Pattern.of(this.h.with_s(t));
  }
  bank(t: string): Pattern<ControlPatch> {
    return Pattern.of(this.h.with_bank(t));
  }
  orbit(n: number): Pattern<ControlPatch> {
    return Pattern.of(this.h.with_orbit(n));
  }
  cut(n: number): Pattern<ControlPatch> {
    return Pattern.of(this.h.with_cut(n));
  }
  panlaw(db: number): Pattern<ControlPatch> {
    return Pattern.of(this.h.with_panlaw(db));
  }
  scale(spec: string): Pattern<ControlPatch> {
    return Pattern.of(this.h.scale(spec));
  }
  jux(fn: (p: Pattern<ControlPatch>) => Pattern<ControlPatch>): Pattern<ControlPatch> {
    return Pattern.of(this.h.jux_with(fn(this as any).h));
  }
}

const listOf = (pats: Pattern<any>[]) => {
  const list = new wasm.List();
  for (const p of pats) list.push(1, p.h);
  return list;
};
const weighted = (pairs: [number, Pattern<any>][]) => {
  const list = new wasm.List();
  for (const [w, p] of pairs) list.push(w, p.h);
  return list;
};
export function hasOnset(hap: Hap<unknown>): boolean {
  return hap.whole !== undefined && hap.whole.begin.eq(hap.part.begin);
}
export const silence: Pattern<never> = Pattern.of(wasm.silence_handle());
export function pure<T>(value: T): Pattern<T> {
  return Pattern.of(wasm.pure_handle(value));
}
export function seq<T>(...pats: Pattern<T>[]): Pattern<T> {
  return Pattern.of(wasm.seq_handle(listOf(pats)));
}
export function cat<T>(...pats: Pattern<T>[]): Pattern<T> {
  return Pattern.of(wasm.cat_handle(listOf(pats)));
}
export function stack<T>(...pats: Pattern<T>[]): Pattern<T> {
  return Pattern.of(wasm.stack_handle(listOf(pats)));
}
export function timecat<T>(pairs: [number, Pattern<T>][]): Pattern<T> {
  return Pattern.of(wasm.timecat_handle(weighted(pairs)));
}
export function arrange<T>(...sections: [number, Pattern<T>][]): Pattern<T> {
  return Pattern.of(wasm.arrange_handle(weighted(sections)));
}
export function rev<T>(pat: Pattern<T>): Pattern<T> {
  return pat.rev();
}
export function mini<T>(source: string, leaf: (word: string) => T): Pattern<T> {
  return Pattern.of(wasm.mini_handle(source, leaf as any));
}

// Signals, by the names the reference exports
const sig = (name: string) => Pattern.of<number>(wasm.signal_handle(name));
export const saw = sig('saw');
export const saw2 = sig('saw2');
export const isaw = sig('isaw');
export const isaw2 = sig('isaw2');
export const sine = sig('sine');
export const sine2 = sig('sine2');
export const cosine = sig('cosine');
export const cosine2 = sig('cosine2');
export const tri = sig('tri');
export const tri2 = sig('tri2');
export const square = sig('square');
export const square2 = sig('square2');
export const rand = sig('rand');
export const rand2 = sig('rand2');
export const perlin = sig('perlin');
export const brand = sig('brand');
export const irand = (n: number): Pattern<number> => Pattern.of(wasm.irand_handle(n));
export const brandBy = (p: number): Pattern<number> => Pattern.of(wasm.brand_by_handle(p));
export const choose = <T>(...values: T[]): Pattern<T> => Pattern.of(wasm.choose_handle(values));
/** `signal(fn)` takes a JavaScript sampling function, which the thin binding does not carry. */
export function signal(): never {
  throw new Error('signal(fn) is not bound by the spike (a JavaScript sampler)');
}

// Constructors
export const note = (input: string | number): Pattern<ControlPatch> =>
  Pattern.of(typeof input === 'number' ? wasm.note_hz_handle(input) : wasm.note_handle(input));
export const sound = (input: string): Pattern<ControlPatch> => Pattern.of(wasm.sound_handle(input));
export const s = (input: string): Pattern<ControlPatch> => Pattern.of(wasm.s_handle(input));
export const n = (input: string | number | Pattern<number>): Pattern<ControlPatch> =>
  Pattern.of(
    typeof input === 'string'
      ? wasm.n_handle(input)
      : typeof input === 'number'
        ? wasm.n_degree_handle(input)
        : wasm.n_pattern_handle(input.h)
  );

// Pitch
export const noteToMidi = (name: string): number => wasm.note_to_midi_js(name);
export const midiToFrequency = (midi: number): number => wasm.midi_to_frequency_js(midi);
export const noteToFrequency = (pitch: string | number): number => wasm.note_to_frequency_js(pitch);
