// Realizes voice parameters as an actual Web Audio node graph with scheduled envelopes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioContextLike, AudioParamLike, VoiceParams } from './types';
import { noteToFrequency } from './pitch';
import { buildNoiseBuffer } from './noise';

const DEFAULT_OSCILLATOR_FREQUENCY = 440;
const SLIDE_START_MULTIPLIER = 2; // an octave above the target — matches a percussive downward "thunk"
const STOP_TAIL_SECONDS = 0.02; // headroom past the last ramp so the ramp actually completes before stop()

/**
 * Schedules a percussive attack→decay→(no held plateau)→release envelope on an
 * AudioParam, ramping between `base` and `peak` rather than assuming 0 is the
 * floor — gain envelopes use base=0, filter envelopes use base=the resting cutoff.
 * Returns the absolute time the envelope finishes (fully released).
 */
function scheduleEnvelope(
  param: AudioParamLike,
  startTime: number,
  base: number,
  peak: number,
  attack: number,
  decay: number,
  sustainFraction: number,
  release: number
): number {
  const sustainValue = base + (peak - base) * sustainFraction;

  param.setValueAtTime(base, startTime);

  const attackEnd = startTime + attack;
  if (attack > 0) {
    param.linearRampToValueAtTime(peak, attackEnd);
  } else {
    param.setValueAtTime(peak, startTime);
  }

  const decayEnd = attackEnd + decay;
  if (decay > 0) {
    param.linearRampToValueAtTime(sustainValue, decayEnd);
  } else {
    param.setValueAtTime(sustainValue, decayEnd);
  }

  const releaseEnd = decayEnd + release;
  if (release > 0) {
    param.linearRampToValueAtTime(base, releaseEnd);
  }

  return releaseEnd;
}

function isNoiseType(soundType: VoiceParams['soundType']): soundType is 'white' | 'pink' | 'brown' {
  return soundType === 'white' || soundType === 'pink' || soundType === 'brown';
}

/** Realizes a single voice against a real (or fake, for tests) AudioContext, starting at `startTime`. */
export function playVoice(ctx: AudioContextLike, params: VoiceParams, startTime: number): void {
  const voiceStart = startTime + params.nudgeTime;

  const gainNode = ctx.createGain();
  const gainReleaseEnd = scheduleEnvelope(
    gainNode.gain,
    voiceStart,
    0,
    params.gainLevel,
    params.attack,
    params.decay,
    params.sustain,
    params.release
  );

  let filterReleaseEnd = gainReleaseEnd;

  const source = isNoiseType(params.soundType) ? ctx.createBufferSource() : ctx.createOscillator();

  if (isNoiseType(params.soundType)) {
    const bufferSource = source as ReturnType<AudioContextLike['createBufferSource']>;
    const bufferDuration = Math.max(gainReleaseEnd - voiceStart, 0.05);
    bufferSource.buffer = buildNoiseBuffer(ctx, params.soundType, bufferDuration);
  } else {
    const oscillator = source as ReturnType<AudioContextLike['createOscillator']>;
    oscillator.type = params.soundType;
    const targetFreq =
      params.pitch !== undefined ? noteToFrequency(params.pitch) : DEFAULT_OSCILLATOR_FREQUENCY;
    if (params.slideTime > 0) {
      oscillator.frequency.setValueAtTime(targetFreq * SLIDE_START_MULTIPLIER, voiceStart);
      oscillator.frequency.exponentialRampToValueAtTime(targetFreq, voiceStart + params.slideTime);
    } else {
      oscillator.frequency.setValueAtTime(targetFreq, voiceStart);
    }
  }

  if (params.filterCutoff !== undefined) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filterReleaseEnd = scheduleEnvelope(
      filter.frequency,
      voiceStart,
      params.filterCutoff,
      params.filterCutoff + params.filterEnvAmount,
      params.filterAttack,
      params.filterDecay,
      params.filterSustain,
      params.filterRelease
    );
    source.connect(filter);
    filter.connect(gainNode);
  } else {
    source.connect(gainNode);
  }

  gainNode.connect(ctx.destination);

  const voiceEnd = Math.max(gainReleaseEnd, filterReleaseEnd) + STOP_TAIL_SECONDS;
  source.start(voiceStart);
  source.stop(voiceEnd);
}

/** Realizes every voice in a stack together, each offset by its own nudge time from `when`. */
export function playVoices(ctx: AudioContextLike, voicesParams: VoiceParams[], when: number): void {
  for (const params of voicesParams) {
    playVoice(ctx, params, when);
  }
}
