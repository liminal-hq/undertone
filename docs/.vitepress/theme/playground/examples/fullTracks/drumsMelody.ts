// Playground example: Drums + melody
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const drumsMelody: ComposerExample = {
  label: 'Drums + melody',
  code: `// Euclidean noise hits under a cat()'d melody that alternates cycle to cycle.
return stack(
  sound('white(3,8)').attack(0).decay(0.03).release(0.01).gain(0.5).lpf(6000),
  sound('brown(5,8,2)').attack(0).decay(0.08).gain(0.35).lpf(300),
  cat(
    note('c4 e4 g4 c5').sound('triangle').sustain(0.2),
    note('c4 d4 f4 a4').sound('triangle').sustain(0.2)
  ).gain(0.5)
);`
};
