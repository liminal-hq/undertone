// Tests of the Web Audio backend: replay after a failing call, host nodes as outputs, the two modules' samples, bounded sessions
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Fraction,
  Pattern,
  clearSamples,
  encodeWav,
  loadSamples,
  note,
  playParams,
  registerSample,
  registerSamples,
  renderToBuffer,
  resetTempo,
  s,
  setcpm,
  sound
} from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';
import * as wasm from '@liminal-hq/undertone/wasm';
import { backendOf } from '../dist/webaudio.js';
import { FakeAudioContext, recordedGraph } from '../../../src/test-utils/fakeAudioContext';

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
  resetTempo();
  clearSamples();
});

/** A timer ticked by hand, as the reference's tests tick theirs. */
function manualTimer() {
  let callback: (() => void) | undefined;
  return {
    timer: {
      setInterval: (fn: () => void) => {
        callback = fn;
        return 1;
      },
      clearInterval: () => {
        callback = undefined;
      }
    },
    tick: () => callback?.()
  };
}

describe('the replay', () => {
  it('replays what a failing play booked, and the rollback that cuts it (D-38)', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 1;
    const half = (n: number) => ({ begin: new Fraction(n, 2), end: new Fraction(n + 1, 2) });
    const broken = new Pattern(() => [
      { whole: half(0), part: half(0), value: { note: 'c3' } },
      { whole: half(1), part: half(1), value: { note: 'e3', roomLevel: 0.5, roomSize: Infinity } }
    ]);
    expect(() => broken.play({ ctx })).toThrow(/room/);
    // The first voice was booked, then cut at once with the rollback's short fade.
    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(1);
    const cut = ctx.gains.filter((gain) =>
      gain.gain.calls.some((call) => call.method === 'cancelScheduledValues' && call.time === 1)
    );
    expect(cut.length).toBeGreaterThanOrEqual(1);
  });

  it('plays into a node of the host given as the output, adopting it once', () => {
    const ctx = new FakeAudioContext();
    const own = ctx.createGain();
    playParams(ctx, [{ pitch: 'a3' }], { output: own });
    playParams(ctx, [{ pitch: 'c4' }], { output: own });
    const voices = ctx.gains.filter((gain) => gain !== own);
    expect(voices.every((gain) => gain.connectedTo.includes(own))).toBe(true);
    expect(ctx.destination.connectedTo).toEqual([]);
  });

  it('keeps a long loop bounded: the module memory stays put over 10 minutes of ticks', () => {
    const ctx = new FakeAudioContext();
    const { timer, tick } = manualTimer();
    const looping = sound('sine [white pink] sawtooth triangle').loop({ ctx, timer, bpm: 480 });
    const before = wasm.memoryBytes();
    for (let step = 1; step <= 6000; step += 1) {
      ctx.currentTime = step * 0.1;
      tick();
    }
    looping.stop();
    expect(ctx.oscillators.length + ctx.bufferSources.length).toBeGreaterThan(6000);
    expect(wasm.memoryBytes() - before).toBeLessThan(8 * 1024 * 1024);
  });

  it('keeps the replayer bounded over a long run of autopanned voices: their periodic waves are released with them', () => {
    const ctx = new FakeAudioContext();
    for (let step = 0; step < 300; step += 1) {
      ctx.currentTime = step * 2;
      playParams(ctx, [
        { pitch: 'a4', autopan: 2, autopanPhase: 0.25, attack: 0.01, release: 0.1 }
      ]);
    }
    const { replayer } = backendOf(ctx);
    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(600); // a voice and its LFO each
    expect(replayer.held).toBeLessThan(40);
    expect(replayer.waves).toBeLessThan(5);
  });

  it('keeps the replayer bounded for autopan waves a context cannot make, and keeps the shaped waves it shares', () => {
    const ctx = new FakeAudioContext({ noPeriodicWave: true } as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let step = 0; step < 100; step += 1) {
      ctx.currentTime = step * 2;
      playParams(ctx, [{ pitch: 'a4', autopan: 2, autopanPhase: 0.25, release: 0.1 }]);
      playParams(ctx, [{ pitch: 'a4', soundType: 'halfsine' }]);
    }
    expect(backendOf(ctx).replayer.waves).toBeLessThan(8);
  });

  it('tells a running loop a setcpm() change at its next window', () => {
    const ctx = new FakeAudioContext();
    const { timer, tick } = manualTimer();
    const looping = note('c3*4').loop({ ctx, timer });
    for (let step = 1; step <= 20; step += 1) {
      if (step === 5) setcpm(60);
      ctx.currentTime = step * 0.1;
      tick();
    }
    looping.stop({ voices: 'cut' });
    const starts = ctx.oscillators.map((osc) => osc.started[0]);
    // 120 bpm is 0.5 s a beat at first; after the change at 0.5 s, 60 cycles a minute is 0.25 s a quarter.
    expect(starts.slice(0, 2)).toEqual([0.1, 0.6]);
    expect(starts.at(-1)! - starts.at(-2)!).toBeCloseTo(0.25, 9);
    expect(recordedGraph(ctx)).toBeDefined();
  });
});

