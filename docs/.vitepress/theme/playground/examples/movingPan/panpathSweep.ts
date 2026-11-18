// Playground example: Panpath sweep
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const panpathSweep: ComposerExample = {
  label: 'Panpath sweep',
  bpm: 90,
  code: `// panpath() moves the pan inside each note. { time, pan } points ramp (seconds from the onset):
// every note sweeps from hard right to hard left over half a second.
return note('a2 e3 a3 c4')
  .sound('sawtooth')
  .attack(0.01).decay(0.3).sustain(0.6).release(0.4)
  .lpf(1500)
  .gain(0.3)
  .legato(1)
  .panpath([
    { time: 0, pan: 1 },
    { time: 0.5, pan: -1 }
  ]);`
};
