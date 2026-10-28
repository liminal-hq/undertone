// Unit tests for noise buffer generation
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { playVoice, resolveParams } from './engine';
import { buildNoiseBuffer } from './noise';
import { contextRandom, seedContext } from './random';
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

describe('buildNoiseBuffer random source', () => {
  it('uses Math.random when no source is given', () => {
    const spy = vi.spyOn(Math, 'random');
    buildNoiseBuffer(new FakeAudioContext(), 'white', 0.01);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each(['white', 'pink', 'brown'] as const)(
    'is identical for the same seed and differs for another (%s)',
    (type) => {
      const make = (seed: number) => {
        const ctx = new FakeAudioContext();
        seedContext(ctx, seed);
        return Array.from(
          buildNoiseBuffer(ctx, type, 0.01, contextRandom(ctx, 'n')).getChannelData(0)
        );
      };
      expect(make(1)).toEqual(make(1));
      expect(make(2)).not.toEqual(make(1));
    }
  );
});

describe('seeded noise voices', () => {
  it('gives two same-onset white-noise voices different buffers, reproducibly', () => {
    const play = () => {
      const ctx = new FakeAudioContext();
      seedContext(ctx, 9);
      playVoice(ctx, resolveParams({ soundType: 'white' }), 0);
      playVoice(ctx, resolveParams({ soundType: 'white' }), 0);
      return ctx.bufferSources.map((s) => Array.from(s.buffer!.getChannelData(0)));
    };
    const [a, b] = play();
    expect(a).not.toEqual(b);
    expect(play()).toEqual([a, b]);
  });
});
