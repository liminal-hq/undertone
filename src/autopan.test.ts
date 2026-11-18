// Tests for autopan and the pan slide: the LFO's nodes, connections and calls, phases, stops, laws and scores
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { note } from './control';
import { playVoice, resolveParams } from './engine';
import { Fraction } from './fraction';
import { score } from './score';
import { FakeAudioContext, FakePeriodicWave, recordedGraph } from './test-utils/fakeAudioContext';
import type { ControlPatch } from './types';
import { resetWarnings } from './warn';

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
});

/** One voice on a fresh fake context. */
function voice(patch: ControlPatch, start = 1) {
  const ctx = new FakeAudioContext();
  const handle = playVoice(ctx, resolveParams({ pitch: 'a4', ...patch }), start);
  return { ctx, handle };
}

describe('autopan', () => {
  it('adds nothing without an autopan rate', () => {
    const plain = { pitch: 'a4', pan: 0.25 };
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ ...plain, autopanDepth: 0.5, autopanShape: 'square' }), 0);
    const reference = new FakeAudioContext();
    playVoice(reference, resolveParams(plain), 0);
    expect(recordedGraph(ctx)).toEqual(recordedGraph(reference));
    // Not a positive rate is no rate.
    expect(voice({ autopan: 0 }).ctx.oscillators).toHaveLength(1);
  });

  it('is an oscillator into a depth gain into the panner pan, started and stopped with the voice', () => {
    const { ctx, handle } = voice({ pan: -0.25, autopan: 2, autopanDepth: 0.5, release: 0.5 });

    const [source, lfo] = ctx.oscillators;
    const [panner] = ctx.panners;
    const depth = ctx.gains[1];
    expect(ctx.oscillators).toHaveLength(2);
    expect(lfo.type).toBe('sine');
    expect(lfo.frequency.calls).toEqual([{ method: 'setValueAtTime', value: 2, time: 1 }]);
    expect(lfo.connectedTo).toEqual([depth]);
    expect(depth.gain.calls).toEqual([{ method: 'setValueAtTime', value: 0.5, time: 1 }]);
    expect(depth.connectedTo).toEqual([panner.pan]);
    // The booked pan is the centre of the swing.
    expect(panner.pan.calls).toEqual([{ method: 'setValueAtTime', value: -0.25, time: 1 }]);
    expect(ctx.gains[0].connectedTo).toEqual([panner]);
    expect(panner.connectedTo).toEqual([ctx.destination]);
    // It runs through the release, as long as the voice's own source.
    expect(lfo.started).toEqual([1]);
    expect(lfo.stopped).toEqual(source.stopped);
    expect(handle.endTime).toBe(source.stopped[0]);
  });

  it('creates the panner at the centre without a pan, at full depth by default', () => {
    const { ctx } = voice({ autopan: 4 });
    expect(ctx.panners[0].pan.calls).toEqual([{ method: 'setValueAtTime', value: 0, time: 1 }]);
    expect(ctx.gains[1].gain.calls).toEqual([{ method: 'setValueAtTime', value: 1, time: 1 }]);
  });

  it('clamps the depth, wraps the phase and treats an unknown shape as a sine in voice data', () => {
    const { ctx } = voice({
      autopan: 1,
      autopanDepth: 3,
      autopanShape: 'saw' as 'sine',
      autopanPhase: 1.25
    });
    expect(ctx.gains[1].gain.calls[0]).toMatchObject({ value: 1 });
    expect(ctx.oscillators[1].type).toBe('custom'); // phase 0.25 needs a periodic wave
    expect(ctx.periodicWaves[0].real[1]).toBeCloseTo(1, 6); // a sine a quarter in: a cosine
    expect(ctx.periodicWaves[0].imag[1]).toBeCloseTo(0, 6);
  });

  it('uses the built-in wave for each shape at phase 0', () => {
    for (const shape of ['sine', 'triangle', 'square'] as const) {
      const { ctx } = voice({ autopan: 1, autopanShape: shape });
      expect(ctx.oscillators[1].type).toBe(shape);
      expect(ctx.periodicWaves).toHaveLength(0);
    }
  });

  it('turns every harmonic of a shifted triangle or square by its share of the phase', () => {
    const { ctx } = voice({ autopan: 1, autopanShape: 'square', autopanPhase: 0.5 });
    const wave = ctx.periodicWaves[0] as FakePeriodicWave;
    expect(wave.real).toHaveLength(65);
    expect(wave.constraints).toBeUndefined(); // normalized, as the built-in waves are
    // Half a cycle: odd harmonics flip sign, so the square starts on the left.
    expect(wave.imag[1]).toBeCloseTo(-4 / Math.PI, 5);
    expect(wave.imag[3]).toBeCloseTo(-4 / (3 * Math.PI), 5);
    expect(wave.imag[2]).toBeCloseTo(0, 6);
    expect(Math.max(...Array.from(wave.real).map(Math.abs))).toBeLessThan(1e-5);
  });

  it('drops the phase, warning once, without createPeriodicWave', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeAudioContext({ noPeriodicWave: true });
    playVoice(ctx, resolveParams({ pitch: 'a4', autopan: 1, autopanPhase: 0.3 }), 0);
    playVoice(ctx, resolveParams({ pitch: 'a4', autopan: 1, autopanPhase: 0.3 }), 0);
    expect(ctx.oscillators[1].type).toBe('sine');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('adds to a pan path, which sets the centre', () => {
    const { ctx } = voice({
      autopan: 3,
      panPath: [
        { time: 0, pan: -1 },
        { time: 1, pan: 1 }
      ]
    });
    const [panner] = ctx.panners;
    expect(panner.pan.calls).toEqual([
      { method: 'setValueAtTime', value: -1, time: 1 },
      { method: 'linearRampToValueAtTime', value: 1, time: 2 }
    ]);
    expect(ctx.gains[1].connectedTo).toEqual([panner.pan]);
  });

  it('stops with the voice on an early stop, after the fade', () => {
    const { ctx, handle } = voice({ autopan: 2, sustain: 1, duration: 4 });
    handle.stop(2, { fade: 0.1 });
    expect(ctx.oscillators[1].stopped.at(-1)).toBeCloseTo(2.1, 9);
    expect(ctx.oscillators[0].stopped.at(-1)).toBeCloseTo(2.1, 9);
  });

  it('sends the room and delay from the panner, so the wet signal swings too', () => {
    const { ctx } = voice({ autopan: 2, delayLevel: 0.3 });
    const send = ctx.panners[0].connectedTo[1] as (typeof ctx.gains)[number];
    expect(send.gain.calls[0]).toMatchObject({ value: 0.3 });
  });

  it('lets channelGains take precedence', () => {
    const plain = { pitch: 'a4', channelGains: [0.5, 1] };
    const ctx = new FakeAudioContext();
    playVoice(ctx, resolveParams({ ...plain, autopan: 2, panSlideFrom: -1 }), 0);
    const reference = new FakeAudioContext();
    playVoice(reference, resolveParams(plain), 0);
    expect(recordedGraph(ctx)).toEqual(recordedGraph(reference));
  });

  it('keeps the panner under a pan law: scaled exactly below -3 dB, the panner law above', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const quiet = voice({ autopan: 2, pan: 0.5, panLaw: -6 }).ctx;
    expect(quiet.mergers).toHaveLength(0);
    const level = quiet.gains[2];
    expect(quiet.panners[0].connectedTo).toEqual([level]);
    expect(level.gain.calls).toEqual([
      { method: 'setValueAtTime', value: Math.SQRT2 * 10 ** (-6 / 20), time: 1 }
    ]);
    expect(level.connectedTo).toEqual([quiet.destination]);

    const loud = voice({ autopan: 2, pan: 0.5, panLaw: 0 }).ctx;
    expect(loud.panners[0].connectedTo).toEqual([loud.destination]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('keeps the stereo panner');
  });

  it('is set by autopan(), autopandepth(), autopanshape() and autopanphase(), which check their values', () => {
    const [hap] = note('a4')
      .autopan('3')
      .autopandepth(0.4)
      .autopanshape('triangle')
      .autopanphase(0.75)
      .query({ begin: new Fraction(0), end: new Fraction(1) });
    expect(hap.value).toMatchObject({
      autopan: 3,
      autopanDepth: 0.4,
      autopanShape: 'triangle',
      autopanPhase: 0.75
    });
    expect(() => note('a4').autopan(0)).toThrow('autopan() rate must be positive, got 0');
    expect(() => note('a4').autopan('1 -2')).toThrow('autopan() rate must be positive, got -2');
    expect(() => note('a4').autopandepth(1.5)).toThrow(
      'autopandepth() must be between 0 and 1, got 1.5'
    );
    expect(() => note('a4').autopanshape('saw' as 'sine')).toThrow(
      'autopanshape() must be sine, triangle or square, got saw'
    );
    expect(() => note('a4').autopanphase(-0.1)).toThrow(
      'autopanphase() must be between 0 and 1, got -0.1'
    );
  });
});

