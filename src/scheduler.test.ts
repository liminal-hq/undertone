// Unit tests for one-shot play() and the looping lookahead scheduler
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import { note, sound } from './control';
import { Fraction } from './fraction';
import { stack } from './pattern';
import { collectOnsets, cycleSecondsFor, resetTempo, setcpm } from './scheduler';
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

describe('setcpm', () => {
  afterEach(() => resetTempo());

  it('sets a default cycle length used by play()/loop() calls that omit bpm', () => {
    const ctx = new FakeAudioContext();
    setcpm(60); // 60 cycles/min = 1 cycle/sec
    note('c3 e3').play({ ctx, when: 0 });
    expect(ctx.oscillators.map((osc) => osc.started[0])).toEqual([0, 0.5]);
  });

  it('is overridden by an explicit bpm on the call', () => {
    const ctx = new FakeAudioContext();
    setcpm(60); // would otherwise give 1-second cycles
    note('c3 e3').play({ ctx, when: 0, bpm: 480 }); // 0.5-second cycles
    expect(ctx.oscillators.map((osc) => osc.started[0])).toEqual([0, 0.25]);
  });

  it('rejects a non-positive cpm', () => {
    expect(() => setcpm(0)).toThrow(/must be positive/);
    expect(() => setcpm(-5)).toThrow(/must be positive/);
  });
});

describe('a running loop and tempo changes', () => {
  afterEach(() => resetTempo());

  // Four onsets per cycle, so every cycle length gives distinct start times.
  const starts = (ctx: FakeAudioContext): number[] => ctx.oscillators.map((osc) => osc.started[0]);
  const run = (ctx: FakeAudioContext, timer: FakeTimer, until: number): void => {
    for (let t = ctx.currentTime; t <= until + 1e-9; t += 0.1) {
      ctx.currentTime = t;
      timer.tick();
    }
  };

  it('follows setcpm to a faster tempo with no gap or overlap', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    setcpm(30); // 2-second cycles, steps 0.5 s apart
    note('c3 e3 g3 b3').loop({ ctx, timer });
    run(ctx, timer, 1.0);
    setcpm(60); // 1-second cycles, steps 0.25 s apart
    run(ctx, timer, 3.0);

    const times = starts(ctx);
    const first = times.findIndex((time, i) => i > 0 && time - times[i - 1] < 0.4);
    expect(first).toBeGreaterThan(0);
    // Before the change the steps are 0.5 s apart, after it 0.25 s, and the
    // step that straddles the change keeps one of those two spacings.
    // The step straddling the change mixes the two tempos, so every gap lies
    // between the faster and the slower step: nothing doubled, nothing missing.
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      expect(gap).toBeGreaterThan(0.25 - 1e-9);
      expect(gap).toBeLessThan(0.5 + 1e-9);
    }
    expect(new Set(times.map((time) => time.toFixed(6))).size).toBe(times.length);
    expect(times[times.length - 1] - times[times.length - 2]).toBeCloseTo(0.25, 9);
  });

  it('follows setcpm to a slower tempo with no gap or overlap', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    setcpm(60);
    note('c3 e3 g3 b3').loop({ ctx, timer });
    run(ctx, timer, 1.0);
    setcpm(30);
    run(ctx, timer, 4.0);

    const times = starts(ctx);
    expect(new Set(times.map((time) => time.toFixed(6))).size).toBe(times.length);
    // The step straddling the change mixes the two tempos, so every gap lies
    // between the faster and the slower step: nothing doubled, nothing missing.
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      expect(gap).toBeGreaterThan(0.25 - 1e-9);
      expect(gap).toBeLessThan(0.5 + 1e-9);
    }
    expect(times[times.length - 1] - times[times.length - 2]).toBeCloseTo(0.5, 9);
  });

  it('keeps voices already booked at their times and continues from the end of them', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    setcpm(30); // 2-second cycles
    note('c3 e3').loop({ ctx, timer }); // onsets at 0.1 and 1.1, then 2.1, 3.1 ...
    ctx.currentTime = 0.85;
    timer.tick(); // books the onset at 1.1 (inside the lookahead)
    const booked = starts(ctx).slice();
    expect(booked).toEqual([0.1, 1.1]);

    setcpm(60); // 1-second cycles: onsets 0.5 s apart
    // The window booked so far ends at the grid point just under cycle 0.525
    // ((0.85 + 0.3 - 0.1) / 2), which is the anchor: audio 0.1 + 2 * anchor.
    const anchor = 5291 / 10080; // 0.525 * 10080 floors to 5291 in floating point
    const anchorTime = 0.1 + anchor * 2;
    ctx.currentTime = 1.9;
    timer.tick();
    ctx.currentTime = 2.9;
    timer.tick();
    const after = starts(ctx);
    expect(after.slice(0, 2)).toEqual(booked);
    // From the anchor on, one cycle lasts 1 s: pattern cycle 1 lands (1 - anchor)
    // seconds after it, and onsets then fall every 0.5 s, none doubled or missing.
    expect(after[2]).toBeCloseTo(anchorTime + (1 - anchor), 9);
    expect(after[3]).toBeCloseTo(anchorTime + (1.5 - anchor), 9);
  });

  it('handles a change between ticks and several changes in a row', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    setcpm(60);
    note('c3 e3 g3 b3').loop({ ctx, timer });
    run(ctx, timer, 0.5);
    setcpm(120);
    setcpm(15); // only the last value before the next tick counts
    run(ctx, timer, 4.0);

    const times = starts(ctx);
    expect(new Set(times.map((time) => time.toFixed(6))).size).toBe(times.length);
    expect(times[times.length - 1] - times[times.length - 2]).toBeCloseTo(1, 9); // 4-second cycles
  });

  it('follows resetTempo() back to the 120 bpm default', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    setcpm(60);
    note('c3 e3').loop({ ctx, timer });
    run(ctx, timer, 1.0);
    resetTempo(); // 2-second cycles, onsets 1 s apart
    run(ctx, timer, 5.0);

    const times = starts(ctx);
    expect(times[times.length - 1] - times[times.length - 2]).toBeCloseTo(1, 9);
    expect(new Set(times.map((time) => time.toFixed(6))).size).toBe(times.length);
  });

  it('keeps the tempo of a loop started with an explicit bpm or cps', () => {
    for (const explicit of [{ bpm: 120 }, { cps: 0.5 }]) {
      const ctx = new FakeAudioContext();
      const timer = new FakeTimer();
      note('c3 e3').loop({ ctx, timer, ...explicit });
      run(ctx, timer, 1.0);
      setcpm(600);
      run(ctx, timer, 5.0);
      expect(starts(ctx)).toEqual([0.1, 1.1, 2.1, 3.1, 4.1, 5.1].slice(0, starts(ctx).length));
      expect(starts(ctx).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('stops scheduling after stop() and releases the timer', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    setcpm(60);
    const handle = note('c3 e3').loop({ ctx, timer });
    run(ctx, timer, 1.0);
    handle.stop();
    expect(timer.cleared).toBe(true);
    expect(ctx.oscillators.length).toBeGreaterThan(0);
  });

  it('still rejects a non-positive setcpm at the call, leaving the loop on its tempo', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    setcpm(60);
    note('c3 e3').loop({ ctx, timer });
    expect(() => setcpm(0)).toThrow(/must be positive/);
    run(ctx, timer, 3.0);
    const times = starts(ctx);
    expect(times[times.length - 1] - times[times.length - 2]).toBeCloseTo(0.5, 9);
  });
});

