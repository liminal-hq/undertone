// Playground example: Undo
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const undoSfx: ComposerExample = {
  label: 'Undo',
  code: `// A quick reverse blip — undoing the last action.
return note('a4')
  .sound('square')
  .attack(0.001).decay(0.08).sustain(0).release(0.04)
  .gain(0.35)
  .lpf(2200)
  .slide(0.05);`
};
