// Unit tests for the synth engine's node graph and envelope scheduling
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrbitBus } from './effects';
import { playVoice, playVoices, resolveParams } from './engine';
import { noteToFrequency } from './pitch';
import { clearSamples, registerSample } from './samples';
import { FakeAudioContext } from './test-utils/fakeAudioContext';
import type { AudioBufferLike } from './types';

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

describe('sample voices', () => {
  const FAKE_BUFFER: AudioBufferLike = { getChannelData: () => new Float32Array(4) };

  beforeEach(() => {
    clearSamples();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('builds a buffer source (not an oscillator) using the registered sample, at playbackRate 1 for an unpitched hit', () => {
    registerSample('bd', FAKE_BUFFER);
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ sampleName: 'bd' }), 0);

    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.bufferSources).toHaveLength(1);
    const bufferSource = ctx.bufferSources[0];
    expect(bufferSource.buffer).toBe(FAKE_BUFFER);
    expect(bufferSource.playbackRate.calls).toEqual([
      { method: 'setValueAtTime', value: 1, time: 0 }
    ]);
    expect(bufferSource.connectedTo).toEqual([ctx.gains[0]]);
  });

  it("computes playbackRate from pitch relative to the sample's registered baseNote", () => {
    registerSample('piano', { buffer: FAKE_BUFFER, baseNote: 'c4' });
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ sampleName: 'piano', pitch: 'e4' }), 0);

    const expectedRate = noteToFrequency('e4') / noteToFrequency('c4');
    expect(ctx.bufferSources[0].playbackRate.calls[0].value).toBeCloseTo(expectedRate, 10);
  });

  it('assumes a c4 baseNote when the registered sample sets none', () => {
    registerSample('piano', FAKE_BUFFER);
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ sampleName: 'piano', pitch: 'g4' }), 0);

    const expectedRate = noteToFrequency('g4') / noteToFrequency('c4');
    expect(ctx.bufferSources[0].playbackRate.calls[0].value).toBeCloseTo(expectedRate, 10);
  });

  it('prefers the banked key over the bare name, falling back when unregistered', () => {
    const banked: AudioBufferLike = { getChannelData: () => new Float32Array(8) };
    registerSample('RolandTR707_bd', banked);
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ sampleName: 'bd', sampleBank: 'RolandTR707' }), 0);

    expect(ctx.bufferSources[0].buffer).toBe(banked);
  });

  it('sampleName takes precedence over soundType when both are set', () => {
    registerSample('bd', FAKE_BUFFER);
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ sampleName: 'bd', soundType: 'triangle' }), 0);

    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.bufferSources).toHaveLength(1);
  });

  it('skips the voice entirely — no nodes created at all — for an unregistered sample name', () => {
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ sampleName: 'nope' }), 0);

    expect(ctx.bufferSources).toHaveLength(0);
    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.gains).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('hpf and phaser inserts', () => {
  it('inserts a highpass filter in series after the lowpass', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', filterCutoff: 800, hpfCutoff: 200 }), 0);

    expect(ctx.filters).toHaveLength(2);
    const [lowpass, highpass] = ctx.filters;
    expect(lowpass.type).toBe('lowpass');
    expect(highpass.type).toBe('highpass');
    expect(ctx.oscillators[0].connectedTo).toEqual([lowpass]);
    expect(lowpass.connectedTo).toEqual([highpass]);
    expect(highpass.connectedTo).toEqual([ctx.gains[0]]);
    expect(highpass.frequency.calls).toEqual([{ method: 'setValueAtTime', value: 200, time: 0 }]);
  });

  it('creates no highpass filter at all when hpfCutoff is undefined', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);
    expect(ctx.filters).toHaveLength(0);
  });

  it('inserts a 4-stage allpass phaser driven by one LFO through a shared depth gain', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', phaserRate: 0.7, attack: 0, release: 0 }), 0);

    const allpassStages = ctx.filters.filter((f) => f.type === 'allpass');
    expect(allpassStages).toHaveLength(4);

    // Main pitch oscillator + the phaser's own LFO oscillator.
    expect(ctx.oscillators).toHaveLength(2);
    const lfo = ctx.oscillators[1];
    expect(lfo.frequency.calls).toEqual([{ method: 'setValueAtTime', value: 0.7, time: 0 }]);

    // The LFO drives a shared depth gain, which fans out to every stage's frequency param.
    const depthGain = ctx.gains.find((g) => g.connectedTo.includes(allpassStages[0].frequency));
    expect(depthGain).toBeDefined();
    for (const stage of allpassStages) {
      expect(depthGain!.connectedTo).toContain(stage.frequency);
    }

    // Stages chain source -> stage0 -> stage1 -> stage2 -> stage3 -> gain.
    expect(ctx.oscillators[0].connectedTo).toEqual([allpassStages[0]]);
    expect(allpassStages[3].connectedTo).toEqual([ctx.gains[0]]);
  });

  it("stops the phaser's LFO alongside the voice's own end", () => {
    const ctx = new FakeAudioContext();
    playVoice(
      ctx,
      resolveParams({ pitch: 'a4', phaserRate: 1, attack: 0, decay: 0, sustain: 0, release: 0.05 }),
      0
    );

    const lfo = ctx.oscillators[1];
    expect(lfo.started).toEqual([0]);
    expect(lfo.stopped[0]).toBeCloseTo(0.07, 10); // release end (0.05) + STOP_TAIL_SECONDS (0.02)
  });

  it('creates no phaser nodes at all when phaserRate is undefined', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);
    expect(ctx.oscillators).toHaveLength(1); // just the pitch oscillator, no LFO
    expect(ctx.filters.filter((f) => f.type === 'allpass')).toHaveLength(0);
  });
});

