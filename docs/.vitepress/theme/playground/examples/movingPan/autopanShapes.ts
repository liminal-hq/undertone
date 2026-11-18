// Playground example: Autopan shapes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const autopanShapes: ComposerExample = {
  label: 'Autopan shapes',
  bpm: 110,
  code: `// The LFO's wave and where it starts: sine, then triangle, then a square that jumps
// between the sides, then a sine started on the other side with autopanphase(0.5).
const arp = note('c3 e3 g3 b3 c4 b3 g3 e3').sound('sawtooth').attack(0.005).decay(0.2).sustain(0.3).release(0.1).lpf(2200).gain(0.3);
return cat(
  arp.autopan(1).autopanshape('sine'),
  arp.autopan(1).autopanshape('triangle'),
  arp.autopan(2).autopanshape('square').autopandepth(0.6),
  arp.autopan(1).autopanphase(0.5)
);`
};
