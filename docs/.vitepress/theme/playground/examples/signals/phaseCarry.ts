// Playground example: Autopan phase from note to note
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const phaseCarry: ComposerExample = {
  label: 'Autopan phase from note to note',
  bpm: 80,
  code: `// autopanphase takes a pattern: a slow saw steps the LFO's start phase round once every four cycles,
// so each chord's autopan carries on a little further than where the last one began.
return chord('<Am7 Fmaj7>')
  .voicing()
  .sound('triangle')
  .attack(0.2).decay(0.3).sustain(0.7).release(0.6)
  .gain(0.25)
  .autopan(0.5)
  .autopandepth(0.8)
  .autopanphase(saw.slow(4));`
};
