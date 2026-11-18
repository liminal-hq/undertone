// Playground example: FM pluck bass
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const fmPluck: ComposerExample = {
  label: 'FM pluck bass',
  bpm: 110,
  code: `// FM with its own envelope: bright at the onset, mellowing as the modulator's depth decays.
// fmh is the harmonicity (modulator / note frequency); fm is the index.
return note('a1 ~ a1 e2 ~ a1 g1 ~')
  .sound('sine')
  .fm(4).fmh(1).fmdecay(0.15).fmsustain(0.2)
  .attack(0.003).decay(0.25).sustain(0.4).release(0.1)
  .duration(0.2)
  .gain(0.5);`
};
