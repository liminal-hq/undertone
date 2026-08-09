// Playground example: Helper functions
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const helperFunctions: ComposerExample = {
  label: 'Helper functions',
  code: `// It's real JS — define helpers, loop, branch, whatever you need.
const bass = (n) => note(n).sound('square').lpf(500).sustain(0.2).gain(0.6);
const pad = (n) => note(n).sound('sine').sustain(0.9).gain(0.3).lpf(1200);

return stack(
  seq(bass('c2'), bass('c2'), bass('f2'), bass('g2')),
  pad('<[c3,e3,g3] [f3,a3,c4]>')
);`
};
