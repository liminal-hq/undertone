// Shaped waveforms (half-sine, abs-sine, pulse-sine) as band-limited PeriodicWaves, cached per context
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioContextLike, PeriodicWaveLike, ShapedWaveType } from './types.js';
import { warnOnce } from './warn.js';

export const SHAPED_WAVE_TYPES: readonly ShapedWaveType[] = ['halfsine', 'abssine', 'pulsesine'];

export function isShapedWave(word: string): word is ShapedWaveType {
  return (SHAPED_WAVE_TYPES as readonly string[]).includes(word);
}

const HARMONICS = 64; // band limit: enough for the corners to stay sharp without ringing audibly at normal pitches
const ANALYSIS_SAMPLES = 4096; // points per period for the Fourier analysis

/** One period of each shape over theta in [0, 2π). */
function shape(type: ShapedWaveType, theta: number): number {
  const s = Math.sin(theta);
  switch (type) {
    case 'halfsine':
      return Math.max(s, 0); // the positive half of a sine, then silence
    case 'abssine':
      return Math.abs(s); // both halves positive: twice the pitch, a buzzier tone
    case 'pulsesine': {
      // The rising quarter of each half-cycle of |sine|, then silence: a pulsed sine.
      const withinHalf = theta % Math.PI;
      return withinHalf < Math.PI / 2 ? Math.abs(s) : 0;
    }
  }
}

interface WaveTable {
  real: Float32Array;
  imag: Float32Array;
}

const tables = new Map<ShapedWaveType, WaveTable>();

/**
 * Fourier coefficients of a shape (index 0, the DC term, is left at 0 because
 * Web Audio ignores it anyway — so a shaped wave never offsets the signal it
 * modulates). Independent of any context, so computed once and shared.
 */
export function shapedWaveTable(type: ShapedWaveType): WaveTable {
  let table = tables.get(type);
  if (table) {
    return table;
  }
  const real = new Float32Array(HARMONICS + 1);
  const imag = new Float32Array(HARMONICS + 1);
  const samples = new Float64Array(ANALYSIS_SAMPLES);
  for (let n = 0; n < ANALYSIS_SAMPLES; n++) {
    samples[n] = shape(type, (2 * Math.PI * n) / ANALYSIS_SAMPLES);
  }
  for (let k = 1; k <= HARMONICS; k++) {
    let cosSum = 0;
    let sinSum = 0;
    for (let n = 0; n < ANALYSIS_SAMPLES; n++) {
      const angle = (2 * Math.PI * k * n) / ANALYSIS_SAMPLES;
      cosSum += samples[n] * Math.cos(angle);
      sinSum += samples[n] * Math.sin(angle);
    }
    real[k] = (2 * cosSum) / ANALYSIS_SAMPLES;
    imag[k] = (2 * sinSum) / ANALYSIS_SAMPLES;
  }
  table = { real, imag };
  tables.set(type, table);
  return table;
}

const wavesByContext = new WeakMap<AudioContextLike, Map<ShapedWaveType, PeriodicWaveLike>>();

/**
 * The PeriodicWave for a shape on `ctx`, created once per context. Returns
 * undefined (warning once) on a context without createPeriodicWave, such as a
 * hand-written wrapper from before shaped waves — callers fall back to a sine.
 */
export function getShapedWave(
  ctx: AudioContextLike,
  type: ShapedWaveType
): PeriodicWaveLike | undefined {
  if (!ctx.createPeriodicWave) {
    warnOnce(
      'no-periodic-wave',
      `undertone: this audio context has no createPeriodicWave(), so "${type}" falls back to a sine.`
    );
    return undefined;
  }
  let waves = wavesByContext.get(ctx);
  if (!waves) {
    waves = new Map();
    wavesByContext.set(ctx, waves);
  }
  let wave = waves.get(type);
  if (!wave) {
    const { real, imag } = shapedWaveTable(type);
    wave = ctx.createPeriodicWave(real, imag);
    waves.set(type, wave);
  }
  return wave;
}
