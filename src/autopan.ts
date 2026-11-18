// Moves a voice's pan without booked points: the autopan LFO into the panner's pan, and the pan slide's path
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type {
  AudioContextLike,
  AudioParamLike,
  OscillatorNodeLike,
  PanPoint,
  VoiceParams
} from './types.js';
import { warnOnce } from './warn.js';

/** The shapes an autopan LFO can take: oscillator types, so the built-in waves are used. */
export type AutopanShape = 'sine' | 'triangle' | 'square';

/** Runtime companion to AutopanShape, for code that needs to check membership. */
export const AUTOPAN_SHAPES: readonly AutopanShape[] = ['sine', 'triangle', 'square'];

/** Harmonics in a phase-shifted triangle or square LFO: plenty for a wave at a few hertz. */
const LFO_HARMONICS = 64;

/** A voice's autopan, checked and filled in. */
export interface AutopanSettings {
  /** LFO rate in Hz. */
  rate: number;
  /** Swing either side of the voice's pan, 0 to 1. */
  depth: number;
  shape: AutopanShape;
  /** Where in its cycle the LFO starts, 0 (inclusive) to 1 (exclusive). */
  phase: number;
}

/**
 * The autopan a voice asks for: `undefined` without a positive, finite
 * `autopan` rate. The depth is clamped to 0..1 (default 1), an unknown shape is
 * a sine, and the phase wraps into 0..1 (default 0).
 */
export function autopanSettings(params: VoiceParams): AutopanSettings | undefined {
  const rate = params.autopan;
  if (rate === undefined || !(rate > 0) || !Number.isFinite(rate)) {
    return undefined;
  }
  const depth = params.autopanDepth;
  const phase = params.autopanPhase;
  return {
    rate,
    depth: depth !== undefined && Number.isFinite(depth) ? Math.max(0, Math.min(1, depth)) : 1,
    shape: AUTOPAN_SHAPES.includes(params.autopanShape as AutopanShape)
      ? (params.autopanShape as AutopanShape)
      : 'sine',
    phase: phase !== undefined && Number.isFinite(phase) ? phase - Math.floor(phase) : 0
  };
}

/**
 * The Fourier sine coefficients of a built-in oscillator wave, as the Web
 * Audio specification defines them: b1 = 1 for a sine; 8 sin(kπ/2) / (πk)²
 * for a triangle; 2 (1 - (-1)^k) / (kπ) for a square.
 */
function sineCoefficient(shape: AutopanShape, k: number): number {
  if (shape === 'sine') {
    return k === 1 ? 1 : 0;
  }
  if (shape === 'triangle') {
    return (8 * Math.sin((k * Math.PI) / 2)) / (Math.PI * k) ** 2;
  }
  return (2 * (1 - (-1) ** k)) / (k * Math.PI);
}

/**
 * Gives `lfo` its shape, started `phase` of a cycle in. Phase 0 uses the
 * built-in oscillator type. Any other phase uses a periodic wave of the same
 * series with every harmonic k turned by k · 2π · phase (a pure time shift),
 * normalized as the built-in waves are; on a context without
 * `createPeriodicWave` the phase is dropped, with a warning.
 */
function shapeLfo(
  ctx: AudioContextLike,
  lfo: OscillatorNodeLike,
  shape: AutopanShape,
  phase: number
): void {
  lfo.type = shape;
  if (phase === 0) {
    return;
  }
  if (!ctx.createPeriodicWave || !lfo.setPeriodicWave) {
    warnOnce(
      'autopan-no-periodic-wave',
      'undertone: this audio context has no createPeriodicWave(), so autopan phases are ignored.'
    );
    return;
  }
  const harmonics = shape === 'sine' ? 1 : LFO_HARMONICS;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    const b = sineCoefficient(shape, k);
    const turn = 2 * Math.PI * k * phase;
    // sin(kωt + kθ) = sin(kωt) cos(kθ) + cos(kωt) sin(kθ)
    real[k] = b * Math.sin(turn);
    imag[k] = b * Math.cos(turn);
  }
  lfo.setPeriodicWave(ctx.createPeriodicWave(real, imag));
}

/**
 * Adds an autopan LFO to a panner's `pan`: an oscillator at `rate` Hz into a
 * depth gain into the param. Web Audio adds a connected node's output to the
 * param's own value, so the booked pan (a plain pan, a path or a slide) is
 * the centre of the swing, and the panner clamps the sum to -1..1. Returns
 * the oscillator, which the caller starts and stops with the voice.
 */
export function connectAutopan(
  ctx: AudioContextLike,
  pan: AudioParamLike,
  settings: AutopanSettings,
  voiceStart: number
): OscillatorNodeLike {
  const lfo = ctx.createOscillator();
  shapeLfo(ctx, lfo, settings.shape, settings.phase);
  lfo.frequency.setValueAtTime(settings.rate, voiceStart);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(settings.depth, voiceStart);
  lfo.connect(depth);
  depth.connect(pan);
  return lfo;
}

/**
 * The pan path a voice moves on, in seconds from its start: its own
 * `panPath`, or, for a pan slide, a ramp from `panSlideFrom` to the voice's
 * pan (the centre without one) over `panSlideTime` (default: the voice's
 * attack). A path and a slide together keep the path, with a warning.
 */
export function voicePanPath(params: VoiceParams): PanPoint[] | undefined {
  const hasPath = params.panPath !== undefined && params.panPath.length > 0;
  const from = params.panSlideFrom;
  if (from === undefined || !Number.isFinite(from)) {
    return hasPath ? params.panPath : undefined;
  }
  if (hasPath) {
    warnOnce(
      'panslide-and-panpath',
      'undertone: panslide() and a pan path overlap — the path applies and the slide is ignored.'
    );
    return params.panPath;
  }
  const time = params.panSlideTime ?? params.attack;
  return [
    { time: 0, pan: from },
    { time: Number.isFinite(time) && time > 0 ? time : 0, pan: params.pan ?? 0 }
  ];
}
