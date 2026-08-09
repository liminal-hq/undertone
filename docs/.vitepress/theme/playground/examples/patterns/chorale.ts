// Playground example: Chorale
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const chorale: ComposerExample = {
  label: 'Chorale',
  bpm: 80,
  code: `// A four-chord progression, one chord per cycle.
return note('<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>')
  .sound('sine')
  .attack(0.004).decay(0.12).sustain(0.85).release(0.08)
  .gain(0.6)
  .lpf(1800);`
};
