// Tests for FM synthesis: modulator graph, pitch-curve tracking, depth envelope and controls
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, sound } from './control';
import { playVoice, resolveParams } from './engine';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

const VOICE_END = 0.18; // default amplitude envelope: 0.01 + 0.1 + 0.05, plus the 0.02 tail

describe('FM graph', () => {
  it('adds no nodes when fm is unset or 0', () => {
    const plain = new FakeAudioContext();
    const zero = new FakeAudioContext();

    note('a4').play({ ctx: plain, when: 0 });
    note('a4').fm(0).play({ ctx: zero, when: 0 });

    expect(plain.oscillators).toHaveLength(1);
    expect(zero.oscillators).toHaveLength(1);
    expect(zero.gains).toHaveLength(1);
  });

  it('wires modulator -> depth gain -> carrier frequency', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(3).play({ ctx, when: 0 });

    const [carrier, modulator] = ctx.oscillators;
    const depth = ctx.gains[1];
    expect(modulator.connectedTo).toEqual([depth]);
    expect(depth.connectedTo).toEqual([carrier.frequency]);
    expect(carrier.connectedTo).toEqual([ctx.gains[0]]); // the modulator never reaches the output
  });

  it('sets the modulator to harmonicity × pitch and the depth to index × modulator Hz', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(2).fmh(3.5).play({ ctx, when: 0 });

    const [carrier, modulator] = ctx.oscillators;
    expect(carrier.frequency.calls).toEqual([{ method: 'setValueAtTime', value: 440, time: 0 }]);
    expect(modulator.frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 440 * 3.5, time: 0 }
    ]);
    expect(ctx.gains[1].gain.calls).toEqual([
      { method: 'setValueAtTime', value: 440 * 3.5 * 2, time: 0 }
    ]);
  });

  it('makes brightness follow pitch: the deviation scales with the note', () => {
    const ctx = new FakeAudioContext();

    note('a3 a4').fm(2).play({ ctx, when: 0 });

    expect(ctx.gains[1].gain.calls[0]).toMatchObject({ value: 220 * 2 });
    expect(ctx.gains[3].gain.calls[0]).toMatchObject({ value: 440 * 2 });
  });

  it('defaults the harmonicity to 1 and the waveform to sine, and honours fmwave', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(1).play({ ctx, when: 0 });
    note('a4').fm(1).fmwave('square').play({ ctx, when: 0 });

    expect(ctx.oscillators[1].frequency.calls[0]).toMatchObject({ value: 440 });
    expect(ctx.oscillators[1].type).toBe('sine');
    expect(ctx.oscillators[3].type).toBe('square');
  });

  it('starts and stops the modulator with the carrier window', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(1).play({ ctx, when: 1 });

    const [carrier, modulator] = ctx.oscillators;
    expect(modulator.started).toEqual(carrier.started);
    expect(modulator.stopped).toEqual(carrier.stopped);
    expect(modulator.stopped[0]).toBeCloseTo(1 + VOICE_END);
  });

  it('stops the modulator too when the voice is stopped early', () => {
    const ctx = new FakeAudioContext();

    const handle = note('a4').fm(1).play({ ctx, when: 0 });
    handle.stop(0.05);

    expect(ctx.oscillators[1].stopped.at(-1)).toBeCloseTo(0.06);
  });

  it('ignores FM on noise voices', () => {
    const ctx = new FakeAudioContext();

    sound('white').fm(3).play({ ctx, when: 0 });

    expect(ctx.oscillators).toHaveLength(0);
  });

  it('accepts the fmi alias and per-event patterns', () => {
    const ctx = new FakeAudioContext();

    note('a4 a4').fmi('1 4').play({ ctx, when: 0 });

    expect(ctx.gains[1].gain.calls[0]).toMatchObject({ value: 440 });
    expect(ctx.gains[3].gain.calls[0]).toMatchObject({ value: 440 * 4 });
  });

  it('survives a JSON round trip of the voice data', () => {
    const params = resolveParams({ pitch: 'a4', fmIndex: 2, fmHarmonicity: 2, fmWave: 'triangle' });
    const direct = new FakeAudioContext();
    const saved = new FakeAudioContext();

    playVoice(direct, params, 0);
    playVoice(saved, JSON.parse(JSON.stringify(params)), 0);

    expect(saved.oscillators.map((o) => o.type)).toEqual(direct.oscillators.map((o) => o.type));
    expect(saved.gains[1].gain.calls).toEqual(direct.gains[1].gain.calls);
  });
});