describe('a context without an optional member', () => {
  it('names the shaped wave that falls back to a sine', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeAudioContext({ noPeriodicWave: true });
    note('a4 a4').sound('pulsesine').play({ ctx, when: 0 });
    expect(ctx.oscillators.map((osc) => osc.type)).toEqual(['sine', 'sine']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      'undertone: this audio context has no createPeriodicWave(), so "pulsesine" falls back to a sine.'
    );
  });

  it('fades a stop with a straight ramp when a gain has no setTargetAtTime', () => {
    const ctx = new FakeAudioContext();
    const createGain = ctx.createGain.bind(ctx);
    ctx.createGain = () => {
      const gain = createGain();
      (gain.gain as { setTargetAtTime?: unknown }).setTargetAtTime = undefined;
      return gain;
    };
    const handle = playParams(ctx, [{ pitch: 'a4' }], { when: 0 });
    handle.stop(0.05, { fade: 0.02 });
    const calls = ctx.gains[0].gain.calls;
    const cancel = calls.findIndex((call) => call.method === 'cancelScheduledValues');
    expect(calls[cancel + 2]).toEqual({
      method: 'linearRampToValueAtTime',
      value: 0,
      time: expect.closeTo(0.07, 12)
    });
    expect(ctx.oscillators[0].stopped.at(-1)).toBeCloseTo(0.07, 12);
  });
});

describe('samples in both modules', () => {
  it('renders a registered buffer in the render module, registered before it loaded or after', async () => {
    const data = new Float32Array(400).fill(0.5);
    registerSample('early', { getChannelData: () => data });
    const first = await renderToBuffer(s('early'), { sampleRate: 8000, master: false, cycles: 1 });
    expect(first.getChannelData(0).some((x) => x !== 0)).toBe(true);
    registerSample('late', { getChannelData: () => data });
    const second = await renderToBuffer(s('late'), { sampleRate: 8000, master: false });
    expect(Array.from(second.getChannelData(0))).toEqual(Array.from(first.getChannelData(0)));
    clearSamples();
    const silent = await renderToBuffer(s('late'), { sampleRate: 8000, master: false });
    expect(silent.getChannelData(0).every((x) => x === 0)).toBe(true);
  });
});

