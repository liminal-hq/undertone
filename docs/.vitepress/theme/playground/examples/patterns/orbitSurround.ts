// Playground example: Orbit (7.1)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const orbitSurround: ComposerExample = {
  label: 'Orbit (7.1)',
  bpm: 120,
  code: `// Two euclidean layers placed on the 7.1 surround ring.
return note('c4(5,8) e4(3,8,2)')
  .sound('triangle')
  .attack(0.004).decay(0.12).sustain(0.2).release(0.08)
  .gain(0.6)
  .lpf(2500)
  .surround(135);`
};
