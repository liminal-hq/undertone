// A bright ascending two-note chime — tax collected, a sale completed, income received
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, stack } from '../src/index';

export const cashIn = stack(
  note('c5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.12)
    .sustain(0)
    .release(0.08)
    .gain(0.5)
    .lpf(4000),
  note('e5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.16)
    .sustain(0)
    .release(0.1)
    .gain(0.5)
    .lpf(4500)
    .nudge(0.06)
);
