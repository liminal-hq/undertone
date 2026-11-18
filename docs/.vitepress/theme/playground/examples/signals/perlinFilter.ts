// Playground example: Perlin filter walk
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const perlinFilter: ComposerExample = {
  label: 'Perlin filter walk',
  bpm: 110,
  code: `// perlin is smooth random motion: it passes through a new random value each cycle and glides between them.
// .range(300, 2400) puts the walk between two filter cutoffs, read at the onset of each note.
return note('c2*8')
  .sound('sawtooth')
  .attack(0.003).decay(0.18).sustain(0.2).release(0.1)
  .lpf(perlin.range(300, 2400))
  .gain(0.35);`
};
