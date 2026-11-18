// Benchmark of signal-driven controls against string controls over a thousand scheduler windows (run by hand: `bun run bench`)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { bench, describe } from 'vitest';
import { s } from './control';
import { Fraction } from './fraction';
import { collectOnsets } from './scheduler';
import type { Pattern } from './pattern';
import type { ControlPatch } from './types';
import { perlin, rand, sine2 } from './signal';

// The scheduler's tick queries a window of a twentieth of a cycle (100 ms at 120 bpm, 2 s cycles).
const WINDOWS = 1000;
const WINDOW = new Fraction(1, 20);

/** What one loop tick does with a window: query it and turn each onset into a pending voice. */
function run(pattern: Pattern<ControlPatch>): number {
  let voices = 0;
  for (let i = 0; i < WINDOWS; i++) {
    const begin = WINDOW.mul(new Fraction(i));
    voices += collectOnsets(pattern, { begin, end: begin.add(WINDOW) }, 0, 2, true).length;
  }
  return voices;
}

const plain = s('hh*16');
const withStrings = s('hh*16')
  .pan('-1 -.5 0 .5 1 .5 0 -.5')
  .lpf('800 1600 3200 1600')
  .gain('.5 .3');
const withSignals = s('hh*16')
  .pan(sine2.slow(4))
  .lpf(perlin.range(800, 3200))
  .gain(rand.range(0.3, 0.5));
const withNumbers = s('hh*16').pan(0.2).lpf(1600).gain(0.4);

describe('hh*16 over 1000 scheduler windows, three controls each', () => {
  bench('no controls', () => {
    run(plain);
  });
  bench('three number controls', () => {
    run(withNumbers);
  });
  bench('three string controls', () => {
    run(withStrings);
  });
  bench('three signal controls (pan, lpf, gain)', () => {
    run(withSignals);
  });
});
