// Playground example: Autopan phase from note to note
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const phaseCarry: ComposerExample = {
  label: 'Autopan phase from note to note',
  bpm: 80,
  code: `// autopanphase takes a pattern. A pattern cycle is four beats, 240 / bpm seconds: 3 s at 80 BPM,
// so a 0.5 Hz LFO turns 0.5 x 3 = 1.5 times per cycle. saw.fast(1.5) is that LFO's phase at each
// onset (0, 0.5, 0, 0.5, ...), so every chord's autopan carries on where an LFO running under
// the whole loop would be. Change the rate or the tempo and change the 1.5 to match.
return chord('<Am7 Fmaj7>')
  .voicing()
  .sound('triangle')
  .attack(0.2).decay(0.3).sustain(0.7).release(0.6)
  .gain(0.25)
  .autopan(0.5)
  .autopandepth(0.8)
  .autopanphase(saw.fast(1.5));`
};
