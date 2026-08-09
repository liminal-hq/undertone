// Playground example: Polyrhythm
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const polyrhythm: ComposerExample = {
  label: 'Polyrhythm',
  bpm: 110,
  code: `// A 3-against-2 layer, written as one parallel step.
return note('[c4 e4 g4, c2 f2]')
  .sound('triangle')
  .attack(0.004).decay(0.12).sustain(0.4).release(0.08)
  .gain(0.6)
  .lpf(2500);`
};
