// Playground example: FM bell
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const fmBell: ComposerExample = {
  label: 'FM bell',
  bpm: 100,
  code: `// An FM instrument kept as plain data: fmPresets.glassBell applied with voice().
// Chain controls after voice() and they win, so .gain() turns it down without touching the rest.
return note('e5 g5 b5 a5 ~ e5 ~ b4')
  .voice(fmPresets.glassBell)
  .gain(0.35)
  .room(0.3);`
};
