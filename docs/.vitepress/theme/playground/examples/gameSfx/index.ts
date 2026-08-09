// Game SFX examples, in display order
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { placeBuilding } from './placeBuilding';
import { uiBlip } from './uiBlip';
import { errorSfx } from './error';
import { bulldoze } from './bulldoze';
import { cashIn } from './cashIn';
import { powerOn } from './powerOn';
import { milestone } from './milestone';
import { notification } from './notification';
import { undoSfx } from './undo';
import type { ComposerExample } from '../../exampleTypes';

export const gameSfxExamples: ComposerExample[] = [
  placeBuilding,
  uiBlip,
  errorSfx,
  bulldoze,
  cashIn,
  powerOn,
  milestone,
  notification,
  undoSfx
];
