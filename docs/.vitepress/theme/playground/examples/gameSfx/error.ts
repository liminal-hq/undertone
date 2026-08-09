// Playground example: Error
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const errorSfx: ComposerExample = {
  label: 'Error',
  code: `// A denied/error buzz — a descending square-wave slide through a tight filter.
return note('a2')
  .sound('square')
  .attack(0.001).decay(0.12).sustain(0).release(0.08)
  .gain(0.5)
  .lpf(600).lpenv(0)
  .slide(0.15);`
};
