// Unit tests for the synth engine's node graph and envelope scheduling
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, sound } from './voice';
import { playVoice, playVoices } from './engine';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

describe('playVoice', () => {
  it('builds oscillator -> gain -> destination for a plain pitched voice', () => {
    const ctx = new FakeAudioContext();
    const params = note('a4')
      .sound('triangle')
      .attack(0.01)
      .decay(0.1)
      .sustain(0)
      .release(0.05)
      .gain(0.7)
      .getParams();

    playVoice(ctx, params, 0);

    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.filters).toHaveLength(0);
    expect(ctx.bufferSources).toHaveLength(0);

    const osc = ctx.oscillators[0];
    const gain = ctx.gains[0];
    expect(osc.type).toBe('triangle');
    expect(osc.connectedTo).toEqual([gain]);
    expect(gain.connectedTo).toEqual([ctx.destination]);
  });

  it('sets oscillator frequency directly (no slide) when slideTime is 0', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, note('a4').getParams(), 0);

    expect(ctx.oscillators[0].frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 440, time: 0 }
    ]);
  });

  it('glides from an octave above down to the target note when slide() is set', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, note('a4').slide(0.07).getParams(), 0);

    expect(ctx.oscillators[0].frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 880, time: 0 },
      { method: 'exponentialRampToValueAtTime', value: 440, time: 0.07 }
    ]);
  });

  it('schedules a percussive attack/decay/release gain envelope with no held plateau', () => {
    const ctx = new FakeAudioContext();
    const params = note('c2')
      .attack(0.001)
      .decay(0.1)
      .sustain(0.25)
      .release(0.05)
      .gain(0.9)
      .getParams();

    playVoice(ctx, params, 0);

    const calls = ctx.gains[0].gain.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({ method: 'setValueAtTime', value: 0, time: 0 });
    expect(calls[1]).toEqual({ method: 'linearRampToValueAtTime', value: 0.9, time: 0.001 });
    expect(calls[2].method).toBe('linearRampToValueAtTime');
    expect(calls[2].value).toBeCloseTo(0.225, 10);
    expect(calls[2].time).toBeCloseTo(0.101, 10);
    expect(calls[3].method).toBe('linearRampToValueAtTime');
    expect(calls[3].value).toBe(0);
    expect(calls[3].time).toBeCloseTo(0.151, 10);
  });

  it('offsets everything by nudge() relative to the shared start time', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, note('a4').nudge(0.02).getParams(), 1);

    expect(ctx.gains[0].gain.calls[0]).toMatchObject({ time: 1.02 });
    expect(ctx.oscillators[0].started).toEqual([1.02]);
  });

  it('inserts a lowpass filter between source and gain, enveloped between lpf and lpf+lpenv', () => {
    const ctx = new FakeAudioContext();
    const params = note('c2').lpf(220).lpenv(5).lpa(0.001).lpd(0.08).lps(0).lpr(0.05).getParams();

    playVoice(ctx, params, 0);

    expect(ctx.filters).toHaveLength(1);
    const filter = ctx.filters[0];
    expect(filter.type).toBe('lowpass');
    expect(ctx.oscillators[0].connectedTo).toEqual([filter]);
    expect(filter.connectedTo).toEqual([ctx.gains[0]]);

    expect(filter.frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 220, time: 0 },
      { method: 'linearRampToValueAtTime', value: 225, time: 0.001 },
      { method: 'linearRampToValueAtTime', value: 220, time: 0.081 },
      { method: 'linearRampToValueAtTime', value: 220, time: 0.131 }
    ]);
  });

  it('creates no filter node at all when lpf() was never called', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, note('a4').getParams(), 0);
    expect(ctx.filters).toHaveLength(0);
  });

  it('builds a buffer source (not an oscillator) for noise sound types', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, sound('white').attack(0).decay(0.02).sustain(0).release(0.01).getParams(), 0);

    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.bufferSources).toHaveLength(1);
    const bufferSource = ctx.bufferSources[0];
    expect(bufferSource.buffer).not.toBeNull();
    expect(bufferSource.connectedTo).toEqual([ctx.gains[0]]);
  });

  it('stops the source shortly after the slowest envelope (gain vs filter) finishes releasing', () => {
    const ctx = new FakeAudioContext();
    // Filter release ends later than gain release here.
    playVoice(
      ctx,
      note('c2').attack(0).decay(0).sustain(0).release(0.05).lpf(200).lpr(0.5).getParams(),
      0
    );

    expect(ctx.oscillators[0].stopped[0]).toBeCloseTo(0.52, 5);
  });
});

describe('playVoices', () => {
  it('realizes every voice in the list independently, honouring each nudge', () => {
    const ctx = new FakeAudioContext();
    playVoices(
      ctx,
      [note('c2').getParams(), note('c6').nudge(0.02).getParams(), sound('white').getParams()],
      0
    );

    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.bufferSources).toHaveLength(1);
    expect(ctx.gains).toHaveLength(3);
    expect(ctx.oscillators[1].started).toEqual([0.02]);
  });
});
