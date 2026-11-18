// Playground example: Hats drifting across the field
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const hatsDrift: ComposerExample = {
  label: 'Hats drifting across the field',
  bpm: 120,
  code: `// Each hat reads a slow bipolar sine at its onset: the sweep takes four cycles from left to right and back.
// Use sine2, not sine: pan runs -1 to 1, so a 0..1 sine only reaches the right side.
return stack(
  note('c1 ~ ~ ~ c1 ~ ~ ~').sound('sine').attack(0.001).decay(0.15).release(0.05).gain(0.8).slide(0.08),
  sound('white*8')
    .attack(0.001).decay(0.03).release(0.01)
    .hpf(6000)
    .gain('[.4 .2]*4')
    .pan(sine2.slow(4))
);`
};
