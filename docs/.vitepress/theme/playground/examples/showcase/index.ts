// Showcase songs examples, in display order: whole pieces that each feature a few parts of the library
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { blueHour } from './blueHour';
import { circleAtDusk } from './circleAtDusk';
import { lanternLullaby } from './lanternLullaby';
import { pixelQuest } from './pixelQuest';
import { sodiumLights } from './sodiumLights';
import { tidepool } from './tidepool';
import type { ComposerExample } from '../../exampleTypes';

export const showcaseExamples: ComposerExample[] = [
  // A slow jazz ballad in F: chord voicings with an anchor, modal scale runs, swing from a patterned nudge.
  blueHour,
  // A chiptune adventure theme in C: cut groups as console channels, pitchsteps arpeggios, nested arrange().
  pixelQuest,
  // A waltz-time lullaby in G: layer() and fmVoice() music box, drift() humanising, mini() + add() harp.
  lanternLullaby,
  // Generative ambient in D pentatonic: seeded random signals, rangex filter sweeps, a seeded section that returns.
  tidepool,
  // Night-drive synthwave in F minor: panpath streetlights, panlaw, panslide, autopan strings, a velocity pump.
  sodiumLights,
  // A polyrhythmic drum circle in twelve-eight: euclid rhythms, timecat clave, surround placement, orbits.
  circleAtDusk
];
