// Wires up the demo page's preset buttons and the playground
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlPatch, Pattern } from '../src/index';
import { placeBuilding } from './placeBuilding';
import { uiBlip } from './uiBlip';
import { error } from './error';
import { bulldoze } from './bulldoze';
import { cashIn } from './cashIn';
import { powerOn } from './powerOn';
import { milestone } from './milestone';
import { notification } from './notification';
import { undo } from './undo';
import { initPlayground } from './playground';
import { initPatternLab } from './patternLab';
import { initComposer } from './composer';

function wireButton(selector: string, effect: Pattern<ControlPatch>): void {
  const button = document.querySelector<HTMLButtonElement>(selector);
  button?.addEventListener('click', () => effect.play());
}

wireButton('#play-place-building', placeBuilding);
wireButton('#play-ui-blip', uiBlip);
wireButton('#play-error', error);
wireButton('#play-bulldoze', bulldoze);
wireButton('#play-cash-in', cashIn);
wireButton('#play-power-on', powerOn);
wireButton('#play-milestone', milestone);
wireButton('#play-notification', notification);
wireButton('#play-undo', undo);

initPlayground();
initPatternLab();
initComposer();
