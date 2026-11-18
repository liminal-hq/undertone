// Signals: continuous patterns (sine, saw, rand, perlin, ...) read at the onset of each event
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction } from './fraction.js';
import { Pattern } from './pattern.js';
import { registerReseed, timeRandom } from './random.js';

// A signal has no structure: a query over any span returns one event with no
// whole, whose part is the span and whose value is the signal at the span's
// begin. Its point sampler is the exact value at an instant, which is how
// every reader (segment(), euclid(), arithmetic, and later the controls)
// reads it: at an event's onset. See docs/guide/signals.md.

/** A continuous pattern from its value at each exact instant of cycle time. */
function continuous<T>(at: (t: Fraction) => T): Pattern<T> {
  return new Pattern(
    (span) => (span.begin.lt(span.end) ? [{ part: span, value: at(span.begin) }] : []),
    at
  );
}

/** A periodic signal from its shape over one cycle, given the exact phase in [0, 1). */
function periodic(shape: (phase: number) => number): Pattern<number> {
  return continuous((t) => shape(t.cyclePos().toNumber()));
}

/**
 * A signal from your own function of cycle time: `fn` receives the time in
 * cycles as a number (3.25 a quarter into cycle 3, not its phase), so
 * `signal((t) => t % 1)` is `saw`.
 */
export function signal(fn: (cycle: number) => number): Pattern<number> {
  return continuous((t) => fn(t.toNumber()));
}

const bipolar = (shape: (phase: number) => number) => (phase: number) => 2 * shape(phase) - 1;

const sawShape = (x: number) => x;
const isawShape = (x: number) => 1 - x;
const sineShape = (x: number) => 0.5 + 0.5 * Math.sin(2 * Math.PI * x);
const cosineShape = (x: number) => 0.5 + 0.5 * Math.cos(2 * Math.PI * x);
const triShape = (x: number) => (x < 0.5 ? 2 * x : 2 - 2 * x);
const squareShape = (x: number) => (x < 0.5 ? 0 : 1);

/** Rises linearly from 0 to 1 over each cycle, then jumps back to 0. */
export const saw: Pattern<number> = periodic(sawShape);
/** Falls linearly from 1 to 0 over each cycle, then jumps back to 1. */
export const isaw: Pattern<number> = periodic(isawShape);
/** A sine from 0 to 1, at 0.5 rising at the start of each cycle. */
export const sine: Pattern<number> = periodic(sineShape);
/** A cosine from 0 to 1: `sine` a quarter cycle ahead, at 1 at the start of each cycle. */
export const cosine: Pattern<number> = periodic(cosineShape);
/** A triangle: 0 at the start of each cycle, 1 halfway, back to 0. */
export const tri: Pattern<number> = periodic(triShape);
/** A square: 0 for the first half of each cycle, 1 for the second. */
export const square: Pattern<number> = periodic(squareShape);

/** `saw` from -1 to 1. */
export const saw2: Pattern<number> = periodic(bipolar(sawShape));
/** `isaw` from -1 to 1 (Undertone's own addition, for symmetry). */
export const isaw2: Pattern<number> = periodic(bipolar(isawShape));
/** `sine` from -1 to 1: a full pan sweep is `.pan(sine2)`. */
export const sine2: Pattern<number> = periodic(bipolar(sineShape));
/** `cosine` from -1 to 1. */
export const cosine2: Pattern<number> = periodic(bipolar(cosineShape));
/** `tri` from -1 to 1. */
export const tri2: Pattern<number> = periodic(bipolar(triShape));
/** `square` from -1 to 1. */
export const square2: Pattern<number> = periodic(bipolar(squareShape));

// --- Random signals ---

type Seed = number | string;

/** A random signal built for seed 0 and registered so .seed() can rebuild it for another seed. */
function seedable<T>(make: (seed: Seed) => Pattern<T>, seed: Seed = 0): Pattern<T> {
  return registerReseed(make(seed), (next) => seedable(make, next));
}

/** The shared uniform stream of rand, rand2, irand, choose, brand and brandBy. */
const uniform = (seed: Seed) => (t: Fraction) => timeRandom(seed, 'rand', t);

/**
 * A random number from 0 up to (not including) 1 at each instant: the same
 * instant always gives the same number for the same seed (default 0; choose
 * one with `rand.seed(n)`).
 */
export const rand: Pattern<number> = seedable((seed) => continuous(uniform(seed)));

/** `rand` from -1 up to 1: `2·rand - 1`, from the same stream. */
export const rand2: Pattern<number> = seedable((seed) => {
  const u = uniform(seed);
  return continuous((t) => 2 * u(t) - 1);
});

/** A random whole number from 0 to n - 1: `floor(rand·n)`, from the same stream as `rand`. */
export function irand(n: number): Pattern<number> {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`irand() needs a positive integer, got ${n}`);
  }
  return seedable((seed) => {
    const u = uniform(seed);
    return continuous((t) => Math.floor(u(t) * n));
  });
}

/** One of `values` at random at each instant: `values[floor(rand·length)]`, from the same stream as `rand`. */
export function choose<T>(...values: T[]): Pattern<T> {
  if (values.length === 0) {
    throw new Error('choose() needs at least one value');
  }
  const options = [...values];
  return seedable((seed) => {
    const u = uniform(seed);
    return continuous((t) => options[Math.floor(u(t) * options.length)]);
  });
}

/** 1 with probability `p` (0 to 1), otherwise 0: `rand < p`, from the same stream as `rand`. */
export function brandBy(p: number): Pattern<number> {
  if (!(p >= 0 && p <= 1)) {
    throw new Error(`brandBy() probability must be between 0 and 1, got ${p}`);
  }
  return seedable((seed) => {
    const u = uniform(seed);
    return continuous((t) => (u(t) < p ? 1 : 0));
  });
}

/** 0 or 1 at random, evenly: `brandBy(0.5)`. */
export const brand: Pattern<number> = brandBy(0.5);

/** Perlin's 2002 smootherstep, `6x⁵ - 15x⁴ + 10x³`: no corners where the noise passes a whole cycle. */
function smootherstep(x: number): number {
  return x * x * x * (x * (6 * x - 15) + 10);
}

/**
 * Smooth random motion from 0 to 1: a random value at each whole cycle (its
 * own stream, apart from `rand`'s) and Perlin's smootherstep between
 * neighbours, so it passes exactly through those values and never jumps.
 */
export const perlin: Pattern<number> = seedable((seed) =>
  continuous((t) => {
    const i = t.floor();
    const a = timeRandom(seed, 'perlin', new Fraction(i));
    const b = timeRandom(seed, 'perlin', new Fraction(i + 1));
    return a + (b - a) * smootherstep(t.cyclePos().toNumber());
  })
);
