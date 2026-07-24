// A quick reverse blip — undoing the last action
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, stack } from '../src/index';

export const undo = stack(
  note('a4')
    .sound('square')
    .attack(0.001)
    .decay(0.08)
    .sustain(0)
    .release(0.04)
    .gain(0.35)
    .lpf(2200)
    .slide(0.05)
);
