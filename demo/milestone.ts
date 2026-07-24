// A short triumphant arpeggio — a population milestone, a new era, an achievement
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, stack } from '../src/index';

export const milestone = stack(
  note('c5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500),
  note('e5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500)
    .nudge(0.09),
  note('g5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500)
    .nudge(0.18),
  note('c6')
    .sound('sine')
    .attack(0.002)
    .decay(0.3)
    .sustain(0)
    .release(0.2)
    .gain(0.4)
    .lpf(5000)
    .nudge(0.27)
);
