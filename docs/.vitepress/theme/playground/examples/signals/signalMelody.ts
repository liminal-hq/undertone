// Playground example: A melody from a signal
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const signalMelody: ComposerExample = {
  label: 'A melody from a signal',
  bpm: 100,
  code: `// segment(8) cuts a signal into eight events a cycle; n() floors each value into a scale degree.
// A sine from 0 to 7 climbs and falls through C major, and tri sweeps the pan the other way.
return n(sine.segment(8).range(0, 7))
  .scale('C4:major')
  .sound('triangle')
  .attack(0.005).decay(0.25).sustain(0.3).release(0.2)
  .gain(0.3)
  .pan(tri2.slow(2))
  .room(0.25);`
};
