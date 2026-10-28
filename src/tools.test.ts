// Tests for the sound-writing tools: fmVoice, presets, layer, score, drift and the mono fold-down
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note } from './control';
import { drift } from './drift';
import { seededRandom } from './random';
import { Fraction } from './fraction';
import { fmPresets, fmVoice, layer } from './instruments';
import { createMonoFold } from './monoFold';
import { score } from './score';
import type { TimerLike } from './scheduler';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

class FakeTimer implements TimerLike {
  callback: (() => void) | undefined;
  setInterval(callback: () => void): unknown {
    this.callback = callback;
    return 'interval-handle';
  }
  clearInterval(): void {}
  tick(): void {
    this.callback?.();
  }
}

describe('fmVoice', () => {
  it('converts a Tone.js-shaped definition into plain Undertone controls', () => {
    const patch = fmVoice({
      harmonicity: 2,
      modulationIndex: 7,
      oscillator: { type: 'triangle' },
      modulation: { type: 'square' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3 },
      modulationEnvelope: { attack: 0.02, decay: 0.1, sustain: 0.25, release: 0.05 },
      level: 0.4,
      pan: -0.3
    });

    expect(patch).toEqual({
      soundType: 'triangle',
      attack: 0.01,
      decay: 0.2,
      sustain: 0.5,
      release: 0.3,
      gainLevel: 0.4,
      pan: -0.3,
      fmIndex: 3.5, // Tone's index is relative to the carrier, so 7 / harmonicity 2
      fmHarmonicity: 2,
      fmWave: 'square',
      fmAttack: 0.02,
      fmDecay: 0.1,
      fmSustain: 0.25,
      fmRelease: 0.05
    });
  });

  it('leaves FM out without a modulation index, and unset fields unset', () => {
    expect(fmVoice({ harmonicity: 3, envelope: { attack: 0.1 } })).toEqual({ attack: 0.1 });
    expect(fmVoice({})).toEqual({});
  });

  it('is JSON-safe and rejects bad values', () => {
    const patch = fmVoice({ harmonicity: 1.5, modulationIndex: 3 });

    expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);
    expect(() => fmVoice({ harmonicity: 0 })).toThrow(/harmonicity must be positive/);
    expect(() => fmVoice({ modulationIndex: -1 })).toThrow(/must not be negative/);
  });
});

describe('fmPresets and pattern.voice()', () => {
  it('are frozen plain data that turn a note pattern into an FM voice', () => {
    const ctx = new FakeAudioContext();

    note('e5').voice(fmPresets.glassBell).play({ ctx, when: 0 });

    expect(Object.isFrozen(fmPresets.glassBell)).toBe(true);
    expect(ctx.oscillators).toHaveLength(2); // carrier and modulator
    expect(ctx.oscillators[1].frequency.calls[0]).toMatchObject({
      value: expect.closeTo(659.255 * 3.5, 1)
    });
  });

  it('lets controls chained after voice() win', () => {
    const ctx = new FakeAudioContext();

    note('e5').voice(fmPresets.pluck).gain(0.9).play({ ctx, when: 0 });

    const peak = ctx.gains[0].gain.calls.find((c) => c.method === 'linearRampToValueAtTime');
    expect(peak).toMatchObject({ value: 0.9 });
  });

  it('every preset sounds as FM', () => {
    for (const patch of Object.values(fmPresets)) {
      expect(patch.fmIndex).toBeGreaterThan(0);
    }
  });
});

describe('layer', () => {
  it('stacks the voices with a start stagger, level balance and opposite pans', () => {
    const ctx = new FakeAudioContext();
    const layered = layer(note('a4'), [{ soundType: 'square' }, { soundType: 'triangle' }], {
      stagger: 0.002,
      levels: [1, 0.5],
      pans: [-0.4, 0.4]
    });

    layered.play({ ctx, when: 0 });

    expect(ctx.oscillators.map((o) => o.type)).toEqual(['square', 'triangle']);
    expect(ctx.oscillators.map((o) => o.started[0])).toEqual([0, 0.002]);
    expect(ctx.panners.map((p) => p.pan.calls[0].value)).toEqual([-0.4, 0.4]);
    const peaks = ctx.gains
      .filter((g) => g.gain.calls.some((c) => c.method === 'linearRampToValueAtTime'))
      .map((g) => g.gain.calls.find((c) => c.method === 'linearRampToValueAtTime')?.value);
    expect(peaks).toEqual([0.8, 0.4]);
  });

  it("keeps a layer's own pan when no pan is given, and rejects bad input", () => {
    const ctx = new FakeAudioContext();

    layer(note('a4'), [{ pan: 0.7 }]).play({ ctx, when: 0 });

    expect(ctx.panners[0].pan.calls[0].value).toBe(0.7);
    expect(() => layer(note('a4'), [])).toThrow(/at least one voice/);
    expect(() => layer(note('a4'), [{}], { stagger: -1 })).toThrow(/must not be negative/);
  });
});

