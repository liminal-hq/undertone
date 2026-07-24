// A short denied/error buzz — a descending square-wave slide through a tight filter
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, stack } from '../src/index';

export const error = stack(
  note('a2')
    .sound('square')
    .attack(0.001)
    .decay(0.12)
    .sustain(0)
    .release(0.08)
    .gain(0.5)
    .lpf(600)
    .lpenv(0)
    .slide(0.15)
);
