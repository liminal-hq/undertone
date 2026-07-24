// Unit tests for 7.1 speaker-ring placement, stereo fold-down, and destination setup
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { CHANNEL_ORDER, enableMultichannel, foldToStereo, surroundGains } from './surround';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

// Channel indices for readability: FL FR C LFE SL SR RL RR
const [FL, FR, C, LFE, SL, SR, RL, RR] = [0, 1, 2, 3, 4, 5, 6, 7];

describe('surroundGains', () => {
  it('hits single speakers exactly at their ring angles', () => {
    expect(surroundGains(0)[C]).toBe(1);
    expect(surroundGains(-30)[FL]).toBe(1);
    expect(surroundGains(30)[FR]).toBe(1);
    expect(surroundGains(90)[SR]).toBe(1);
    expect(surroundGains(-90)[SL]).toBe(1);
    expect(surroundGains(150)[RR]).toBe(1);
    expect(surroundGains(-150)[RL]).toBe(1);
  });

  it('splits equal-power between the two nearest speakers', () => {
    const gains = surroundGains(15); // midway between C (0) and FR (30)
    expect(gains[C]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(gains[FR]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(gains.filter((g) => g > 0)).toHaveLength(2);
  });

  it('handles the wraparound pair dead-behind', () => {
    const gains = surroundGains(180);
    expect(gains[RR]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(gains[RL]).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('normalizes any angle onto the ring', () => {
    expect(surroundGains(390)).toEqual(surroundGains(30));
    expect(surroundGains(-330)).toEqual(surroundGains(30));
  });

  it('never routes to the LFE channel', () => {
    for (let angle = -180; angle <= 180; angle += 5) {
      expect(surroundGains(angle)[LFE]).toBe(0);
    }
  });

  it('conserves power everywhere on the ring', () => {
    for (let angle = -180; angle <= 180; angle += 7) {
      const power = surroundGains(angle).reduce((sum, g) => sum + g * g, 0);
      expect(power).toBeCloseTo(1, 10);
    }
  });

  it('rejects non-finite angles', () => {
    expect(() => surroundGains(Number.NaN)).toThrow(/finite/);
  });
});

describe('foldToStereo', () => {
  it('passes plain stereo through', () => {
    expect(foldToStereo([0.3, 0.7])).toEqual([0.3, 0.7]);
  });

  it('folds centre, LFE, sides, and rears into both/left/right appropriately', () => {
    const gains = new Array<number>(CHANNEL_ORDER.length).fill(0);
    gains[C] = 1;
    expect(foldToStereo(gains)[0]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(foldToStereo(gains)[1]).toBeCloseTo(Math.SQRT1_2, 10);

    const rearLeft = new Array<number>(CHANNEL_ORDER.length).fill(0);
    rearLeft[RL] = 1;
    expect(foldToStereo(rearLeft)[0]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(foldToStereo(rearLeft)[1]).toBe(0);
  });
});

describe('enableMultichannel', () => {
  it('claims the full hardware channel count with discrete interpretation', () => {
    const ctx = new FakeAudioContext();
    ctx.destination.maxChannelCount = 8;

    expect(enableMultichannel(ctx)).toBe(8);
    expect(ctx.destination.channelCount).toBe(8);
    expect(ctx.destination.channelInterpretation).toBe('discrete');
  });

  it('leaves plain stereo destinations untouched', () => {
    const ctx = new FakeAudioContext();

    expect(enableMultichannel(ctx)).toBe(2);
    expect(ctx.destination.channelCount).toBe(2);
    expect(ctx.destination.channelInterpretation).toBe('speakers');
  });
});
