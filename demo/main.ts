// Wires up the demo page's preset buttons and the playground
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { SoundEffect } from '../src/index';
import { placeBuilding } from './placeBuilding';
import { uiBlip } from './uiBlip';
import { error } from './error';
import { initPlayground } from './playground';

function wireButton(selector: string, effect: SoundEffect): void {
  const button = document.querySelector<HTMLButtonElement>(selector);
  button?.addEventListener('click', () => effect.play());
}

wireButton('#play-place-building', placeBuilding);
wireButton('#play-ui-blip', uiBlip);
wireButton('#play-error', error);

initPlayground();
