// Tests for slide, pitch-envelope and stepped pitch-curve automation
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, sound } from './control';
import { playVoice, resolveParams } from './engine';
import { buildPitchCurve } from './pitchCurve';
import { FakeAudioContext } from './test-utils/fakeAudioContext';
import { resetWarnings } from './warn';

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
});

function frequencyCalls(ctx: FakeAudioContext, index = 0) {
  return ctx.oscillators[index].frequency.calls;
}

describe('buildPitchCurve', () => {
  it('is a single jump to the note when nothing is set', () => {
    expect(buildPitchCurve(resolveParams({}), 2)).toEqual([{ kind: 'set', ratio: 1, time: 2 }]);
  });

  it('reproduces the slide as an octave-above start and an exponential ramp down', () => {
    expect(buildPitchCurve(resolveParams({ slideTime: 0.07 }), 1)).toEqual([
      { kind: 'set', ratio: 2, time: 1 },
      { kind: 'ramp', ratio: 1, time: 1.07 }
    ]);
  });
});

describe('penv()', () => {
  it('starts below the note and rises to it', () => {
    const ctx = new FakeAudioContext();

    note('a4').penv(-12).pdecay(0.2).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx)).toEqual([
      { method: 'setValueAtTime', value: 220, time: 0 },
      { method: 'exponentialRampToValueAtTime', value: 440, time: 0.2 }
    ]);
  });

  it('starts above the note and falls to it, with a default decay of 0.1s', () => {
    const ctx = new FakeAudioContext();

    note('a4').penv(12).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx)).toEqual([
      { method: 'setValueAtTime', value: 880, time: 0 },
      { method: 'exponentialRampToValueAtTime', value: 440, time: 0.1 }
    ]);
  });

  it('sweeps up to the offset over the attack, then back down over the decay', () => {
    const ctx = new FakeAudioContext();

    note('a4').penv(7).pattack(0.05).pdecay(0.1).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx)).toEqual([
      { method: 'setValueAtTime', value: 440, time: 0 },
      {
        method: 'exponentialRampToValueAtTime',
        value: expect.closeTo(440 * 2 ** (7 / 12)),
        time: 0.05
      },
      { method: 'exponentialRampToValueAtTime', value: 440, time: expect.closeTo(0.15) }
    ]);
  });

  it('snaps back at once when the decay is 0', () => {
    const ctx = new FakeAudioContext();

    note('a4').penv(12).pdecay(0).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx)).toEqual([
      { method: 'setValueAtTime', value: 880, time: 0 },
      { method: 'setValueAtTime', value: 440, time: 0 }
    ]);
  });

  it('can be patterned per event', () => {
    const ctx = new FakeAudioContext();

    note('a4 a4').penv('12 -12').pdecay(0.1).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx, 0)[0]).toMatchObject({ value: 880 });
    expect(frequencyCalls(ctx, 1)[0]).toMatchObject({ value: 220 });
  });

  it('is ignored by noise voices', () => {
    const ctx = new FakeAudioContext();

    sound('white').penv(12).play({ ctx, when: 0 });

    expect(ctx.oscillators).toHaveLength(0);
  });
});

describe('pitchsteps()', () => {
  it('jumps to each offset at the given frame rate and holds the last', () => {
    const ctx = new FakeAudioContext();

    note('a4').pitchsteps([0, 12, -12], 100).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx)).toEqual([
      { method: 'setValueAtTime', value: 440, time: 0 },
      { method: 'setValueAtTime', value: 880, time: 0.01 },
      { method: 'setValueAtTime', value: 220, time: 0.02 }
    ]);
  });

  it('defaults to 140 frames per second', () => {
    const ctx = new FakeAudioContext();

    note('a4').pitchsteps([0, 7, 0, 7]).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx).map((call) => call.time)).toEqual([0, 1 / 140, 2 / 140, 3 / 140]);
  });

  it('starts each event at its own onset', () => {
    const ctx = new FakeAudioContext();

    note('a4 a4').pitchsteps([0, 12], 100).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx, 1)[0]).toMatchObject({ time: 1 });
    expect(frequencyCalls(ctx, 1)[1]).toMatchObject({ time: 1.01 });
  });

  it('is plain data that survives JSON, and rejects bad input', () => {
    const steps = [0, 5, 0];
    const params = resolveParams({ pitch: 'a4', pitchSteps: steps, pitchStepRate: 50 });
    const ctx = new FakeAudioContext();
    const copy = new FakeAudioContext();

    playVoice(ctx, params, 0);
    playVoice(copy, JSON.parse(JSON.stringify(params)), 0);

    expect(frequencyCalls(copy)).toEqual(frequencyCalls(ctx));
    expect(() => note('a4').pitchsteps([])).toThrow(/non-empty/);
    expect(() => note('a4').pitchsteps([0, NaN])).toThrow(/finite/);
    expect(() => note('a4').pitchsteps([0], 0)).toThrow(/rate must be positive/);
  });
});

describe('combining curves', () => {
  it('lets steps beat penv beat slide, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeAudioContext();

    note('a4').slide(0.1).penv(12).pitchsteps([0, 12], 100).play({ ctx, when: 0 });
    note('a4').slide(0.1).penv(-12).play({ ctx, when: 0 });

    expect(frequencyCalls(ctx, 0)).toHaveLength(2);
    expect(frequencyCalls(ctx, 0)[1]).toMatchObject({ method: 'setValueAtTime', value: 880 });
    expect(frequencyCalls(ctx, 1)[0]).toMatchObject({ value: 220 }); // penv's octave-down start, not slide's octave up
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
