// Multichannel (up to 7.1) placement: speaker-ring gains, stereo fold-down, destination setup
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioContextLike } from './types.js';

/**
 * Channel order used throughout: FL, FR, C, LFE, SL, SR, RL, RR — the
 * conventional Web Audio / SMPTE layout for 2 (stereo), 6 (5.1), and 8 (7.1)
 * channel destinations. Shorter channelGains arrays address a prefix of it.
 */
export const CHANNEL_ORDER = ['FL', 'FR', 'C', 'LFE', 'SL', 'SR', 'RL', 'RR'] as const;

export const MAX_CHANNELS = CHANNEL_ORDER.length;

/** Ring speakers (LFE excluded) as [channelIndex, angleDegrees], sorted by angle; 0° is front-centre, clockwise positive. */
const RING: readonly [index: number, angle: number][] = [
  [6, -150], // RL
  [4, -90], // SL
  [0, -30], // FL
  [2, 0], // C
  [1, 30], // FR
  [5, 90], // SR
  [7, 150] // RR
];

function normalizeAngle(degrees: number): number {
  const wrapped = ((degrees % 360) + 540) % 360; // -> [0, 360)
  return wrapped - 180; // -> [-180, 180)
}

/**
 * Computes 7.1 channel gains that place a sound at `angleDegrees` on the
 * speaker ring (0° front-centre, 30° front-right, ±90° sides, ±150° rears,
 * ±180° dead-behind) using equal-power panning between the two nearest
 * speakers. The LFE channel is always 0 — route to it explicitly with
 * channels() if you want rumble.
 */
export function surroundGains(angleDegrees: number): number[] {
  if (!Number.isFinite(angleDegrees)) {
    throw new Error(`surround() angle must be a finite number, got ${angleDegrees}`);
  }
  const angle = normalizeAngle(angleDegrees);
  const gains = new Array<number>(MAX_CHANNELS).fill(0);

  // Find the ring pair bracketing the angle; the wraparound pair (RR at 150°
  // -> RL at -150°, crossing ±180°) is handled by widening the search.
  let lower = RING[RING.length - 1]; // RR at 150, treated as 150 - 360 when wrapping
  let lowerAngle = lower[1] - 360;
  for (const speaker of RING) {
    if (speaker[1] <= angle) {
      lower = speaker;
      lowerAngle = speaker[1];
    }
  }
  let upper = RING[0]; // RL at -150, treated as -150 + 360 when wrapping
  let upperAngle = upper[1] + 360;
  for (let i = RING.length - 1; i >= 0; i--) {
    if (RING[i][1] >= angle) {
      upper = RING[i];
      upperAngle = RING[i][1];
    }
  }

  if (lower[0] === upper[0]) {
    gains[lower[0]] = 1;
    return gains;
  }

  const t = (angle - lowerAngle) / (upperAngle - lowerAngle);
  gains[lower[0]] = Math.cos((t * Math.PI) / 2);
  gains[upper[0]] = Math.sin((t * Math.PI) / 2);
  return gains;
}

/**
 * Folds a multichannel gain array down to [L, R] for stereo destinations,
 * using conventional (approximate ITU-style) down-mix coefficients so voices
 * placed on centre, side, and rear speakers stay audible on stereo hardware.
 */
export function foldToStereo(channelGains: number[]): number[] {
  const g = (index: number): number => channelGains[index] ?? 0;
  const CENTRE_MIX = Math.SQRT1_2;
  const SURROUND_MIX = Math.SQRT1_2;
  const LFE_MIX = 0.5;
  return [
    g(0) + CENTRE_MIX * g(2) + LFE_MIX * g(3) + SURROUND_MIX * (g(4) + g(6)),
    g(1) + CENTRE_MIX * g(2) + LFE_MIX * g(3) + SURROUND_MIX * (g(5) + g(7))
  ];
}

/**
 * Opts a context's destination into its full hardware channel count with
 * discrete channel interpretation, so channelGains address real speakers.
 * Call once, e.g. right after creating your AudioContext; without it (or on
 * plain stereo hardware) multichannel voices fold down to stereo instead.
 * Returns the resulting output channel count.
 */
export function enableMultichannel(ctx: AudioContextLike): number {
  const destination = ctx.destination;
  const max = destination.maxChannelCount ?? 0;
  if (max > 2) {
    destination.channelCount = Math.min(max, MAX_CHANNELS);
    destination.channelInterpretation = 'discrete';
  }
  return destination.channelCount ?? 2;
}
