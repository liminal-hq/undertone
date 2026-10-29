// Tests for shaped waveforms: Fourier tables, per-context caching, and use as carrier and FM modulator
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, s, sound } from './control';
import { FakeAudioContext } from './test-utils/fakeAudioContext';
import { isSoundType } from './types';
import { getShapedWave, isShapedWave, shapedWaveTable } from './waves';
import { resetWarnings } from './warn';

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
});

describe('shapedWaveTable', () => {
  it('matches the analytic series of a half-sine', () => {
    const { real, imag } = shapedWaveTable('halfsine');

    expect(imag[1]).toBeCloseTo(0.5, 4);
    expect(real[1]).toBeCloseTo(0, 4);
    expect(real[2]).toBeCloseTo(-2 / (3 * Math.PI), 4);
    expect(real[4]).toBeCloseTo(-2 / (15 * Math.PI), 4);
    expect(imag[3]).toBeCloseTo(0, 4); // no odd harmonics past the fundamental
    expect(real[0]).toBe(0); // the DC term is left out
  });

  it('matches the analytic series of an absolute sine, which has only even harmonics', () => {
    const { real, imag } = shapedWaveTable('abssine');

    expect(imag[1]).toBeCloseTo(0, 4);
    expect(real[1]).toBeCloseTo(0, 4);
    expect(real[2]).toBeCloseTo(-4 / (3 * Math.PI), 4);
    expect(real[4]).toBeCloseTo(-4 / (15 * Math.PI), 4);
  });

  it('reconstructs a pulsed sine: its pulse where it is on, silence where it is off', () => {
    const { real, imag } = shapedWaveTable('pulsesine');
    const dc = 1 / Math.PI; // the mean the table omits
    const at = (theta: number) =>
      real.reduce((sum, a, k) => sum + a * Math.cos(k * theta) + imag[k] * Math.sin(k * theta), 0);

    expect(at(Math.PI / 4) + dc).toBeCloseTo(Math.SQRT1_2, 1);
    expect(at((3 * Math.PI) / 4) + dc).toBeCloseTo(0, 1);
    expect(at((5 * Math.PI) / 4) + dc).toBeCloseTo(Math.SQRT1_2, 1);
    expect(Math.max(...real.map(Math.abs), ...imag.map(Math.abs))).toBeLessThan(1);
  });

  it('is computed once and shared', () => {
    expect(shapedWaveTable('halfsine')).toBe(shapedWaveTable('halfsine'));
  });
});

describe('getShapedWave', () => {
  it('creates one wave per shape per context and reuses it', () => {
    const ctx = new FakeAudioContext();
    const other = new FakeAudioContext();

    const first = getShapedWave(ctx, 'abssine');
    expect(getShapedWave(ctx, 'abssine')).toBe(first);
    getShapedWave(ctx, 'halfsine');
    getShapedWave(other, 'abssine');

    expect(ctx.periodicWaves).toHaveLength(2);
    expect(other.periodicWaves).toHaveLength(1);
    expect(ctx.periodicWaves[0].real).toBe(shapedWaveTable('abssine').real);
  });

  it('returns undefined, warning once, on a context without createPeriodicWave', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeAudioContext({ noPeriodicWave: true });

    expect(getShapedWave(ctx, 'halfsine')).toBeUndefined();
    expect(getShapedWave(ctx, 'abssine')).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('shaped waves as sound types', () => {
  it('are recognised sound types and not read as sample names', () => {
    expect(isShapedWave('halfsine')).toBe(true);
    expect(isShapedWave('sine')).toBe(false);
    expect(isSoundType('pulsesine')).toBe(true);

    const ctx = new FakeAudioContext();
    s('abssine').play({ ctx, when: 0 });

    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.oscillators[0].periodicWave).toBeDefined();
  });

  it('set a periodic wave on the carrier, shared between notes', () => {
    const ctx = new FakeAudioContext();

    note('a3 a4').sound('halfsine').play({ ctx, when: 0 });

    expect(ctx.oscillators.map((o) => o.type)).toEqual(['custom', 'custom']);
    expect(ctx.periodicWaves).toHaveLength(1);
    expect(ctx.oscillators[0].periodicWave).toBe(ctx.oscillators[1].periodicWave);
  });

  it('are not valid for noise-only entry points that reject unknown words', () => {
    expect(() => sound('triangle halfsine')).not.toThrow();
    expect(() => sound('halfsin')).toThrow(/Invalid sound type/);
  });

  it('fall back to a sine on a context without periodic waves', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeAudioContext({ noPeriodicWave: true });

    note('a4').sound('halfsine').play({ ctx, when: 0 });

    expect(ctx.oscillators[0].type).toBe('sine');
    expect(ctx.oscillators[0].periodicWave).toBeUndefined();
  });
});

describe('shaped waves as FM modulators', () => {
  it('give the modulator a periodic wave while the carrier keeps its native type', () => {
    const ctx = new FakeAudioContext();

    note('a4').sound('triangle').fm(2).fmwave('pulsesine').play({ ctx, when: 0 });

    const [carrier, modulator] = ctx.oscillators;
    expect(carrier.type).toBe('triangle');
    expect(modulator.type).toBe('custom');
    expect(modulator.periodicWave).toBe(ctx.periodicWaves[0]);
  });

  it('can use shaped waves for both carrier and modulator with one wave per shape', () => {
    const ctx = new FakeAudioContext();

    note('a4').sound('abssine').fm(1).fmwave('abssine').play({ ctx, when: 0 });

    expect(ctx.periodicWaves).toHaveLength(1);
  });

  it('accepts the new names and still rejects others', () => {
    expect(() => note('a4').fmwave('halfsine')).not.toThrow();
    expect(() => note('a4').fmwave('white' as never)).toThrow(/must be one of/);
  });
});
