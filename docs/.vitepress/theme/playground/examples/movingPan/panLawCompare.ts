// Playground example: Pan laws
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const panLawCompare: ComposerExample = {
  label: 'Pan laws',
  bpm: 100,
  code: `// The same panned notes under three pan laws, one per cycle: -6 dB, -3 dB (the default), 0 dB.
// panlaw(db) sets each side's level at the centre. Listen to how full the middle of the stereo
// image is as the notes cross it: -6 dips, -3 is equal power, 0 is a balance control.
const crossing = note('c3 e3 g3 e3 c4 e4 g4 e4')
  .sound('triangle')
  .attack(0.005).decay(0.2).sustain(0.5).release(0.1)
  .gain(0.35)
  .pan('-1 -0.5 0 0.5 1 0.5 0 -0.5');
return cat(crossing.panlaw(-6), crossing.panlaw(-3), crossing.panlaw(0));`
};
