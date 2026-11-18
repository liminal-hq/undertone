// Playground example: Shaped waves
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const shapedWaves: ComposerExample = {
  label: 'Shaped waves',
  bpm: 100,
  code: `// Three shaped sines as sound types, one per cycle: halfsine, abssine (an octave up) and pulsesine.
const line = note('c3 e3 g3 c4 g3 e3 c3 ~').attack(0.005).decay(0.2).sustain(0.5).release(0.1).lpf(3000).gain(0.3);
return cat(line.sound('halfsine'), line.sound('abssine'), line.sound('pulsesine'));`
};
