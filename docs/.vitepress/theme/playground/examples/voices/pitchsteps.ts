// Playground example: Pitch steps
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const pitchsteps: ComposerExample = {
  label: 'Pitch steps',
  bpm: 120,
  code: `// pitchsteps() is a frame-stepped pitch curve: semitone offsets at 140 frames a second,
// holding the last. Here every note arpeggiates a major chord in two frames per tone, then settles.
return note('c3 g2 e3 g2')
  .sound('square')
  .attack(0.002).decay(0.15).sustain(0.5).release(0.1)
  .gain(0.25)
  .legato(1)
  .pitchsteps([0, 0, 4, 4, 7, 7, 12, 12, 0], 60);`
};
