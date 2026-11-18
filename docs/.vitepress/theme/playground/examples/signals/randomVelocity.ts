// Playground example: Repeatable random velocity
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const randomVelocity: ComposerExample = {
  label: 'Repeatable random velocity',
  bpm: 120,
  code: `// rand is random but repeatable: its value depends only on the seed and the time, so the same seed gives
// the same sequence every time you play it. Each cycle reads its own stretch of time, so cycle 2 differs from cycle 1.
// arrange([1, ...]) makes the signal live through its first cycle again on every cycle, so the accents repeat.
// Change the seed (7) for another take; seed goes directly on the random signal, before range().
return stack(
  sound('white*16').attack(0.001).decay(0.025).release(0.01).hpf(7000).gain(0.4)
    .velocity(arrange([1, rand.seed(7).range(0.25, 1)])),
  note('c1 ~ [~ c1] ~').sound('sine').attack(0.001).decay(0.15).release(0.05).gain(0.8).slide(0.08)
);`
};
