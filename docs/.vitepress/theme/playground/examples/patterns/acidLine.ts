// Playground example: Acid line
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const acidLine: ComposerExample = {
  label: 'Acid line',
  bpm: 150,
  code: `// A sawtooth bassline, juxtaposed against its own reverse.
return note('a1 [a1 a2] c2 <e2 g1>')
  .sound('sawtooth')
  .attack(0.004).decay(0.12).sustain(0.25).release(0.08)
  .gain(0.6)
  .lpf(700)
  .jux(rev);`
};