describe('decoding a url or data sample when a voice first names it (as 0.3 did)', () => {
  /** Lets the fake decodes and fetches settle. */
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it('decodes only the sample a voice named, and plays it once decoded', async () => {
    const named = new ArrayBuffer(8);
    const other = new ArrayBuffer(4);
    registerSamples({ hat: { data: named }, tom: { data: other } });
    const ctx = new FakeAudioContext();
    const decode = vi.spyOn(ctx, 'decodeAudioData');
    playParams(ctx, [{ pitch: 'a3' }]);
    expect(decode).not.toHaveBeenCalled(); // a booking that names no sample decodes nothing
    playParams(ctx, [{ sampleName: 'hat' }, { sampleName: 'hat' }]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls[0][0]).toBe(named);
    expect(ctx.bufferSources).toHaveLength(0); // skipped while decoding, as in 0.3
    playParams(ctx, [{ sampleName: 'hat' }]); // joins the decode in flight
    expect(decode).toHaveBeenCalledTimes(1);
    await settle();
    playParams(ctx, [{ sampleName: 'hat' }]);
    expect(ctx.bufferSources).toHaveLength(1);
    expect(decode).toHaveBeenCalledTimes(1); // tom was never named, so never decoded
  });

  describe('on a second context that decodes the same source differently (another sample rate)', () => {
    /** A context whose decodes give `length` frames at `rate`, as a decode resampled to the context's rate does. */
    function resampling(rate: number, length: number) {
      const ctx = new FakeAudioContext();
      ctx.sampleRate = rate;
      const decoded: { buffer?: ReturnType<FakeAudioContext['createBuffer']> } = {};
      vi.spyOn(ctx, 'decodeAudioData').mockImplementation(async () => {
        decoded.buffer = ctx.createBuffer(1, length, rate);
        return decoded.buffer;
      });
      return { ctx, decoded };
    }

    it('plays the PCM the module holds, not the other context’s buffer that merely stands for it', async () => {
      registerSample('hat', { data: new ArrayBuffer(8) });
      const first = resampling(44100, 8);
      await loadSamples(first.ctx, ['hat']);
      const second = resampling(48000, 9);
      await loadSamples(second.ctx, ['hat']);
      expect(second.decoded.buffer).toBeDefined();

      playParams(first.ctx, [{ sampleName: 'hat' }]);
      expect(first.ctx.bufferSources[0].buffer).toBe(first.decoded.buffer); // its own decode, as before

      playParams(second.ctx, [{ sampleName: 'hat' }]);
      const played = second.ctx.bufferSources[0].buffer as { sampleRate: number } | null;
      expect(played).not.toBe(second.decoded.buffer); // a 9-frame buffer at 48 kHz is not the 8 frames the module holds
      expect(played?.sampleRate).toBe(44100);
      expect(
        (played as unknown as { getChannelData(c: number): Float32Array }).getChannelData(0)
      ).toHaveLength(8);
    });

    it('does not take a buffer with the same frames at another rate for the module’s PCM', async () => {
      registerSample('hat', { data: new ArrayBuffer(8) });
      const first = resampling(44100, 8);
      await loadSamples(first.ctx, ['hat']);
      const second = resampling(48000, 8);
      await loadSamples(second.ctx, ['hat']);
      playParams(second.ctx, [{ sampleName: 'hat' }]);
      const played = second.ctx.bufferSources[0].buffer as { sampleRate: number } | null;
      expect(played).not.toBe(second.decoded.buffer);
      expect(played?.sampleRate).toBe(44100);
    });
  });

  it('decodes the banked key a voice resolves to', async () => {
    registerSample('kit_sd', { data: new ArrayBuffer(4) });
    const ctx = new FakeAudioContext();
    const decode = vi.spyOn(ctx, 'decodeAudioData');
    s('sd').bank('kit').play({ ctx, when: 0 });
    expect(decode).toHaveBeenCalledTimes(1);
    await settle();
    s('sd').bank('kit').play({ ctx, when: 0 });
    expect(ctx.bufferSources).toHaveLength(1);
  });

  it("decodes in a loop's tick when the tick first names the sample", () => {
    registerSamples({ clap: { data: new ArrayBuffer(4) }, rim: { data: new ArrayBuffer(4) } });
    const ctx = new FakeAudioContext();
    const decode = vi.spyOn(ctx, 'decodeAudioData');
    const { timer, tick } = manualTimer();
    const looping = s('~ ~ ~ ~ ~ ~ ~ clap').loop({ ctx, timer, bpm: 240 });
    expect(decode).not.toHaveBeenCalled(); // the first window holds no clap
    for (let step = 1; step <= 40 && decode.mock.calls.length === 0; step += 1) {
      ctx.currentTime = step * 0.05;
      tick();
    }
    expect(decode).toHaveBeenCalledTimes(1); // the clap only: rim is registered but never named
    looping.stop({ voices: 'cut' });
  });

  it('retries a failed fetch the next time a voice names the sample, warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerSample('kick', { url: 'https://example.com/kick.wav' });
    const ctx = new FakeAudioContext();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4))
      } as Response);
    playParams(ctx, [{ sampleName: 'kick' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await settle();
    expect(warn).toHaveBeenCalledWith('undertone: sample "kick" failed to load — voice skipped.');
    playParams(ctx, [{ sampleName: 'kick' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await settle();
    playParams(ctx, [{ sampleName: 'kick' }]);
    expect(ctx.bufferSources).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('encodeWav', () => {
  it('encodes synchronously in TypeScript, without the render module', () => {
    const bytes = encodeWav({ sampleRate: 8000, channels: [new Float32Array([0, 0.5, -0.5])] });
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(bytes.length).toBe(44 + 6);
  });

  it('reads a plain array as samples, as 0.3 did', () => {
    const bytes = encodeWav(
      { sampleRate: 8000, channels: [[0, 0.5] as unknown as Float32Array] },
      { dither: false }
    );
    expect(bytes.length).toBe(44 + 4);
  });

  it('refuses a bit depth 0.3 never allowed, after the channel checks', () => {
    const source = { sampleRate: 8000, channels: [new Float32Array(2)] };
    expect(() => encodeWav(source, { bitDepth: 8 as 16 })).toThrow(
      'encodeWav: bitDepth must be 16, 24 or 32, got 8'
    );
    expect(() => encodeWav({ sampleRate: 8000, channels: [] }, { bitDepth: 8 as 16 })).toThrow(
      'encodeWav: the source has no channels'
    );
  });
});
