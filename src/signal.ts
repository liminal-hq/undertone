// Signals: continuous patterns (sine, saw, ...) read at the onset of each event
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Fraction } from './fraction.js';
import { Pattern } from './pattern.js';

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