describe('layer composes with the notes it layers', () => {
  it('adds the stagger to nudges the notes already carry, and keeps them when stagger is 0', () => {
    const ctx = new FakeAudioContext();
    const humanised = note('a4').nudge(0.01);

    layer(humanised, [{}, {}], { stagger: 0.002 }).play({ ctx, when: 0 });
    layer(humanised, [{}]).play({ ctx, when: 0 });

    expect(ctx.oscillators.map((o) => o.started[0])).toEqual([
      expect.closeTo(0.01, 10),
      expect.closeTo(0.012, 10),
      expect.closeTo(0.01, 10)
    ]);
  });

  it('keeps timing from drift() when wrapped around it', () => {
    const drifted = drift(note('a4'), { seed: 'x', timing: 0.02 });
    const expected = drifted.query({ begin: Fraction.from(0), end: Fraction.from(1) })[0].value
      .nudgeTime as number;
    const ctx = new FakeAudioContext();

    layer(drifted, [{ soundType: 'square' }]).play({ ctx, when: 1 });

    expect(ctx.oscillators[0].started[0]).toBeCloseTo(1 + expected, 10);
  });

  it("multiplies the notes' own velocity by the layer level", () => {
    const ctx = new FakeAudioContext();

    layer(note('a4 a4').velocity('1 0.25').gain(1), [{}, {}], { levels: [1, 0.5] }).play({
      ctx,
      when: 0
    });

    const peaks = ctx.gains.map(
      (g) => g.gain.calls.find((c) => c.method === 'linearRampToValueAtTime')?.value
    );
    // Playback order is layer by layer: layer 0 (x1), then layer 1 (x0.5).
    expect(peaks).toEqual([1, 0.25, 0.5, 0.125]);
  });

  it('lets a layer voice override the notes, but inherits what it does not set', () => {
    const ctx = new FakeAudioContext();

    layer(note('a4').sound('sawtooth'), [{ soundType: 'square' }, {}]).play({ ctx, when: 0 });

    expect(ctx.oscillators.map((o) => o.type)).toEqual(['square', 'sawtooth']);
  });
});

