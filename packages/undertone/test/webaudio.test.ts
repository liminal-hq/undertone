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
  note,
  playParams,
  registerSample,
  renderToBuffer,
  resetTempo,
  s,
  setcpm,
  sound
} from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';
import * as wasm from '@liminal-hq/undertone/wasm';
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
