// Unit tests for seeded noise voices (ported from src/noise.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { resolveParams } from '@liminal-hq/undertone';
import { playVoice, seedContext } from '@liminal-hq/undertone/testing';
import { FakeAudioContext } from '../../../src/test-utils/fakeAudioContext';

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
