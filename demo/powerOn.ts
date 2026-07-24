// A rising sweep — a plant/line just connected a zone to the power grid
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, stack } from '../src/index';

export const powerOn = stack(
  note('a3')
    .sound('sawtooth')
    .attack(0.02)
    .decay(0.14)
    .sustain(0.4)
    .release(0.1)
    .gain(0.35)
    .lpf(300)
    .lpenv(2200)
    .lpa(0.16)
    .lpd(0.05)
    .lps(0.6)
    .lpr(0.1)
);
