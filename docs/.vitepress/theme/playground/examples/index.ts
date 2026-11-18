// Assembles every example group, in the order the sidebar displays them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ExampleGroup } from '../exampleTypes';
import { gameSfxExamples } from './gameSfx';
import { patternsExamples } from './patterns';
import { fullTracksExamples } from './fullTracks';
import { songsExamples } from './songs';
import { voicesExamples } from './voices';
import { movingPanExamples } from './movingPan';

// Ordered simple to advanced: one-shot SFX, then mini-notation patterns,
// then full multi-layer tracks, then real songs. The two newer groups sit at the end so the
// default example (the third group's first) keeps its place.
export const EXAMPLE_GROUPS: ExampleGroup[] = [
  { label: 'Game SFX', examples: gameSfxExamples },
  { label: 'Patterns', examples: patternsExamples },
  { label: 'Full tracks', examples: fullTracksExamples },
  { label: 'Songs', examples: songsExamples },
  { label: 'Voices and scores', examples: voicesExamples },
  { label: 'Moving the pan', examples: movingPanExamples }
];
