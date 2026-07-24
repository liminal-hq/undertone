// Unit tests for stack()/SoundEffect.play() scheduling
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, sound, stack } from './index';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

describe('stack / SoundEffect', () => {
  it('plays every voice against the passed context, starting at ctx.currentTime by default', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 3;

    stack(note('c2'), sound('white')).play(ctx);

    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.bufferSources).toHaveLength(1);
    expect(ctx.oscillators[0].started).toEqual([3]);
  });

  it('honours an explicit `when` over ctx.currentTime', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 3;

    stack(note('c2')).play(ctx, 10);

    expect(ctx.oscillators[0].started).toEqual([10]);
  });

  it("respects each voice's own nudge() on top of the shared start time", () => {
    const ctx = new FakeAudioContext();
    stack(note('c2'), note('c6').nudge(0.02)).play(ctx, 5);

    expect(ctx.oscillators[0].started).toEqual([5]);
    expect(ctx.oscillators[1].started).toEqual([5.02]);
  });
});
