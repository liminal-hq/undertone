// Unit tests for one-shot play() and the looping lookahead scheduler
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, sound } from './control';
import { stack } from './pattern';
import type { TimerLike } from './scheduler';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

class FakeTimer implements TimerLike {
  callback: (() => void) | undefined;
  intervalMs: number | undefined;
  cleared = false;

  setInterval(callback: () => void, ms: number): unknown {
    this.callback = callback;
    this.intervalMs = ms;
    return 'interval-handle';
  }

  clearInterval(handle: unknown): void {
    if (handle === 'interval-handle') {
      this.cleared = true;
    }
  }

  tick(): void {
    this.callback?.();
  }
}

describe('play', () => {
  it('schedules one cycle of onsets against the passed context, starting at currentTime', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 3;

    note('c3 e3').play({ ctx }); // default 120 bpm -> 2-second cycles

    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.oscillators[0].started).toEqual([3]);
    expect(ctx.oscillators[1].started).toEqual([4]);
  });

  it('honours an explicit `when` and bpm', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 3;

    note('c3 e3 g3 b3').play({ ctx, when: 10, bpm: 240 }); // 1-second cycles

    expect(ctx.oscillators.map((osc) => osc.started[0])).toEqual([10, 10.25, 10.5, 10.75]);
  });

  it('plays chords and stacked layers polyphonically', () => {
    const ctx = new FakeAudioContext();

    stack(note('[c3,e3,g3]'), sound('white')).play({ ctx, when: 0 });

    expect(ctx.oscillators).toHaveLength(3);
    expect(ctx.bufferSources).toHaveLength(1);
    expect(ctx.oscillators.every((osc) => osc.started[0] === 0)).toBe(true);
  });

  it("respects each event's nudge on top of the shared start time", () => {
    const ctx = new FakeAudioContext();

    stack(note('c2'), note('c6').nudge(0.02)).play({ ctx, when: 5 });

    expect(ctx.oscillators[0].started).toEqual([5]);
    expect(ctx.oscillators[1].started).toEqual([5.02]);
  });

  it('stays percussive (ungated) so one-shots sound exactly like 0.1.x', () => {
    const ctx = new FakeAudioContext();

    note('c3').sustain(0.5).play({ ctx, when: 0 });

    // set 0, ramp to peak, ramp to sustain, ramp to 0 — no gate-hold call.
    expect(ctx.gains[0].gain.calls).toHaveLength(4);
    expect(ctx.gains[0].gain.calls.filter((c) => c.method === 'setValueAtTime')).toHaveLength(1);
  });

  it('does not re-trigger events whose tails cross into the cycle (slow patterns)', () => {
    const ctx = new FakeAudioContext();

    note('c3').slow(2).play({ ctx, when: 0 });

    expect(ctx.oscillators).toHaveLength(1);
  });

  it('rejects a non-positive bpm', () => {
    const ctx = new FakeAudioContext();
    expect(() => note('c3').play({ ctx, bpm: 0 })).toThrow(/bpm must be positive/);
  });

  it('holds each event for its own share of the cycle when gated, like loop()', () => {
    const ctx = new FakeAudioContext();

    // 240 bpm -> 1-second cycle; two events -> 0.5-second gates. With sustain
    // 0.5 the envelope holds at 0.4 (0.8 default gain * 0.5) until gate close.
    note('c3 e3').sustain(0.5).play({ ctx, when: 0, bpm: 240, gated: true });

    expect(ctx.gains[0].gain.calls).toContainEqual({
      method: 'setValueAtTime',
      value: 0.4,
      time: 0.5
    });
  });
});

describe('loop', () => {
  it('schedules the lookahead window immediately, then extends it as the clock advances', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();

    note('c3').loop({ ctx, timer, bpm: 240 }); // 1-second cycles

    // First tick covers the lookahead window: just the cycle-0 onset, placed
    // 100ms out so its attack isn't already in the past.
    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.oscillators[0].started).toEqual([0.1]);
    expect(timer.intervalMs).toBe(100);

    // Clock advances past cycle 1's onset minus lookahead: cycle 1 gets scheduled.
    ctx.currentTime = 1.0;
    timer.tick();
    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.oscillators[1].started).toEqual([1.1]);
  });

  it("gates each looped voice with its event's share of the cycle", () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();

    // 240 bpm -> 1-second cycles; two events -> 0.5-second gates. With sustain
    // 0.5 the envelope holds at 0.4 (0.8 default gain * 0.5) until gate close.
    note('c3 e3').sustain(0.5).loop({ ctx, timer, bpm: 240 });

    expect(ctx.gains[0].gain.calls).toContainEqual({
      method: 'setValueAtTime',
      value: 0.4,
      time: 0.6 // 0.1s start latency + 0.5s gate
    });
  });

  it('never schedules the same onset twice', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();

    note('c3').loop({ ctx, timer, bpm: 240 });
    timer.tick();
    timer.tick();

    expect(ctx.oscillators).toHaveLength(1);
  });

  it('keeps exact time across many cycles', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();

    note('c3 e3 g3').loop({ ctx, timer, bpm: 240 }); // triplet over 1-second cycles

    for (let step = 0; step < 100; step++) {
      ctx.currentTime = step * 0.1;
      timer.tick();
    }

    // ~10 seconds covered -> 10 cycles x 3 onsets, each at an exact third
    // past the 0.1s start latency.
    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(30);
    const started = ctx.oscillators.map((osc) => osc.started[0]);
    expect(started[4]).toBeCloseTo(0.1 + 1 + 1 / 3, 10);
    expect(started[28]).toBeCloseTo(0.1 + 9 + 1 / 3, 10);
  });

  it('stops scheduling when the handle is stopped', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();

    const handle = note('c3').loop({ ctx, timer, bpm: 240 });
    handle.stop();

    expect(timer.cleared).toBe(true);
  });

  it('alternation patterns unfold across looped cycles', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();

    note('<220 440>').loop({ ctx, timer, bpm: 240 });
    ctx.currentTime = 1.0;
    timer.tick();

    expect(ctx.oscillators[0].frequency.calls[0].value).toBe(220);
    expect(ctx.oscillators[1].frequency.calls[0].value).toBe(440);
  });
});
