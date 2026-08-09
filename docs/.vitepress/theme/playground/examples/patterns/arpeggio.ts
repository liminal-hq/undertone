// Playground example: Arpeggio
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const arpeggio: ComposerExample = {
  label: 'Arpeggio',
  bpm: 140,
  code: `// A held mini-notation phrase, transformed every 2nd cycle.
return note('c3 e3 g3 <b3 c4>')
  .sound('triangle')
  .attack(0.004).decay(0.12).sustain(0.35).release(0.08)
  .gain(0.6)
  .lpf(2500)
  .every(2, rev);`
};
