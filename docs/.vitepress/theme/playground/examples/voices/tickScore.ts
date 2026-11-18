// Playground example: Tick score
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const tickScore: ComposerExample = {
  label: 'Tick score',
  bpm: 60,
  code: `// score() places events at exact ticks (here 560 a second, like AdLib) instead of a grid.
// The loop length includes the quiet tail, and the seam is exact.
// The score runs 2240 ticks at 560 a second, a four-second cycle (cps 0.25). This returns .pattern,
// which the playground plays at the Tempo slider, not at the score's own cps, so the slider must give
// the same cycle: a cycle is 240 / bpm seconds, which is 4 at 60 bpm. This example sets it to 60.
// (In your own code, cue.loop() plays at the score's tempo and needs no bpm.)
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
