// Playground example: Pan slide lead
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const panSlideLead: ComposerExample = {
  label: 'Pan slide lead',
  bpm: 100,
  code: `// Every note flies in from the far left to where it sits (pan 0.4) over 0.12 s.
// panslide(from, seconds) is slide() for the pan; leave seconds out to slide over the attack.
return note('e4 g4 b4 a4 g4 e4 d4 ~')
  .sound('square')
  .attack(0.005).decay(0.15).sustain(0.4).release(0.1)
  .lpf(2800)
  .gain(0.3)
  .pan(0.4)
  .panslide(-1, 0.12)
  .delay(0.25).delaytime(0.3);`
};
