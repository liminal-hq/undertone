// Unit tests for noise buffer generation
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildNoiseBuffer } from './noise';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

describe('buildNoiseBuffer', () => {
  it('generates a buffer of the requested duration at the context sample rate', () => {
    const ctx = new FakeAudioContext();
    const buffer = buildNoiseBuffer(ctx, 'white', 0.5);
    expect(buffer.getChannelData(0)).toHaveLength(Math.round(ctx.sampleRate * 0.5));
  });

  it.each(['white', 'pink', 'brown'] as const)(
    'keeps %s noise within a sane amplitude range',
    (type) => {
      const ctx = new FakeAudioContext();
      const data = buildNoiseBuffer(ctx, type, 0.2).getChannelData(0);
      for (const sample of data) {
        expect(sample).toBeGreaterThanOrEqual(-1.5);
        expect(sample).toBeLessThanOrEqual(1.5);
      }
    }
  );

  it('white noise is not constant (actually random, not a silent/DC buffer)', () => {
    const ctx = new FakeAudioContext();
    const data = buildNoiseBuffer(ctx, 'white', 0.1).getChannelData(0);
    const distinctValues = new Set(data);
    expect(distinctValues.size).toBeGreaterThan(1);
  });
});
