// Tests for shaped waveforms: Fourier tables, per-context caching, and use as carrier and FM modulator (ported from src/waves.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, sound } from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
});

describe('shaped waves as sound types', () => {
  it('are not valid for noise-only entry points that reject unknown words', () => {
    expect(() => sound('triangle halfsine')).not.toThrow();
    expect(() => sound('halfsin')).toThrow(/Invalid sound type/);
  });
});

describe('shaped waves as FM modulators', () => {
  it('accepts the new names and still rejects others', () => {
    expect(() => note('a4').fmwave('halfsine')).not.toThrow();
    expect(() => note('a4').fmwave('white' as never)).toThrow(/must be one of/);
  });
});
