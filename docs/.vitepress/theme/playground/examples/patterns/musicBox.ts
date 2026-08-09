// Playground example: Music box
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const musicBox: ComposerExample = {
  label: 'Music box',
  bpm: 100,
  code: `// A doubled-up alternating melody with a rest, juxed hard left/right.
return note('<c5 e5 g5 b5 a5 g5>*2 ~')
  .sound('sine')
  .attack(0.004).decay(0.12).sustain(0.5).release(0.08)
  .gain(0.6)
  .lpf(4000)
  .jux(rev);`
};
