// Builds a voice's frequency automation (slide, pitch envelope or stepped curve) as ratios of its base pitch
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioParamLike, VoiceParams } from './types.js';
import { warnOnce } from './warn.js';

/** One automation step: jump to (`set`) or exponentially ramp to (`ramp`) `ratio` × the base pitch at `time`. */
export interface CurveEvent {
  kind: 'set' | 'ramp';
  /** Multiplier on the base frequency; 1 is the note itself, 2 an octave above. */
  ratio: number;
  /** Absolute time on the context's clock. */
  time: number;
}

const SLIDE_START_RATIO = 2; // an octave above the target — matches a percussive downward "thunk"
const DEFAULT_PITCH_DECAY_SECONDS = 0.1;
const DEFAULT_PITCH_STEP_RATE_HZ = 140; // the frame rate of classic AdLib sound effects

function semitonesToRatio(semitones: number): number {
  return 2 ** (semitones / 12);
}

/**
 * The frequency automation for one voice, relative to its base pitch, so the
 * same curve can drive the carrier and anything tracking it (an FM modulator
 * at a multiple of the pitch, say) by scaling the ratios.
 *
 * Priority when several are set: stepped `pitchSteps`, then the `pitchEnvAmount`
 * envelope, then `slideTime`. Combining them is unsupported (warns once), since
 * their meanings overlap and a silent blend would be hard to reason about.
 */
export function buildPitchCurve(params: VoiceParams, voiceStart: number): CurveEvent[] {
  const hasSteps = params.pitchSteps !== undefined && params.pitchSteps.length > 0;
  const hasEnvelope = params.pitchEnvAmount !== undefined && params.pitchEnvAmount !== 0;
  const hasSlide = params.slideTime > 0;

  if (Number(hasSteps) + Number(hasEnvelope) + Number(hasSlide) > 1) {
    warnOnce(
      'pitch-curve-combined',
      'undertone: pitchsteps(), penv() and slide() overlap — only one applies (steps, then penv, then slide).'
    );
  }

  if (hasSteps) {
    const rate = params.pitchStepRate ?? DEFAULT_PITCH_STEP_RATE_HZ;
    return (params.pitchSteps as number[]).map((semitones, frame) => ({
      kind: 'set',
      ratio: semitonesToRatio(semitones),
      time: voiceStart + frame / rate
    }));
  }

  if (hasEnvelope) {
    const peak = semitonesToRatio(params.pitchEnvAmount as number);
    const attack = params.pitchAttack ?? 0;
    const decay = params.pitchDecay ?? DEFAULT_PITCH_DECAY_SECONDS;
    const events: CurveEvent[] = [];
    if (attack > 0) {
      events.push({ kind: 'set', ratio: 1, time: voiceStart });
      events.push({ kind: 'ramp', ratio: peak, time: voiceStart + attack });
    } else {
      events.push({ kind: 'set', ratio: peak, time: voiceStart });
    }
    events.push(
      decay > 0
        ? { kind: 'ramp', ratio: 1, time: voiceStart + attack + decay }
        : { kind: 'set', ratio: 1, time: voiceStart + attack }
    );
    return events;
  }

  if (hasSlide) {
    return [
      { kind: 'set', ratio: SLIDE_START_RATIO, time: voiceStart },
      { kind: 'ramp', ratio: 1, time: voiceStart + params.slideTime }
    ];
  }

  return [{ kind: 'set', ratio: 1, time: voiceStart }];
}

/** Writes `events` onto `param`, with every ratio multiplied by `base` (the pitch, or a multiple of it). */
export function applyPitchCurve(param: AudioParamLike, base: number, events: CurveEvent[]): void {
  for (const event of events) {
    if (event.kind === 'set') {
      param.setValueAtTime(base * event.ratio, event.time);
    } else {
      param.exponentialRampToValueAtTime(base * event.ratio, event.time);
    }
  }
}
