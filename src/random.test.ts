// Tests for per-context seeded randomness used by noise and reverb generation
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextRandom, keyedRandom, seedContext } from './random';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

function draw(source: () => number, count = 4): number[] {
  return Array.from({ length: count }, () => source());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contextRandom', () => {
  it('returns Math.random for an unseeded context', () => {
    const ctx = new FakeAudioContext();
    expect(contextRandom(ctx, 'a')).toBe(Math.random);
    expect(keyedRandom(ctx, 'a')).toBe(Math.random);
  });

  it('repeats across contexts with the same seed and differs with another seed', () => {
    const a = new FakeAudioContext();
    const b = new FakeAudioContext();
    const c = new FakeAudioContext();
    seedContext(a, 7);
    seedContext(b, 7);
    seedContext(c, 8);
    expect(draw(contextRandom(a, 'k'))).toEqual(draw(contextRandom(b, 'k')));
    expect(draw(contextRandom(c, 'k'))).not.toEqual(draw(contextRandom(a, 'k')));
  });

  it('gives repeated calls with the same key different, deterministic data', () => {
    const a = new FakeAudioContext();
    const b = new FakeAudioContext();
    seedContext(a, 'x');
    seedContext(b, 'x');
    const first = draw(contextRandom(a, 'k'));
    const second = draw(contextRandom(a, 'k'));
    expect(second).not.toEqual(first);
    expect(draw(contextRandom(b, 'k'))).toEqual(first);
    expect(draw(contextRandom(b, 'k'))).toEqual(second);
  });
});

describe('keyedRandom', () => {
  it('yields the same sequence for the same key however often it is asked', () => {
    const ctx = new FakeAudioContext();
    seedContext(ctx, 3);
    expect(draw(keyedRandom(ctx, 'ir'))).toEqual(draw(keyedRandom(ctx, 'ir')));
    expect(draw(keyedRandom(ctx, 'ir2'))).not.toEqual(draw(keyedRandom(ctx, 'ir')));
  });
});
