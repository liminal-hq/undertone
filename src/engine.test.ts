// Unit tests for the synth engine's node graph and envelope scheduling
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { playVoice, playVoices, resolveParams } from './engine';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

describe('resolveParams', () => {
  it('fills a patch out with the documented defaults', () => {
    const params = resolveParams({ pitch: 'c2' });
    expect(params).toMatchObject({
      pitch: 'c2',
      soundType: 'sine',
      gainLevel: 0.8,
      attack: 0.01,
      decay: 0.1,
      sustain: 0,
      release: 0.05,
      filterCutoff: undefined,
      slideTime: 0,
      nudgeTime: 0
    });
  });
});

describe('playVoice', () => {
  it('builds oscillator -> gain -> destination for a plain pitched voice', () => {
    const ctx = new FakeAudioContext();
    const params = resolveParams({
      pitch: 'a4',
      soundType: 'triangle',
      attack: 0.01,
      decay: 0.1,
      sustain: 0,
      release: 0.05,
      gainLevel: 0.7
    });

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
    playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);

    expect(ctx.oscillators[0].frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 440, time: 0 }
    ]);
  });

  it('glides from an octave above down to the target note when slideTime is set', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', slideTime: 0.07 }), 0);

    expect(ctx.oscillators[0].frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 880, time: 0 },
      { method: 'exponentialRampToValueAtTime', value: 440, time: 0.07 }
    ]);
  });

  it('schedules a percussive attack/decay/release gain envelope with no held plateau', () => {
    const ctx = new FakeAudioContext();
    const params = resolveParams({
      pitch: 'c2',
      attack: 0.001,
      decay: 0.1,
      sustain: 0.25,
      release: 0.05,
      gainLevel: 0.9
    });

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

  it('offsets everything by nudgeTime relative to the shared start time', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', nudgeTime: 0.02 }), 1);

    expect(ctx.gains[0].gain.calls[0]).toMatchObject({ time: 1.02 });
    expect(ctx.oscillators[0].started).toEqual([1.02]);
  });

  it('inserts a lowpass filter between source and gain, enveloped between lpf and lpf+lpenv', () => {
    const ctx = new FakeAudioContext();
    const params = resolveParams({
      pitch: 'c2',
      filterCutoff: 220,
      filterEnvAmount: 5,
      filterAttack: 0.001,
      filterDecay: 0.08,
      filterSustain: 0,
      filterRelease: 0.05
    });

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

  it('creates no filter node at all when filterCutoff is undefined', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);
    expect(ctx.filters).toHaveLength(0);
  });

  it('builds a buffer source (not an oscillator) for noise sound types', () => {
    const ctx = new FakeAudioContext();
    playVoice(
      ctx,
      resolveParams({ soundType: 'white', attack: 0, decay: 0.02, sustain: 0, release: 0.01 }),
      0
    );

    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.bufferSources).toHaveLength(1);
    const bufferSource = ctx.bufferSources[0];
    expect(bufferSource.buffer).not.toBeNull();
    expect(bufferSource.connectedTo).toEqual([ctx.gains[0]]);
  });

  it('holds the sustain level until the gate ends when duration is set', () => {
    const ctx = new FakeAudioContext();
    const params = resolveParams({
      pitch: 'c3',
      attack: 0.01,
      decay: 0.1,
      sustain: 0.5,
      release: 0.05,
      gainLevel: 1,
      duration: 0.5
    });

    playVoice(ctx, params, 0);

    expect(ctx.gains[0].gain.calls).toEqual([
      { method: 'setValueAtTime', value: 0, time: 0 },
      { method: 'linearRampToValueAtTime', value: 1, time: 0.01 },
      { method: 'linearRampToValueAtTime', value: 0.5, time: 0.11 },
      { method: 'setValueAtTime', value: 0.5, time: 0.5 },
      { method: 'linearRampToValueAtTime', value: 0, time: 0.55 }
    ]);
  });

  it('applies the same gate to the filter envelope', () => {
    const ctx = new FakeAudioContext();
    const params = resolveParams({
      pitch: 'c3',
      sustain: 0.5,
      filterCutoff: 200,
      filterEnvAmount: 100,
      filterAttack: 0.01,
      filterDecay: 0.04,
      filterSustain: 0.5,
      filterRelease: 0.1,
      duration: 0.5
    });

    playVoice(ctx, params, 0);

    expect(ctx.filters[0].frequency.calls).toEqual([
      { method: 'setValueAtTime', value: 200, time: 0 },
      { method: 'linearRampToValueAtTime', value: 300, time: 0.01 },
      { method: 'linearRampToValueAtTime', value: 250, time: 0.05 },
      { method: 'setValueAtTime', value: 250, time: 0.5 },
      { method: 'linearRampToValueAtTime', value: 200, time: 0.6 }
    ]);
  });

  it('skips gating entirely when sustain is 0 — a silent hold would only waste node lifetime', () => {
    const ctx = new FakeAudioContext();
    const params = resolveParams({
      pitch: 'c3',
      attack: 0.01,
      decay: 0.1,
      sustain: 0,
      release: 0.05,
      duration: 8
    });

    playVoice(ctx, params, 0);

    expect(ctx.gains[0].gain.calls).toHaveLength(4);
    expect(ctx.gains[0].gain.calls[3]).toMatchObject({ time: 0.16 });
    expect(ctx.oscillators[0].stopped[0]).toBeCloseTo(0.18, 10);
  });

  it('caps and loops the noise buffer for long gates instead of generating huge buffers', () => {
    const ctx = new FakeAudioContext();
    playVoice(
      ctx,
      resolveParams({ soundType: 'white', sustain: 0.5, release: 0.05, duration: 8 }),
      0
    );

    const buffer = ctx.bufferSources[0].buffer;
    expect(buffer).not.toBeNull();
    expect(buffer!.getChannelData(0).length).toBe(2 * ctx.sampleRate);
    expect(ctx.bufferSources[0].loop).toBe(true);
  });

  it('keeps short noise buffers envelope-sized and unlooped', () => {
    const ctx = new FakeAudioContext();
    playVoice(
      ctx,
      resolveParams({ soundType: 'white', attack: 0, decay: 0.02, sustain: 0, release: 0.01 }),
      0
    );

    const buffer = ctx.bufferSources[0].buffer;
    expect(buffer!.getChannelData(0).length).toBeLessThan(0.1 * ctx.sampleRate);
    expect(ctx.bufferSources[0].loop).toBe(false);
  });

  it('clamps negative start times to the context origin', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', nudgeTime: -0.5 }), 0);

    expect(ctx.oscillators[0].started).toEqual([0]);
    expect(ctx.gains[0].gain.calls[0]).toMatchObject({ time: 0 });
  });

  it('stays percussive (no hold) when the envelope outlasts the gate', () => {
    const ctx = new FakeAudioContext();
    const params = resolveParams({
      pitch: 'c3',
      attack: 0.01,
      decay: 0.1,
      sustain: 0,
      release: 0.05,
      duration: 0.05
    });

    playVoice(ctx, params, 0);

    // Release starts at decay end (0.11), not at the earlier gate end.
    const calls = ctx.gains[0].gain.calls;
    expect(calls).toHaveLength(4);
    expect(calls[3].method).toBe('linearRampToValueAtTime');
    expect(calls[3].time).toBeCloseTo(0.16, 10);
  });

  it('routes through a stereo panner when pan is set', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', pan: -1 }), 2);

    expect(ctx.panners).toHaveLength(1);
    const panner = ctx.panners[0];
    expect(ctx.gains[0].connectedTo).toEqual([panner]);
    expect(panner.connectedTo).toEqual([ctx.destination]);
    expect(panner.pan.calls).toEqual([{ method: 'setValueAtTime', value: -1, time: 2 }]);
  });

  it('routes channelGains through per-speaker gains into a merger on a multichannel destination', () => {
    const ctx = new FakeAudioContext();
    ctx.destination.maxChannelCount = 8;
    ctx.destination.channelCount = 8;

    // FL 0.5, SR 1 (indices 0 and 5)
    playVoice(ctx, resolveParams({ pitch: 'a4', channelGains: [0.5, 0, 0, 0, 0, 1] }), 1);

    expect(ctx.mergers).toHaveLength(1);
    const merger = ctx.mergers[0];
    expect(merger.numberOfInputs).toBe(6);
    expect(merger.connectedTo).toEqual([ctx.destination]);

    // envelope gain + one channel gain per nonzero entry
    expect(ctx.gains).toHaveLength(3);
    const [envelope, flGain, srGain] = ctx.gains;
    expect(envelope.connectedTo).toEqual([flGain, srGain]);
    expect(flGain.gain.calls).toEqual([{ method: 'setValueAtTime', value: 0.5, time: 1 }]);
    expect(flGain.connections).toEqual([{ node: merger, output: 0, input: 0 }]);
    expect(srGain.connections).toEqual([{ node: merger, output: 0, input: 5 }]);
    expect(ctx.panners).toHaveLength(0);
  });

  it('folds channelGains down to stereo when the destination cannot address them', () => {
    const ctx = new FakeAudioContext(); // stereo destination
    const gains = [0, 0, 1, 0, 0, 0, 0, 0]; // centre only

    playVoice(ctx, resolveParams({ pitch: 'a4', channelGains: gains }), 0);

    const merger = ctx.mergers[0];
    expect(merger.numberOfInputs).toBe(2);
    const channelGainNodes = ctx.gains.slice(1);
    expect(channelGainNodes).toHaveLength(2);
    expect(channelGainNodes[0].gain.calls[0].value).toBeCloseTo(Math.SQRT1_2, 10);
    expect(channelGainNodes[1].gain.calls[0].value).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('folds 7.1 placement to 5.1 (not stereo) on a six-channel destination', () => {
    const ctx = new FakeAudioContext();
    ctx.destination.maxChannelCount = 6;
    ctx.destination.channelCount = 6;

    // RL only (index 6) — must fold into SL (index 4), not vanish or go stereo.
    playVoice(ctx, resolveParams({ pitch: 'a4', channelGains: [0, 0, 0, 0, 0, 0, 1, 0] }), 0);

    const merger = ctx.mergers[0];
    expect(merger.numberOfInputs).toBe(6);
    const channelGain = ctx.gains[1];
    expect(channelGain.gain.calls[0].value).toBeCloseTo(Math.SQRT1_2, 10);
    expect(channelGain.connections).toEqual([{ node: merger, output: 0, input: 4 }]);
  });

  it('routes unplaced voices through a centred stereo merger on a widened destination', () => {
    const ctx = new FakeAudioContext();
    ctx.destination.channelCount = 8; // as after enableMultichannel() on 7.1 hardware

    playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);

    // A bare mono connect would land in FL only under discrete interpretation.
    const merger = ctx.mergers[0];
    expect(merger.numberOfInputs).toBe(2);
    expect(ctx.gains).toHaveLength(3);
    expect(ctx.gains[1].gain.calls[0].value).toBe(1);
    expect(ctx.gains[2].gain.calls[0].value).toBe(1);
    expect(ctx.gains[1].connections).toEqual([{ node: merger, output: 0, input: 0 }]);
    expect(ctx.gains[2].connections).toEqual([{ node: merger, output: 0, input: 1 }]);
  });

  it('treats empty channelGains as no placement at all', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', channelGains: [] }), 0);

    expect(ctx.mergers).toHaveLength(0);
    expect(ctx.gains[0].connectedTo).toEqual([ctx.destination]);
  });

  it('pads single-entry channelGains to two so the merger cannot up-mix mono to both speakers', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', channelGains: [1] }), 0);

    expect(ctx.mergers[0].numberOfInputs).toBe(2);
    expect(ctx.gains).toHaveLength(2); // envelope + FL only; the zero-gain channel gets no node
  });

  it('gives channelGains precedence over pan', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', pan: -1, channelGains: [1, 0] }), 0);

    expect(ctx.mergers).toHaveLength(1);
    expect(ctx.panners).toHaveLength(0);
  });

  it('creates no panner node at all when pan is undefined', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);
    expect(ctx.panners).toHaveLength(0);
    expect(ctx.gains[0].connectedTo).toEqual([ctx.destination]);
  });

  it('stops the source shortly after the slowest envelope (gain vs filter) finishes releasing', () => {
    const ctx = new FakeAudioContext();
    // Filter release ends later than gain release here.
    playVoice(
      ctx,
      resolveParams({
        pitch: 'c2',
        attack: 0,
        decay: 0,
        sustain: 0,
        release: 0.05,
        filterCutoff: 200,
        filterRelease: 0.5
      }),
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
      [
        resolveParams({ pitch: 'c2' }),
        resolveParams({ pitch: 'c6', nudgeTime: 0.02 }),
        resolveParams({ soundType: 'white' })
      ],
      0
    );

    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.bufferSources).toHaveLength(1);
    expect(ctx.gains).toHaveLength(3);
    expect(ctx.oscillators[1].started).toEqual([0.02]);
  });
});
