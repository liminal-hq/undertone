// The example that started this whole library: a placed-building thunk, sparkle, and click
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, sound, stack } from '../src/index';

export const placeBuilding = stack(
  note('c2')
    .sound('triangle')
    .attack(0.001)
    .decay(0.1)
    .sustain(0)
    .release(0.05)
    .gain(0.9)
    .lpf(220)
    .lpenv(5)
    .lpa(0.001)
    .lpd(0.08)
    .lps(0)
    .lpr(0.05)
    .slide(0.07),
  note('c6')
    .sound('sine')
    .attack(0.001)
    .decay(0.15)
    .sustain(0)
    .release(0.1)
    .gain(0.3)
    .lpf(2000)
    .lpenv(8)
    .lpa(0.001)
    .lpd(0.06)
    .lps(0)
    .lpr(0.1)
    .nudge(0.02),
  sound('white').attack(0).decay(0.02).sustain(0).release(0.01).gain(0.4).lpf(4000).lpenv(0)
);