describe('resetTempo', () => {
  it('restores the plain 120bpm (2-second cycle) default', () => {
    const ctx = new FakeAudioContext();
    setcpm(60);
    resetTempo();
    note('c3 e3').play({ ctx, when: 0 });
    expect(ctx.oscillators.map((osc) => osc.started[0])).toEqual([0, 1]);
  });
});

describe('collectOnsets', () => {
  const span = { begin: Fraction.from(0), end: Fraction.from(1) };

  it('returns each onset with its start time and gated duration, without touching a context', () => {
    const voices = collectOnsets(note('c3 e3'), span, 10, 2, true);
    expect(voices.map((v) => v.startTime)).toEqual([10, 11]);
    expect(voices.map((v) => v.params.duration)).toEqual([1, 1]);
  });

  it('leaves the duration unset for an ungated span and honours legato', () => {
    const plain = collectOnsets(note('c3 e3'), span, 0, 2, false);
    expect(plain.map((v) => v.params.duration)).toEqual([undefined, undefined]);
    const legato = collectOnsets(note('c3 e3').legato(0.5), span, 0, 2, false);
    expect(legato.map((v) => v.params.duration)).toEqual([0.5, 0.5]);
  });

  it('skips tails of events that began before the span', () => {
    const later = { begin: new Fraction(1, 2), end: Fraction.from(1) };
    const voices = collectOnsets(note('c3*1'), later, 0, 2, true);
    expect(voices).toEqual([]);
  });
});

describe('cycleSecondsFor', () => {
  afterEach(() => resetTempo());

  it('converts cps and bpm to seconds per cycle and rejects both together', () => {
    expect(cycleSecondsFor(undefined, 2)).toBe(0.5);
    expect(() => cycleSecondsFor(120, 1)).toThrow('either bpm or cps');
  });
});
