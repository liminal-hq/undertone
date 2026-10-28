// Tests for playback handles, early stopping, custom output routing, and playParams()
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { getOrbitBus } from './effects';
import { playParams, playVoice, playVoices, resolveParams } from './engine';
import { note } from './control';
import type { TimerLike } from './scheduler';
import { FakeAudioContext } from './test-utils/fakeAudioContext';
import type { VoiceParams } from './types';

class FakeTimer implements TimerLike {
  callback: (() => void) | undefined;
  cleared = false;

  setInterval(callback: () => void): unknown {
    this.callback = callback;
    return 'interval-handle';
  }

  clearInterval(): void {
    this.cleared = true;
  }

  tick(): void {
    this.callback?.();
  }
}

// Default envelope: attack 0.01 -> decay 0.1 (to 0) -> release 0.05, so voiceEnd = 0.16 + 0.02.
const VOICE_END = 0.18;

describe('playVoice handle', () => {
  it('reports the voice time window', () => {
    const ctx = new FakeAudioContext();

    const handle = playVoice(ctx, resolveParams({ pitch: 'a4', nudgeTime: 0.5 }), 1);

    expect(handle.startTime).toBe(1.5);
    expect(handle.endTime).toBeCloseTo(1.5 + VOICE_END);
  });

  it('fades from the envelope level when stopped mid-attack, then stops the source after the fade', () => {
    const ctx = new FakeAudioContext();
    const handle = playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);

    handle.stop(0.005);

    const calls = ctx.gains[0].gain.calls;
    expect(calls.slice(-3)).toEqual([
      { method: 'cancelScheduledValues', time: 0.005 },
      { method: 'setValueAtTime', value: expect.closeTo(0.4), time: 0.005 },
      { method: 'setTargetAtTime', value: 0, time: 0.005, timeConstant: expect.closeTo(0.002) }
    ]);
    expect(ctx.oscillators[0].stopped).toEqual([expect.closeTo(VOICE_END), expect.closeTo(0.015)]);
  });

  it('honours a custom fade, and a zero fade cuts at once', () => {
    const ctx = new FakeAudioContext();
    const faded = playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);
    const cut = playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);

    faded.stop(0.05, { fade: 0.05 });
    cut.stop(0.05, { fade: 0 });

    expect(ctx.oscillators[0].stopped.at(-1)).toBeCloseTo(0.1);
    expect(ctx.gains[1].gain.calls.slice(-2)).toEqual([
      { method: 'setValueAtTime', value: expect.any(Number), time: 0.05 },
      { method: 'setValueAtTime', value: 0, time: 0.05 }
    ]);
    expect(ctx.oscillators[1].stopped.at(-1)).toBe(0.05);
  });

  it('silences a voice that has not started yet', () => {
    const ctx = new FakeAudioContext();
    const handle = playVoice(ctx, resolveParams({ pitch: 'a4' }), 1);

    handle.stop(0.5);

    const calls = ctx.gains[0].gain.calls;
    expect(calls[calls.length - 3]).toEqual({ method: 'cancelScheduledValues', time: 0.5 });
    expect(calls[calls.length - 2]).toEqual({ method: 'setValueAtTime', value: 0, time: 0.5 });
    expect(ctx.oscillators[0].stopped.at(-1)).toBeLessThan(1);
  });

  it('leaves an already-finished voice alone', () => {
    const ctx = new FakeAudioContext();
    const handle = playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);
    const callCount = ctx.gains[0].gain.calls.length;

    handle.stop(5);

    expect(ctx.gains[0].gain.calls).toHaveLength(callCount);
    expect(ctx.oscillators[0].stopped).toHaveLength(1);
  });

  it('evaluates a held envelope at its sustain level', () => {
    const ctx = new FakeAudioContext();
    const handle = playVoice(
      ctx,
      resolveParams({ pitch: 'a4', sustain: 0.5, duration: 1, gainLevel: 0.8 }),
      0
    );

    handle.stop(0.5);

    expect(
      ctx.gains[0].gain.calls.find((c) => c.method === 'setValueAtTime' && c.time === 0.5)
    ).toMatchObject({ value: expect.closeTo(0.4) });
  });

  it('also stops the phaser LFO', () => {
    const ctx = new FakeAudioContext();
    const handle = playVoice(ctx, resolveParams({ pitch: 'a4', phaserRate: 1 }), 0);

    handle.stop(0.05);

    const [, lfo] = ctx.oscillators;
    expect(lfo.stopped.at(-1)).toBeCloseTo(0.06);
  });

  it('falls back to a hard source stop when the params cannot cancel automation', () => {
    const ctx = new FakeAudioContext({ bareParams: true });
    const handle = playVoice(ctx, resolveParams({ pitch: 'a4' }), 0);
    const callCount = ctx.gains[0].gain.calls.length;

    handle.stop(0.05);

    expect(ctx.gains[0].gain.calls).toHaveLength(callCount);
    expect(ctx.oscillators[0].stopped).toEqual([expect.closeTo(VOICE_END), 0.05]);
  });

  it('returns an inert handle for a sample voice that was skipped', () => {
    const ctx = new FakeAudioContext();

    const handle = playVoice(ctx, resolveParams({ sampleName: 'never-registered' }), 2);

    expect(handle.startTime).toBe(handle.endTime);
    expect(() => handle.stop(2)).not.toThrow();
  });
});

