// Playground example: Generative
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const generative: ComposerExample = {
  label: 'Generative',
  code: `// Build a pattern from a plain JS array instead of typing mini-notation.
const scale = [0, 2, 4, 7, 9]; // major pentatonic, semitone offsets from c4
const notes = scale.map((semitones) => noteToFrequency('c4') * 2 ** (semitones / 12));

return seq(...notes.map((hz) => note(hz).sound('triangle').sustain(0.3)))
  .fast(2)
  .sound('triangle')
  .gain(0.5)
  .lpf(3000);`
};