describe('score', () => {
  const cue = {
    ticksPerSecond: 560,
    lengthTicks: 1120,
    events: [
      { tick: 0, note: 'e4', gate: 112, level: 0.5, pan: -0.2, voice: { sustain: 0.5 } },
      { tick: 280, midi: 69, gate: 28 },
      { tick: 1100, note: 'g4', gate: 100 }
    ]
  } as const;

  it('reports the loop tempo and length from the tick rate', () => {
    const compiled = score(cue);

    expect(compiled.cps).toBe(0.5);
    expect(compiled.seconds).toBe(2);
  });

  it('places events at their exact tick times and carries gate, level and pan', () => {
    const ctx = new FakeAudioContext();

    score(cue).play({ ctx, when: 0 });

    expect(ctx.oscillators.map((o) => o.started[0])).toEqual([0, 0.5, 1100 / 560]);
    expect(ctx.oscillators[1].frequency.calls[0]).toMatchObject({ value: 440 });
    expect(ctx.panners[0].pan.calls[0].value).toBe(-0.2);
    // A gate of 112 ticks is 0.2s: the envelope holds at 0.8 x 0.5 (sustain) x 0.5 (level) until then.
    expect(ctx.gains[0].gain.calls).toContainEqual({
      method: 'setValueAtTime',
      value: expect.closeTo(0.2),
      time: expect.closeTo(0.2)
    });
  });

  it('does not snap events to a grid', () => {
    const ctx = new FakeAudioContext();

    score({
      ticksPerSecond: 560,
      lengthTicks: 560,
      events: [73, 148, 223, 444].map((tick) => ({ tick, note: 'a4' }))
    }).play({ ctx, when: 0 });

    expect(ctx.oscillators.map((o) => o.started[0])).toEqual(
      [73, 148, 223, 444].map((tick) => expect.closeTo(tick / 560, 10))
    );
  });

  it('cuts a held note at the seam by default, and rings past it with seam: ring', () => {
    const cutCtx = new FakeAudioContext();
    const ringCtx = new FakeAudioContext();
    const held = {
      ticksPerSecond: 560,
      lengthTicks: 1120,
      events: [{ tick: 1000, note: 'g4', gate: 200, voice: { sustain: 0.5 } }]
    };

    score(held).play({ ctx: cutCtx, when: 0 });
    score({ ...held, seam: 'ring' }).play({ ctx: ringCtx, when: 0 });

    const holdAt = (ctx: FakeAudioContext) =>
      ctx.gains[0].gain.calls.find((c) => c.method === 'setValueAtTime' && c.value > 0)?.time;
    expect(holdAt(cutCtx)).toBeCloseTo(1000 / 560 + 120 / 560, 6); // clipped to the 1120-tick seam
    expect(holdAt(ringCtx)).toBeCloseTo(1000 / 560 + 200 / 560, 6);
  });

  it('loops with the tail rest included, landing each pass exactly on the audio clock', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    const rest = { ticksPerSecond: 100, lengthTicks: 300, events: [{ tick: 0, note: 'a4' }] };

    score(rest).loop({ ctx, timer });
    ctx.currentTime = 2.9;
    timer.tick();
    ctx.currentTime = 5.9;
    timer.tick();

    // 3-second passes starting 0.1s after the loop was created.
    const starts = ctx.oscillators.map((o) => o.started[0]);
    expect(starts[0]).toBeCloseTo(0.1, 10);
    expect(starts[1]).toBeCloseTo(3.1, 10);
    expect(starts[2]).toBeCloseTo(6.1, 10);
  });

  it('answers queries across cycles and windows consistently', () => {
    const { pattern } = score(cue);

    const whole = pattern.query({ begin: new Fraction(0), end: new Fraction(2) });
    const halves = [
      ...pattern.query({ begin: new Fraction(0), end: new Fraction(1, 2) }),
      ...pattern.query({ begin: new Fraction(1, 2), end: new Fraction(2) })
    ];

    const onsets = (haps: typeof whole) =>
      haps
        .filter((h) => h.whole && h.whole.begin.eq(h.part.begin))
        .map((h) => h.whole!.begin.toNumber());
    expect(onsets(whole)).toEqual(onsets(halves));
    expect(onsets(whole)).toHaveLength(6);
  });

  it('rejects malformed scores', () => {
    const base = { ticksPerSecond: 560, lengthTicks: 100 };
    expect(() => score({ ...base, ticksPerSecond: 0, events: [] })).toThrow(/ticksPerSecond/);
    expect(() => score({ ...base, lengthTicks: 1.5, events: [] })).toThrow(/lengthTicks/);
    expect(() => score({ ...base, events: [{ tick: 100, note: 'a4' }] })).toThrow(
      /outside the cue/
    );
    expect(() => score({ ...base, events: [{ tick: 1.5, note: 'a4' }] })).toThrow(/event tick/);
    expect(() => score({ ...base, events: [{ tick: 0 }] })).toThrow(/needs a note or midi/);
    expect(() => score({ ...base, events: [{ tick: 0, note: 'a4', gate: 0 }] })).toThrow(/gate/);
  });
});

