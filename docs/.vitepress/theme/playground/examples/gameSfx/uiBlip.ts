// Playground example: UI Blip
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const uiBlip: ComposerExample = {
  label: 'UI Blip',
  code: `// A short, higher-pitched confirmation blip — menu clicks, toggles.
return stack(
  note('a5').sound('sine').attack(0.001).decay(0.06).sustain(0).release(0.03).gain(0.5).lpf(3000),
  sound('white').attack(0).decay(0.008).sustain(0).release(0.005).gain(0.15).lpf(6000)
);`
};
