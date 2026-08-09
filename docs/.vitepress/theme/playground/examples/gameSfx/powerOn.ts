// Playground example: Power On
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const powerOn: ComposerExample = {
  label: 'Power On',
  code: `// A rising sweep — a plant just connected to the power grid.
return note('a3')
  .sound('sawtooth')
  .attack(0.02).decay(0.14).sustain(0.4).release(0.1)
  .gain(0.35)
  .lpf(300).lpenv(2200).lpa(0.16).lpd(0.05).lps(0.6).lpr(0.1);`
};
