// Playground example: Humanised groove
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const humanised: ComposerExample = {
  label: 'Humanised groove',
  bpm: 100,
  code: `// drift() adds seeded, repeatable variation in timing, level, pitch and pan. The same seed gives
// the same groove everywhere; each loop pass varies differently.
const groove = note('c2 ~ c2 g1 ~ c2 e2 g1')
  .sound('sawtooth')
  .attack(0.003).decay(0.2).sustain(0.3).release(0.1)
  .lpf(600).gain(0.5);
return drift(groove, { seed: 'playground-bass', timing: 0.01, level: 0.15, cents: 6, pan: 0.2 });`
};
