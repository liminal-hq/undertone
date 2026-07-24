// A soft two-tone chime — a news ticker item or advisor alert arrived
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, stack } from '../src/index';

export const notification = stack(
  note('e5').sound('sine').attack(0.005).decay(0.1).sustain(0.1).release(0.1).gain(0.35).lpf(3000),
  note('b4')
    .sound('sine')
    .attack(0.005)
    .decay(0.12)
    .sustain(0.1)
    .release(0.12)
    .gain(0.3)
    .lpf(3000)
    .nudge(0.1)
);
