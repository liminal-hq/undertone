// Signals examples, in display order
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { hatsDrift } from './hatsDrift';
import { perlinFilter } from './perlinFilter';
import { randomVelocity } from './randomVelocity';
import { signalMelody } from './signalMelody';
import { phaseCarry } from './phaseCarry';
import type { ComposerExample } from '../../exampleTypes';

export const signalsExamples: ComposerExample[] = [
  hatsDrift,
  perlinFilter,
  randomVelocity,
  signalMelody,
  phaseCarry
];