describe('playVoices and playParams', () => {
  it('combines voices into one handle covering all of them', () => {
    const ctx = new FakeAudioContext();

    const handle = playVoices(
      ctx,
      [resolveParams({ pitch: 'a4' }), resolveParams({ pitch: 'c5', release: 1 })],
      1
    );
    handle.stop(1.01);

    expect(handle.startTime).toBe(1);
    expect(handle.endTime).toBeGreaterThan(2);
    expect(ctx.oscillators.map((osc) => osc.stopped.length)).toEqual([2, 2]);
  });

  it('plays plain voice data with defaults filled in', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 4;

    playParams(ctx, [{ soundType: 'square', pitch: 'a4' }, { pitch: 'c5' }]);

    expect(ctx.oscillators.map((osc) => osc.type)).toEqual(['square', 'sine']);
    expect(ctx.oscillators.map((osc) => osc.started[0])).toEqual([4, 4]);
  });

  it('sounds the same after a JSON round trip, so saved voice data stays valid', () => {
    const voices = [resolveParams({ soundType: 'sawtooth', pitch: 'e3', filterCutoff: 800 })];
    const direct = new FakeAudioContext();
    const saved = new FakeAudioContext();

    playParams(direct, voices, { when: 0 });
    playParams(saved, JSON.parse(JSON.stringify(voices)), { when: 0 });

    expect(saved.oscillators[0].frequency.calls).toEqual(direct.oscillators[0].frequency.calls);
    expect(saved.filters[0].frequency.calls).toEqual(direct.filters[0].frequency.calls);
    expect(saved.gains[0].gain.calls).toEqual(direct.gains[0].gain.calls);
  });

  it('builds the same graph from a frozen full VoiceParams literal as from defaults', () => {
    const literal: VoiceParams = Object.freeze({
      soundType: 'sine',
      pitch: 'a4',
      gainLevel: 0.8,
      attack: 0.01,
      decay: 0.1,
      sustain: 0,
      release: 0.05,
      filterEnvAmount: 0,
      filterAttack: 0,
      filterDecay: 0,
      filterSustain: 1,
      filterRelease: 0,
      roomSize: 3,
      delayTime: 0.3,
      delayFeedback: 0.35,
      slideTime: 0,
      nudgeTime: 0
    });
    const ctx = new FakeAudioContext();

    playParams(ctx, [literal], { when: 0 });

    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.oscillators[0].connectedTo).toEqual([ctx.gains[0]]);
    expect(ctx.gains[0].connectedTo).toEqual([ctx.destination]);
  });
});