describe('reverb/delay sends and orbit buses', () => {
  it('creates no orbit bus at all when neither roomLevel nor delayLevel is set', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);
    expect(ctx.convolvers).toHaveLength(0);
    expect(ctx.delays).toHaveLength(0);
  });

  it('sends the placed voice to the default orbit (0) reverb bus, post-pan', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    playVoice(ctx, resolveParams({ pitch: 'a4', pan: -1, roomLevel: 0.4 }), 0);

    const panner = ctx.panners[0];
    const send = ctx.gains.find((g) => g.connectedTo.includes(bus.reverbInput));
    expect(send).toBeDefined();
    expect(panner.connectedTo).toContain(send);
    expect(send!.gain.calls).toEqual([{ method: 'setValueAtTime', value: 0.4, time: 0 }]);
  });

  it('sends to the delay bus as well when delayLevel is set, using delayTime/delayFeedback', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    playVoice(
      ctx,
      resolveParams({ pitch: 'a4', delayLevel: 0.2, delayTime: 0.25, delayFeedback: 0.4 }),
      0
    );

    const send = ctx.gains.find((g) => g.connectedTo.includes(bus.delayInput));
    expect(send).toBeDefined();
    expect(send!.gain.calls).toEqual([{ method: 'setValueAtTime', value: 0.2, time: 0 }]);
    expect(ctx.delays[0].delayTime.calls).toEqual([
      { method: 'setValueAtTime', value: 0.25, time: 0 }
    ]);
  });

  it('routes different orbit numbers to different buses', () => {
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ pitch: 'a4', roomLevel: 0.3, orbit: 0 }), 0);
    playVoice(ctx, resolveParams({ pitch: 'a4', roomLevel: 0.3, orbit: 1 }), 0);

    expect(ctx.convolvers).toHaveLength(2);
  });

  it('skips the send entirely when the level is 0', () => {
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ pitch: 'a4', roomLevel: 0 }), 0);
    expect(ctx.convolvers).toHaveLength(0);
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