describe('seededRandom and drift', () => {
  it('repeats the same sequence for the same seed, differs for another, and stays in range', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom('other');

    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(seededRandom('same')()).toBe(seededRandom('same')());
  });

  const cycles = (pattern: ReturnType<typeof drift>, from: number, to: number) =>
    pattern
      .query({ begin: Fraction.from(from), end: Fraction.from(to) })
      .map((h) => ({ at: h.whole!.begin.toNumber(), ...h.value }));

  it('changes nothing when no range is set', () => {
    const base = note('a4 e4');
    expect(cycles(drift(base, { seed: 1 }), 0, 1)).toEqual(cycles(base as never, 0, 1));
  });

  it('is deterministic per seed, whatever the query windows', () => {
    const humanised = drift(note('a4 e4 g4 b4'), {
      seed: 7,
      timing: 0.01,
      level: 0.2,
      cents: 10,
      pan: 0.2
    });

    const whole = cycles(humanised, 0, 1);
    const pieces = [...cycles(humanised, 0, 0.5), ...cycles(humanised, 0.5, 1)];

    expect(pieces).toEqual(whole);
    expect(cycles(drift(note('a4 e4 g4 b4'), { seed: 8, timing: 0.01 }), 0, 1)).not.toEqual(
      cycles(drift(note('a4 e4 g4 b4'), { seed: 7, timing: 0.01 }), 0, 1)
    );
  });

  it('varies from pass to pass, the same way every time', () => {
    const humanised = drift(note('a4'), { seed: 'cue', timing: 0.01 });

    const pass0 = cycles(humanised, 0, 1)[0].nudgeTime;
    const pass1 = cycles(humanised, 1, 2)[0].nudgeTime;

    expect(pass0).not.toBe(pass1);
    expect(cycles(humanised, 1, 2)[0].nudgeTime).toBe(pass1);
  });

  it('keys each note by its position within the pass, so cyclesPerPass sets the pass length', () => {
    const perCycle = drift(note('a4'), { seed: 'cue', timing: 0.01 });
    const perTwo = drift(note('a4'), { seed: 'cue', timing: 0.01, cyclesPerPass: 2 });
    const nudgeAt = (p: typeof perTwo, cycle: number) => cycles(p, cycle, cycle + 1)[0].nudgeTime;

    // Cycle 0 is pass 0, position 0 either way.
    expect(nudgeAt(perTwo, 0)).toBe(nudgeAt(perCycle, 0));
    // Cycle 1 is pass 0, position 1 here, but pass 1, position 0 above.
    expect(nudgeAt(perTwo, 1)).not.toBe(nudgeAt(perCycle, 1));
    // Cycle 2 repeats cycle 0's position in the next pass, which differs but is stable.
    expect(nudgeAt(perTwo, 2)).not.toBe(nudgeAt(perTwo, 0));
    expect(nudgeAt(perTwo, 2)).toBe(nudgeAt(perTwo, 2));
  });

  it('keeps each drift within its range', () => {
    const humanised = drift(note('a4*16').velocity(0.8).pan(0.9), {
      seed: 3,
      timing: 0.01,
      level: 0.1,
      cents: 20,
      pan: 0.3,
      push: 0.05
    });

    for (const event of cycles(humanised, 0, 4)) {
      expect(event.nudgeTime!).toBeGreaterThanOrEqual(0.04);
      expect(event.nudgeTime!).toBeLessThanOrEqual(0.06);
      expect(event.velocity!).toBeGreaterThanOrEqual(0.72);
      expect(event.velocity!).toBeLessThanOrEqual(0.88);
      expect(event.pan!).toBeLessThanOrEqual(1);
      const cents = 1200 * Math.log2((event.pitch as number) / 440);
      expect(Math.abs(cents)).toBeLessThanOrEqual(20);
    }
  });

  it('rejects bad options', () => {
    expect(() => drift(note('a4'), { seed: 1, timing: -1 })).toThrow(/timing must not be negative/);
    expect(() => drift(note('a4'), { seed: 1, cyclesPerPass: 0 })).toThrow(/cyclesPerPass/);
  });
});

describe('createMonoFold', () => {
  it('is a one-channel explicit gain connected to the output', () => {
    const ctx = new FakeAudioContext();

    const fold = createMonoFold(ctx);

    expect(fold.channelCount).toBe(1);
    expect(fold.channelCountMode).toBe('explicit');
    expect(fold.connectedTo).toEqual([ctx.destination]);
  });

  it('can sit in front of a custom output and take a stereo mix', () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();

    const fold = createMonoFold(ctx, out);
    note('a4').pan(-1).play({ ctx, when: 0, output: fold });

    expect(fold.connectedTo).toEqual([out]);
    expect(ctx.panners[0].connectedTo).toEqual([fold]);
  });
});