describe('FM follows the carrier pitch curve', () => {
  it('scales slide automation at each stage (carrier x1, modulator x harmonicity, depth x both)', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(2).fmh(2).slide(0.07).play({ ctx, when: 0 });

    const [carrier, modulator] = ctx.oscillators;
    expect(carrier.frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 880, time: 0 },
      { method: 'exponentialRampToValueAtTime', value: 440, time: 0.07 }
    ]);
    expect(modulator.frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 1760, time: 0 },
      { method: 'exponentialRampToValueAtTime', value: 880, time: 0.07 }
    ]);
    expect(ctx.gains[1].gain.calls).toEqual([
      { method: 'setValueAtTime', value: 3520, time: 0 },
      { method: 'exponentialRampToValueAtTime', value: 1760, time: 0.07 }
    ]);
  });

  it('follows a stepped curve frame by frame', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(1).pitchsteps([0, 12], 100).play({ ctx, when: 0 });

    expect(ctx.oscillators[1].frequency.calls.map((c) => c.value)).toEqual([440, 880]);
    expect(ctx.gains[1].gain.calls.map((c) => c.value)).toEqual([440, 880]);
  });
});

describe('FM depth envelope', () => {
  it('creates no envelope gain unless an fm envelope control is set', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(2).play({ ctx, when: 0 });

    expect(ctx.gains).toHaveLength(2); // amplitude and depth only
  });

  it('routes depth -> envelope -> carrier frequency and shapes the envelope', () => {
    const ctx = new FakeAudioContext();

    note('a4')
      .fm(2)
      .fmenv('lin')
      .fmattack(0.05)
      .fmdecay(0.2)
      .fmsustain(0.25)
      .play({ ctx, when: 0 });

    const [carrier] = ctx.oscillators;
    const [, depth, envelope] = ctx.gains;
    expect(depth.connectedTo).toEqual([envelope]);
    expect(envelope.connectedTo).toEqual([carrier.frequency]);
    expect(envelope.gain.calls).toEqual([
      { method: 'setValueAtTime', value: 0, time: 0 },
      { method: 'linearRampToValueAtTime', value: 1, time: 0.05 },
      { method: 'linearRampToValueAtTime', value: 0.25, time: expect.closeTo(0.25) }
    ]);
  });

  it('gates the depth on its own sustain, independent of the amplitude sustain', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(2).fmsustain(0.5).fmrelease(0.1).sustain(0).duration(1).play({ ctx, when: 0 });

    const [amplitude, , envelope] = ctx.gains;
    expect(envelope.gain.calls).toContainEqual({ method: 'setValueAtTime', value: 0.5, time: 1 });
    expect(amplitude.gain.calls.some((c) => c.time === 1)).toBe(false);
  });

  it('defaults to an exponential curve with a floor above silence', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(2).fmattack(0.05).fmdecay(0.1).fmsustain(0.5).play({ ctx, when: 0 });

    const envelope = ctx.gains[2];
    expect(envelope.gain.calls[0]).toEqual({ method: 'setValueAtTime', value: 1e-4, time: 0 });
    expect(envelope.gain.calls[1]).toMatchObject({
      method: 'exponentialRampToValueAtTime',
      value: 1
    });
  });
});

describe('FM envelope defaults (as in Strudel)', () => {
  it('lets a bare fmdecay fall toward silence', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(2).fmdecay(0.2).play({ ctx, when: 0 });

    const calls = ctx.gains[2].gain.calls;
    expect(calls.at(-1)).toMatchObject({ method: 'exponentialRampToValueAtTime', value: 1e-4 });
  });

  it('holds the depth when only an attack is set', () => {
    const ctx = new FakeAudioContext();

    note('a4').fm(2).fmattack(0.05).play({ ctx, when: 0 });

    const calls = ctx.gains[2].gain.calls;
    expect(calls.at(-1)).toMatchObject({ value: 1 });
  });
});

describe('FM control validation', () => {
  it('rejects bad values', () => {
    expect(() => note('a4').fm(-1)).toThrow(/must not be negative/);
    expect(() => note('a4').fmh(0)).toThrow(/must be positive/);
    expect(() => note('a4').fmwave('white' as never)).toThrow(/must be one of/);
    expect(() => note('a4').fmenv('log' as never)).toThrow(/'lin' or 'exp'/);
  });
});