describe('panslide', () => {
  it("ramps from the start pan to the voice's pan over its attack", () => {
    const { ctx } = voice({ pan: 0.5, attack: 0.2, panSlideFrom: -1 });
    expect(ctx.panners[0].pan.calls).toEqual([
      { method: 'setValueAtTime', value: -1, time: 1 },
      { method: 'linearRampToValueAtTime', value: 0.5, time: 1.2 }
    ]);
  });

  it('takes its own time, slides to the centre without a pan, and holds on an early stop', () => {
    const { ctx, handle } = voice({ panSlideFrom: 1, panSlideTime: 1, sustain: 1, duration: 2 });
    handle.stop(1.5);
    expect(ctx.panners[0].pan.calls).toEqual([
      { method: 'setValueAtTime', value: 1, time: 1 },
      { method: 'linearRampToValueAtTime', value: 0, time: 2 },
      { method: 'cancelScheduledValues', time: 1.5 },
      { method: 'linearRampToValueAtTime', value: 0.5, time: 1.5 }
    ]);
  });

  it('gives way to a pan path, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx } = voice({ panSlideFrom: 1, panPath: [{ time: 0, pan: -0.5 }] });
    expect(ctx.panners[0].pan.calls).toEqual([{ method: 'setValueAtTime', value: -0.5, time: 1 }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is the centre of an autopan, and follows a pan law', () => {
    const swinging = voice({ panSlideFrom: -1, autopan: 1 }).ctx;
    expect(swinging.panners[0].pan.calls).toHaveLength(2);
    expect(swinging.gains[1].connectedTo).toEqual([swinging.panners[0].pan]);
    const lawful = voice({ panSlideFrom: -1, pan: 1, panLaw: 0, attack: 0.5 }).ctx;
    expect(lawful.mergers).toHaveLength(1);
    expect(lawful.gains[1].gain.calls[0]).toMatchObject({ method: 'setValueAtTime', value: 1 });
  });

  it('is set by panslide(), which checks its start and time', () => {
    const [hap] = note('a4')
      .panslide('-1', 0.3)
      .query({ begin: new Fraction(0), end: new Fraction(1) });
    expect(hap.value).toMatchObject({ panSlideFrom: -1, panSlideTime: 0.3 });
    expect(() => note('a4').panslide(2)).toThrow(
      'panslide() start must be between -1 and 1, got 2'
    );
    expect(() => note('a4').panslide(0, -1)).toThrow(
      'panslide() time must be zero or more seconds, got -1'
    );
  });
});

describe('score() autopan', () => {
  const haps = (events: Parameters<typeof score>[0]['events']) =>
    score({ ticksPerSecond: 100, lengthTicks: 400, events }).pattern.query({
      begin: new Fraction(0),
      end: new Fraction(1)
    });

  it('carries a period in ticks into a rate in Hz, with the depth, shape and phase', () => {
    const [hap] = haps([
      {
        tick: 0,
        note: 'c4',
        pan: 0.2,
        autopan: { periodTicks: 50, depth: 0.6, shape: 'square', phase: 0.5 }
      }
    ]);
    expect(hap.value).toMatchObject({
      pan: 0.2,
      autopan: 2,
      autopanDepth: 0.6,
      autopanShape: 'square',
      autopanPhase: 0.5
    });
    const [plain] = haps([{ tick: 0, note: 'c4', autopan: { periodTicks: 400, depth: 1 } }]);
    expect(plain.value.autopanShape).toBeUndefined();
    expect(plain.value.autopanPhase).toBeUndefined();
  });

  it('checks the period, depth, shape and phase', () => {
    expect(() => haps([{ tick: 0, note: 'c4', autopan: { periodTicks: 0.5, depth: 1 } }])).toThrow(
      'score() autopan periodTicks must be an integer of at least 1, got 0.5'
    );
    expect(() => haps([{ tick: 8, note: 'c4', autopan: { periodTicks: 10, depth: 2 } }])).toThrow(
      'score() autopan depth must be between 0 and 1, got 2 (event at tick 8)'
    );
    expect(() =>
      haps([
        { tick: 0, note: 'c4', autopan: { periodTicks: 10, depth: 1, shape: 'saw' as 'sine' } }
      ])
    ).toThrow('score() autopan shape must be sine, triangle or square, got saw (event at tick 0)');
    expect(() =>
      haps([{ tick: 0, note: 'c4', autopan: { periodTicks: 10, depth: 1, phase: 1.5 } }])
    ).toThrow('score() autopan phase must be between 0 and 1, got 1.5 (event at tick 0)');
  });
});
