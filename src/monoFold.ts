// A mono fold-down node for reviewing a stereo mix as a single speaker would play it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioContextLike, AudioNodeLike, GainNodeLike } from './types.js';

/**
 * Creates a node that folds everything played into it down to mono before
 * `output` (the speakers by default), the way a phone speaker or a mono
 * Bluetooth speaker plays a stereo mix. Pass its result as `output` to
 * `play()` or `loop()`, or in front of a master bus, to check that a
 * natively stereo cue still balances on one speaker.
 *
 * The fold-down is Web Audio's standard speakers down-mix, `0.5 × (L + R)`:
 * a centred voice (equal-power pan, left and right at about 0.707) keeps
 * its level, and a voice panned fully to one side drops by 6 dB.
 */
export function createMonoFold(
  ctx: AudioContextLike,
  output: AudioNodeLike = ctx.destination
): GainNodeLike {
  const fold = ctx.createGain();
  fold.channelCount = 1;
  fold.channelCountMode = 'explicit';
  fold.channelInterpretation = 'speakers';
  fold.connect(output);
  return fold;
}