describe('output routing', () => {
  it('connects the plain path to a custom output instead of the destination', () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();

    playVoice(ctx, resolveParams({ pitch: 'a4' }), 0, { output: out });

    expect(ctx.gains[1].connectedTo).toEqual([out]);
    expect(ctx.destination.connectedTo).toEqual([]);
  });

  it('connects the panner path to a custom output', () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();

    playVoice(ctx, resolveParams({ pitch: 'a4', pan: -0.5 }), 0, { output: out });

    expect(ctx.panners[0].connectedTo).toEqual([out]);
  });

  it('connects the channel merger path to a custom output', () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();

    playVoice(ctx, resolveParams({ pitch: 'a4', channelGains: [1, 0.5] }), 0, { output: out });

    expect(ctx.mergers[0].connectedTo).toEqual([out]);
  });

  it('routes effect buses to the custom output, one bus per (context, output, orbit)', () => {
    const ctx = new FakeAudioContext();
    const outA = ctx.createGain();
    const outB = ctx.createGain();
    const params = resolveParams({ pitch: 'a4', roomLevel: 0.3, delayLevel: 0.3 });

    playVoice(ctx, params, 0, { output: outA });
    playVoice(ctx, params, 1, { output: outA });
    expect(ctx.convolvers).toHaveLength(1);
    expect(ctx.convolvers[0].connectedTo).toEqual([outA]);

    playVoice(ctx, params, 2, { output: outB });
    expect(ctx.convolvers).toHaveLength(2);
    expect(ctx.convolvers[1].connectedTo).toEqual([outB]);
    expect(getOrbitBus(ctx, 0, outA)).not.toBe(getOrbitBus(ctx, 0, outB));
    expect(getOrbitBus(ctx, 0)).not.toBe(getOrbitBus(ctx, 0, outA));
  });

  it('passes output through pattern play() and loop()', () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();

    note('c3').play({ ctx, output: out });
    note('e3').loop({ ctx, output: out, timer: new FakeTimer() });

    expect(ctx.gains[1].connectedTo).toEqual([out]);
    expect(ctx.gains[2].connectedTo).toEqual([out]);
  });
});

describe('pattern play handle and cps', () => {
  it('returns a handle covering every onset that can stop them all', () => {
    const ctx = new FakeAudioContext();

    const handle = note('c3 e3').play({ ctx, when: 0 }); // 2-second cycle

    expect(handle.startTime).toBe(0);
    expect(handle.endTime).toBeCloseTo(1 + VOICE_END);
    handle.stop(0.01);
    expect(ctx.oscillators.map((osc) => osc.stopped.length)).toEqual([2, 2]);
  });

  it('returns an inert handle for an empty pattern', () => {
    const ctx = new FakeAudioContext();

    const handle = note('~').play({ ctx, when: 3 });

    expect(handle.startTime).toBe(3);
    expect(handle.endTime).toBe(3);
  });

  it('takes a tempo in cycles per second', () => {
    const ctx = new FakeAudioContext();

    note('c3 e3').play({ ctx, when: 0, cps: 4 });

    expect(ctx.oscillators.map((osc) => osc.started[0])).toEqual([0, 0.125]);
  });

  it('rejects both bpm and cps, and a non-positive cps', () => {
    const ctx = new FakeAudioContext();

    expect(() => note('c3').play({ ctx, bpm: 120, cps: 1 })).toThrow(/either bpm or cps/);
    expect(() => note('c3').play({ ctx, cps: 0 })).toThrow(/cps must be positive/);
  });
});

describe('loop stop', () => {
  it('plain stop() keeps ringing voices and only clears the timer', () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    const handle = note('c3').loop({ ctx, timer });

    handle.stop();

    expect(timer.cleared).toBe(true);
    expect(ctx.oscillators[0].stopped).toHaveLength(1);
  });

  it("stop({ voices: 'cut' }) fades live and booked voices but not finished ones", () => {
    const ctx = new FakeAudioContext();
    const timer = new FakeTimer();
    // One note per 2-second cycle; the loop starts 0.1s after `now`.
    const handle = note('c3').loop({ ctx, timer });
    ctx.currentTime = 2.05;
    timer.tick(); // books the cycle-1 onset at 2.1s, still in the future
    ctx.currentTime = 2.09;

    handle.stop({ voices: 'cut', fade: 0.02 });

    expect(timer.cleared).toBe(true);
    const [finished, booked] = ctx.oscillators;
    expect(finished.stopped).toHaveLength(1); // ended before the cut, untouched
    expect(booked.stopped).toHaveLength(2);
    expect(booked.stopped.at(-1)).toBeCloseTo(2.11);
  });
});
