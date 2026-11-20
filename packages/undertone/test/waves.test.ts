// Tests for shaped waveforms: Fourier tables, per-context caching, and use as carrier and FM modulator (ported from src/waves.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isShapedWave, note, s, sound } from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';
import { FakeAudioContext } from '../../../src/test-utils/fakeAudioContext';

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
});

describe('shaped waves as sound types', () => {
  it('are recognised sound types and not read as sample names', () => {
    expect(isShapedWave('halfsine')).toBe(true);
    expect(isShapedWave('sine')).toBe(false);
    // The isSoundType assertion is a Rust unit test now (M1: the symbol is not exported).

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
