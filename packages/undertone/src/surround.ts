// Speaker-ring gains and the stereo fold-down, from the module, and the channel constants it defines
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { glue } from './wasm.js';

// The values are the module's, read once when an entry has loaded it (`loadSurround`), so Rust stays the only place that knows
// them. They are live bindings: reading one before the module has loaded (with the `./init` entry, before `await init()`)
// gives `undefined`.

/**
 * Channel order used throughout: FL, FR, C, LFE, SL, SR, RL, RR — the
 * conventional Web Audio / SMPTE layout for 2 (stereo), 6 (5.1), and 8 (7.1)
 * channel destinations. Shorter channelGains arrays address a prefix of it.
 */
// prettier-ignore
// The double quotes are how the API report prints the reference's `as const` tuple.
export let CHANNEL_ORDER: readonly ["FL", "FR", "C", "LFE", "SL", "SR", "RL", "RR"];

export let MAX_CHANNELS: 8;

/** Reads the constants from the module. Called by the entries once it is instantiated. */
export function loadSurround(): void {
  CHANNEL_ORDER = glue.channelOrder() as unknown as typeof CHANNEL_ORDER;
  MAX_CHANNELS = glue.maxChannels() as typeof MAX_CHANNELS;
}

/**
 * Computes 7.1 channel gains that place a sound at `angleDegrees` on the
 * speaker ring (0° front-centre, 30° front-right, ±90° sides, ±150° rears,
 * ±180° dead-behind) using equal-power panning between the two nearest
 * speakers. The LFE channel is always 0 — route to it explicitly with
 * channels() if you want rumble.
 */
export function surroundGains(angleDegrees: number): number[] {
  return glue.surroundGains(angleDegrees) as number[];
}

/**
 * Folds 7.1 channel gains down to a stereo pair [left, right], the same way a
 * voice does when its destination cannot address that many speakers.
 */
export function foldToStereo(channelGains: number[]): number[] {
  return glue.foldToStereo(channelGains) as number[];
}
