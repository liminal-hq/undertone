// Playground example: Panpath step
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const panpathStep: ComposerExample = {
  label: 'Panpath step',
  bpm: 110,
  code: `// An array of pans is frame-stepped: one pan per frame at the rate you give (here 30 a second),
// jumping from frame to frame and holding the last. A fast left-right flutter that settles centre.
return note('c4 e4 g4 e4')
  .sound('square')
  .attack(0.003).decay(0.2).sustain(0.5).release(0.15)
  .lpf(3000)
  .gain(0.25)
  .legato(1)
  .panpath([-0.8, 0.8, -0.8, 0.8, -0.4, 0.4, 0], 30);`
};
