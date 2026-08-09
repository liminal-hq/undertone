// Playground example: Euclid groove
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const euclidGroove: ComposerExample = {
  label: 'Euclid groove',
  bpm: 130,
  code: `// Three layered euclidean rhythms, one string each.
return note('[c2(3,8), g2(5,8,2), c4(7,16,4)]')
  .sound('square')
  .attack(0.004).decay(0.12).sustain(0.12).release(0.08)
  .gain(0.6)
  .lpf(900);`
};
