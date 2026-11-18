// Moving the pan examples, in display order
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { autopanPad } from './autopanPad';
import { autopanShapes } from './autopanShapes';
import { panSlideLead } from './panSlideLead';
import { panpathSweep } from './panpathSweep';
import { panpathStep } from './panpathStep';
import { panLawCompare } from './panLawCompare';
import type { ComposerExample } from '../../exampleTypes';

export const movingPanExamples: ComposerExample[] = [
  autopanPad,
  autopanShapes,
  panSlideLead,
  panpathSweep,
  panpathStep,
  panLawCompare
];
