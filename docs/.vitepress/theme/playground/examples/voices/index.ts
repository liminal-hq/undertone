// Voices and scores examples, in display order
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { fmBell } from './fmBell';
import { fmPluck } from './fmPluck';
import { shapedWaves } from './shapedWaves';
import { pitchsteps } from './pitchsteps';
import { humanised } from './humanised';
import { tickScore } from './tickScore';
import type { ComposerExample } from '../../exampleTypes';

export const voicesExamples: ComposerExample[] = [
  fmBell,
  fmPluck,
  shapedWaves,
  pitchsteps,
  humanised,
  tickScore
];
