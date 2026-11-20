// Tests that a failed play() or first loop window leaves nothing sounding, whatever Web Audio call failed during the replay
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSamples, note, resetTempo } from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';
import { FakeAudioContext } from '../../../src/test-utils/fakeAudioContext';

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
  resetTempo();
  clearSamples();
});

/** A timer ticked by hand, which also counts what is left running. */
function manualTimer() {
  let callback: (() => void) | undefined;
  const counts = { set: 0, cleared: 0 };
  return {
    counts,
    timer: {
      setInterval: (fn: () => void) => {
        callback = fn;
        counts.set += 1;
        return 1;
      },
      clearInterval: () => {
        counts.cleared += 1;
        callback = undefined;
      }
    },
    tick: () => callback?.()
  };
}

/** Makes the `nth` (1-based) `createOscillator()` throw and the others work. */
function failNthOscillator(ctx: FakeAudioContext, nth: number): void {
  const createOscillator = ctx.createOscillator.bind(ctx);
  let made = 0;
  vi.spyOn(ctx, 'createOscillator').mockImplementation(() => {
    made += 1;
    if (made === nth) throw new Error(`oscillator ${nth} failed`);
    return createOscillator();
  });
}

/** Nothing the context made is left to sound: each source is cut at once, or never started, and cut off from its chain. */
function expectSilent(ctx: FakeAudioContext): void {
  for (const osc of ctx.oscillators) {
    expect(osc.disconnectCount).toBeGreaterThan(0);
    if (osc.started.length > 0) expect(osc.stopped.at(-1)).toBeLessThanOrEqual(ctx.currentTime);
  }
}

describe.each([1, 2, 3])('a Web Audio call that fails creating oscillator %i of 3', (nth) => {
  it('leaves nothing sounding after a failed play(), and throws the failure', () => {
    const ctx = new FakeAudioContext();
    failNthOscillator(ctx, nth);
    expect(() => note('a4 b4 c5').play({ ctx, bpm: 120 })).toThrow(`oscillator ${nth} failed`);
    expect(ctx.oscillators).toHaveLength(2);
    expectSilent(ctx);
  });

  it('leaves nothing sounding after a failed first loop window, and starts no timer', () => {
    const ctx = new FakeAudioContext();
    const { timer, counts, tick } = manualTimer();
    failNthOscillator(ctx, nth);
    expect(() => note('a4 b4 c5').loop({ ctx, timer, bpm: 1200 })).toThrow(
      `oscillator ${nth} failed`
    );
    expect(ctx.oscillators).toHaveLength(2);
    expectSilent(ctx);
    expect(counts.set).toBe(0);
    ctx.currentTime = 1;
    tick(); // nothing is running, so nothing is booked
    expect(ctx.oscillators).toHaveLength(2);
  });
});

describe('a later tick of a running loop', () => {
  it('keeps replaying the rest of the batch and keeps what the earlier windows booked', () => {
    const ctx = new FakeAudioContext();
    const { timer, tick } = manualTimer();
    const looping = note('a4 b4 c5').loop({ ctx, timer, bpm: 1200 });
    const healthy = ctx.oscillators.length;
    expect(healthy).toBeGreaterThanOrEqual(3);
    const createOscillator = ctx.createOscillator.bind(ctx);
    let made = 0;
    vi.spyOn(ctx, 'createOscillator').mockImplementation(() => {
      made += 1;
      if (made === 1) throw new Error('a later window failed');
      return createOscillator();
    });
    ctx.currentTime = 1;
    expect(() => tick()).toThrow('a later window failed');
    expect(ctx.oscillators.length).toBeGreaterThan(healthy + 1); // the rest of the batch was booked
    for (const osc of ctx.oscillators.slice(0, healthy)) expect(osc.disconnectCount).toBe(0);
    looping.stop({ voices: 'cut' });
  });
});
