// Playground example: Autopan pad
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const autopanPad: ComposerExample = {
  label: 'Autopan pad',
  bpm: 70,
  code: `// A pad that drifts slowly from side to side: autopan(0.25) is one sweep every four seconds.
// A real oscillator drives the panner, so it stays smooth. Try .autopandepth(1) or .autopan(2).
return chord('<Dm9 Gm9 Bbmaj7 A7>')
  .voicing()
  .sound('triangle')
  .attack(0.4).decay(0.3).sustain(0.8).release(1)
  .lpf(1800)
  .gain(0.25)
  .room(0.4).roomsize(6)
  .autopan(0.25)
  .autopandepth(0.7);`
};
