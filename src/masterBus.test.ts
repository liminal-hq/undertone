// Tests for the opt-in master bus: graph shape, limiter settings, and the surround and fallback guards
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { note } from './control';
import { createMasterBus } from './masterBus';
import { FakeAudioContext } from './test-utils/fakeAudioContext';
import { resetWarnings } from './warn';

/** The value of the first automation call recorded on a fake param. */
const firstValue = (param: unknown): number =>
  (param as { calls: { value: number }[] }).calls[0].value;

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
});

describe('createMasterBus', () => {
  it('connects gain -> limiter -> makeup compensation -> destination, creating nothing else', () => {
    const ctx = new FakeAudioContext();

    const bus = createMasterBus(ctx);

    const [, makeup] = ctx.gains;
    expect(ctx.gains).toHaveLength(2);
    expect(ctx.gains[0]).toBe(bus.input);
    expect(ctx.compressors).toEqual([bus.compressor]);
    expect(bus.input.connectedTo).toEqual([bus.compressor]);
    expect(bus.compressor?.connectedTo).toEqual([makeup]);
    expect(makeup.connectedTo).toEqual([ctx.destination]);
  });

  it("takes back the compressor's automatic makeup gain, so peaks are not pushed up", () => {
    const ctx = new FakeAudioContext();

    createMasterBus(ctx); // threshold -2 dB, ratio 20: a full-scale input leaves at -1.9 dB

    // makeup = (1 / 10^(-1.9/20)) ^ 0.6 ~ 1.1405, so the compensation is its reciprocal.
    expect(firstValue(ctx.gains[1].gain)).toBeCloseTo(1 / 1.1405, 3);
  });

  it('computes compensation from the tuned threshold and ratio, and can be turned off', () => {
    const tuned = new FakeAudioContext();
    const off = new FakeAudioContext();

    createMasterBus(tuned, { limiter: { threshold: -12, ratio: 4 } });
    const bus = createMasterBus(off, { limiter: { compensate: false } });

    // -12 dB threshold, ratio 4: full scale leaves at -9 dB; makeup = (10^(9/20)) ^ 0.6.
    expect(firstValue(tuned.gains[1].gain)).toBeCloseTo(10 ** ((-9 / 20) * 0.6) * 1, 3);
    expect(off.gains).toEqual([bus.input]);
    expect(bus.compressor?.connectedTo).toEqual([off.destination]);
  });

  it('applies the default limiter settings at the current time', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 5;

    const { compressor } = createMasterBus(ctx);

    expect(compressor?.threshold).toMatchObject({
      calls: [{ method: 'setValueAtTime', value: -2, time: 5 }]
    });
    expect(firstValue(compressor?.ratio)).toBe(20);
    expect(firstValue(compressor?.attack)).toBe(0.003);
    expect(firstValue(compressor?.release)).toBe(0.1);
  });

  it('takes a level, a custom output and tuned limiter settings', () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();

    const { input, compressor } = createMasterBus(ctx, {
      output: out,
      gain: 0.6,
      limiter: { threshold: -6, ratio: 10, release: 0.3 }
    });

    expect(firstValue(input.gain)).toBe(0.6);
    expect(ctx.gains.at(-1)?.connectedTo).toEqual([out]); // via the makeup compensation
    expect(firstValue(compressor?.threshold)).toBe(-6);
    expect(firstValue(compressor?.ratio)).toBe(10);
    expect(firstValue(compressor?.release)).toBe(0.3);
    expect(firstValue(compressor?.knee)).toBe(0); // untouched defaults still apply
  });

  it('is gain only when the limiter is turned off', () => {
    const ctx = new FakeAudioContext();

    const bus = createMasterBus(ctx, { limiter: false });

    expect(bus.compressor).toBeUndefined();
    expect(ctx.compressors).toHaveLength(0);
    expect(bus.input.connectedTo).toEqual([ctx.destination]);
  });

  it('skips the limiter above two channels so surround is not folded to stereo', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeAudioContext();
    ctx.destination.channelCount = 6;

    const bus = createMasterBus(ctx);

    expect(bus.compressor).toBeUndefined();
    expect(bus.input.connectedTo).toEqual([ctx.destination]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('6 channels');
  });

  it('falls back to gain only, warning once, without createDynamicsCompressor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeAudioContext({ noCompressor: true });

    const first = createMasterBus(ctx);
    createMasterBus(ctx);

    expect(first.compressor).toBeUndefined();
    expect(first.input.connectedTo).toEqual([ctx.destination]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a negative gain', () => {
    expect(() => createMasterBus(new FakeAudioContext(), { gain: -1 })).toThrow(
      /must not be negative/
    );
  });

  it('works as the output of a pattern, so voices reach the destination only through it', () => {
    const ctx = new FakeAudioContext();
    const bus = createMasterBus(ctx);

    note('a4').play({ ctx, when: 0, output: bus.input });

    expect(ctx.gains[2].connectedTo).toEqual([bus.input]);
    expect(ctx.destination.connectedTo).toEqual([]);
  });
});
