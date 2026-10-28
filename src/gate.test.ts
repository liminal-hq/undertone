// Tests for the explicit gate (duration/legato), velocity, and cut-group controls
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, sound } from './control';
import { resolveParams, playVoice } from './engine';
import { stack } from './pattern';
import type { TimerLike } from './scheduler';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

class FakeTimer implements TimerLike {
  setInterval(): unknown {
    return 'interval-handle';
  }
  clearInterval(): void {}
}

function holdCalls(ctx: FakeAudioContext, index: number) {
  return ctx.gains[index].gain.calls.filter(
    (call) => call.method === 'setValueAtTime' && call.value > 0
  );
}

describe('duration()', () => {
  it('holds the envelope for the explicit gate, even in an ungated one-shot', () => {
    const ctx = new FakeAudioContext();

    note('c3').sustain(0.5).duration(1).play({ ctx, when: 0 });

    // Hold level 0.8 * 0.5 until t=1, then a 0.05s release.
    expect(ctx.gains[0].gain.calls.slice(-2)).toEqual([
      { method: 'setValueAtTime', value: expect.closeTo(0.4), time: 1 },
      { method: 'linearRampToValueAtTime', value: 0, time: expect.closeTo(1.05) }
    ]);
  });

  it('beats the event-length gate of a looped pattern', () => {
    const ctx = new FakeAudioContext();

    note('c3').sustain(0.5).duration(0.25).loop({ ctx, timer: new FakeTimer() });

    // Loop starts 0.1s after now; gate closes 0.25s after the voice starts.
    expect(holdCalls(ctx, 0)[0]).toEqual({
      method: 'setValueAtTime',
      value: expect.closeTo(0.4),
      time: expect.closeTo(0.35)
    });
  });

  it('rejects a negative duration', () => {
    expect(() => note('c3').duration(-1)).toThrow(/must not be negative/);
  });
});

describe('legato()', () => {
  it('scales the event length and gates a one-shot', () => {
    const ctx = new FakeAudioContext();

    note('c3 e3').sustain(0.5).legato(0.5).play({ ctx, when: 0 }); // 1s events at 120 bpm

    expect(holdCalls(ctx, 0)[0]).toMatchObject({ time: 0.5 });
    expect(holdCalls(ctx, 1)[0]).toMatchObject({ time: 1.5 });
  });

  it('does nothing extra without legato in an ungated one-shot', () => {
    const ctx = new FakeAudioContext();

    note('c3 e3').sustain(0.5).play({ ctx, when: 0 });

    expect(holdCalls(ctx, 0)).toEqual([]);
  });

  it('is overridden by an explicit duration', () => {
    const ctx = new FakeAudioContext();

    note('c3').sustain(0.5).legato(0.5).duration(0.2).play({ ctx, when: 0 });

    expect(holdCalls(ctx, 0)[0]).toMatchObject({ time: 0.2 });
  });

  it('can be patterned', () => {
    const ctx = new FakeAudioContext();

    note('c3 e3').sustain(0.5).legato('1 0.25').play({ ctx, when: 0 });

    expect(holdCalls(ctx, 0)[0]).toMatchObject({ time: 1 });
    expect(holdCalls(ctx, 1)[0]).toMatchObject({ time: 1.25 });
  });

  it('rejects a negative fraction', () => {
    expect(() => note('c3').legato(-0.1)).toThrow(/must not be negative/);
  });
});

describe('velocity()', () => {
  it('scales the carrier peak only, leaving the envelope shape alone', () => {
    const ctx = new FakeAudioContext();

    note('c3').gain(0.8).velocity(0.5).sustain(0.5).lpf(500).lpenv(1000).play({ ctx, when: 0 });

    expect(ctx.gains[0].gain.calls[1]).toEqual({
      method: 'linearRampToValueAtTime',
      value: expect.closeTo(0.4),
      time: expect.closeTo(0.01)
    });
    // Sustain stays a fraction of the (scaled) peak; the filter envelope is untouched.
    expect(ctx.gains[0].gain.calls[2]).toMatchObject({ value: expect.closeTo(0.2) });
    expect(ctx.filters[0].frequency.calls[1]).toMatchObject({ value: 1500 });
  });

  it('defaults to full strength and can be patterned per event', () => {
    const ctx = new FakeAudioContext();

    note('c3 c3').gain(1).velocity('1 0.25').play({ ctx, when: 0 });

    const peak = (i: number) =>
      ctx.gains[i].gain.calls.find((c) => c.method === 'linearRampToValueAtTime');
    expect(peak(0)).toMatchObject({ value: 1 });
    expect(peak(1)).toMatchObject({ value: 0.25 });
  });

  it('rejects a negative velocity', () => {
    expect(() => note('c3').velocity(-1)).toThrow(/must not be negative/);
  });
});

describe('cut()', () => {
  it('stops the previous voice in the group when the next one starts', () => {
    const ctx = new FakeAudioContext();

    note('c3 e3').release(2).cut(1).play({ ctx, when: 0 });

    const [first, second] = ctx.oscillators;
    expect(first.stopped).toHaveLength(2);
    expect(first.stopped.at(-1)).toBeCloseTo(1.005);
    expect(second.stopped).toHaveLength(1);
  });

  it('leaves other groups and ungrouped voices alone', () => {
    const ctx = new FakeAudioContext();

    stack(
      note('c3 ~').release(2).cut(1),
      note('~ e3').release(2).cut(2),
      note('~ g3').release(2)
    ).play({ ctx, when: 0 });

    expect(ctx.oscillators.every((osc) => osc.stopped.length === 1)).toBe(true);
  });

  it('shares a group across patterns on the same context and output', () => {
    const ctx = new FakeAudioContext();

    note('c3').release(2).cut(3).play({ ctx, when: 0 });
    note('e3').release(2).cut(3).play({ ctx, when: 0.5 });

    expect(ctx.oscillators[0].stopped.at(-1)).toBeCloseTo(0.505);
  });

  it('keeps groups separate per output and per context', () => {
    const ctx = new FakeAudioContext();
    const other = new FakeAudioContext();
    const outA = ctx.createGain();
    const outB = ctx.createGain();
    const params = resolveParams({ pitch: 'a4', release: 2, cutGroup: 1 });

    playVoice(ctx, params, 0, { output: outA });
    playVoice(ctx, params, 1, { output: outB });
    playVoice(other, params, 1);

    expect(ctx.oscillators[0].stopped).toHaveLength(1);
    expect(other.oscillators[0].stopped).toHaveLength(1);
  });

  it('does not let an earlier-starting voice choke a later one', () => {
    const ctx = new FakeAudioContext();
    const params = resolveParams({ pitch: 'a4', release: 2, cutGroup: 1 });

    playVoice(ctx, params, 2);
    playVoice(ctx, params, 1);

    expect(ctx.oscillators[0].stopped).toHaveLength(1);
  });

  it('works with unpitched sounds and rejects bad groups', () => {
    const ctx = new FakeAudioContext();

    sound('white white').release(2).cut(0).play({ ctx, when: 0 });

    expect(ctx.bufferSources[0].stopped).toHaveLength(2);
    expect(() => note('c3').cut(-1)).toThrow(/non-negative integer/);
    expect(() => note('c3').cut(1.5)).toThrow(/non-negative integer/);
  });
});
