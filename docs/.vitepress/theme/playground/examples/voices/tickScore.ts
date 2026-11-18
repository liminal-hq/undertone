// Playground example: Tick score
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const tickScore: ComposerExample = {
  label: 'Tick score',
  bpm: 100,
  code: `// score() places events at exact ticks (here 560 a second, like AdLib) instead of a grid.
// The loop length includes the quiet tail, and the seam is exact. Tick scores play at their own tempo.
return score({
  ticksPerSecond: 560,
  lengthTicks: 2240,
  events: [
    { tick: 0, note: 'e4', gate: 140, voice: fmPresets.lead },
    { tick: 211, note: 'g4', gate: 140, level: 0.7, voice: fmPresets.lead },
    { tick: 560, note: 'b4', gate: 280, voice: fmPresets.lead },
    { tick: 1120, midi: 52, gate: 280, voice: fmPresets.roundBass, pan: -0.1 }
  ]
}).pattern;`
};
