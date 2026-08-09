// Playground example: Cash In
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const cashIn: ComposerExample = {
  label: 'Cash In',
  code: `// A bright ascending two-note chime — a sale completed, income received.
return stack(
  note('c5').sound('triangle').attack(0.002).decay(0.12).sustain(0).release(0.08).gain(0.5).lpf(4000),
  note('e5').sound('triangle').attack(0.002).decay(0.16).sustain(0).release(0.1).gain(0.5).lpf(4500).nudge(0.06)
);`
};
