// A crunchy demolition sound — brown noise crunch under a descending thunk
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, sound, stack } from '../src/index';

export const bulldoze = stack(
  note('a1')
    .sound('sawtooth')
    .attack(0.001)
    .decay(0.14)
    .sustain(0)
    .release(0.08)
    .gain(0.7)
    .lpf(180)
    .lpenv(3)
    .lpa(0.001)
    .lpd(0.1)
    .lps(0)
    .lpr(0.08)
    .slide(0.12),
  sound('brown').attack(0.001).decay(0.1).sustain(0.1).release(0.12).gain(0.5).lpf(900).lpenv(0)
);
