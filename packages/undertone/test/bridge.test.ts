// Tests of what the wrapper adds around part 2a's exports: the live constants, scores, warnings, and the refusals only it can make
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_ORDER,
  Fraction,
  MAX_CHANNELS,
  Pattern,
  SHAPED_WAVE_TYPES,
  drift,
  fmPresets,
  fmVoice,
  foldToStereo,
  isShapedWave,
  layer,
  n,
  note,
  pure,
  resolveParams,
  sine,
  score,
  surroundGains
} from '@liminal-hq/undertone';
import { playVoice, resetWarnings } from '@liminal-hq/undertone/testing';
import * as wasm from '@liminal-hq/undertone/wasm';

const cycle = (pattern: Pattern<unknown>) =>
  pattern.query({ begin: new Fraction(0), end: new Fraction(1) });

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
});

describe('the constants read from the module', () => {
  it('are the module values, as live bindings that are set once an entry has loaded it', () => {
    expect(CHANNEL_ORDER).toEqual(wasm.channelOrder());
    expect(CHANNEL_ORDER).toEqual(['FL', 'FR', 'C', 'LFE', 'SL', 'SR', 'RL', 'RR']);
    expect(MAX_CHANNELS).toBe(8);
    expect(SHAPED_WAVE_TYPES).toEqual(['halfsine', 'abssine', 'pulsesine']);
    expect(isShapedWave('halfsine')).toBe(true);
    expect(isShapedWave('sine')).toBe(false);
  });

  it('give fmPresets frozen, with its keys in alphabetical order (a break)', () => {
    expect(Object.keys(fmPresets)).toEqual(['glassBell', 'lead', 'pluck', 'roundBass', 'softPad']);
    expect(Object.isFrozen(fmPresets)).toBe(true);
    for (const preset of Object.values(fmPresets)) expect(Object.isFrozen(preset)).toBe(true);
    expect(fmPresets.glassBell.fmHarmonicity).toBe(3.5);
  });

  it('give plain arrays from the channel helpers', () => {
    expect(surroundGains(0)).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
    expect(foldToStereo([1, 0, 0, 0, 0, 0, 0, 0])).toHaveLength(2);
  });
});

describe('instruments', () => {
  it('turn a Tone-shaped definition into a patch and layer it', () => {
    const patch = fmVoice({ harmonicity: 2, modulationIndex: 4, level: 0.5 });
    expect(patch).toMatchObject({ fmHarmonicity: 2, fmIndex: 2, gainLevel: 0.5 });
    const events = cycle(layer(note('c4'), [patch, fmPresets.pluck], { stagger: 0.01 }));
    expect(events.map((hap) => (hap.value as { nudgeTime?: number }).nudgeTime)).toEqual([0, 0.01]);
  });

  it('refuse bad input with the reference messages', () => {
    expect(() => layer(note('c4'), [])).toThrow('layer() needs at least one voice');
    expect(() => fmVoice({ harmonicity: -1 })).toThrow(
      'fmVoice() harmonicity must be positive, got -1'
    );
  });
});

describe('score', () => {
  const definition = { ticksPerSecond: 560, lengthTicks: 1120, events: [{ tick: 0, note: 'c4' }] };

  it('has the pattern, tempo, and length of the reference', () => {
    const compiled = score(definition);
    expect(compiled.pattern).toBeInstanceOf(Pattern);
    expect(compiled.cps).toBe(0.5);
    expect(compiled.seconds).toBe(2);
    expect(cycle(compiled.pattern)).toHaveLength(1);
  });

  it('says plainly that play, loop, and render wait for the engine exports', () => {
    const compiled = score(definition);
    for (const method of ['play', 'loop', 'render'] as const) {
      expect(() => compiled[method]()).toThrow(/not available until the engine exports land/);
    }
  });

  it('refuses a bad definition with the reference messages', () => {
    expect(() => score({ ...definition, ticksPerSecond: 0 })).toThrow(
      'score() ticksPerSecond must be positive, got 0'
    );
    expect(() => score({ ...definition, events: [{ tick: 2000, note: 'c4' }] })).toThrow(
      'score() event tick 2000 is outside the cue (length 1120)'
    );
  });
});

describe('drift and resolveParams', () => {
  it('drift is repeatable for a seed and reports a bad range as the reference does', () => {
    const a = cycle(drift(note('c4 e4'), { seed: 'x', timing: 0.01 }));
    const b = cycle(drift(note('c4 e4'), { seed: 'x', timing: 0.01 }));
    expect(a.map((hap) => hap.value)).toEqual(b.map((hap) => hap.value));
    expect(() => drift(note('c4'), { seed: 1, timing: -1 })).toThrow(
      'drift() timing must not be negative, got -1'
    );
  });

  it('resolveParams returns a plain object with the defaults filled in', () => {
    const resolved = resolveParams({ pitch: 440 });
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    expect(resolved).toMatchObject({ pitch: 440, gainLevel: 0.8, soundType: 'sine' });
  });
});

describe('refusals that only the wrapper can make', () => {
  const plain = (name: string) =>
    `${name}() takes a plain value, not a pattern; it cannot change from event to event`;

  it('a list control or the seconds of panslide given a pattern', () => {
    expect(() => note('c4').channels(pure(1) as never)).toThrow(plain('channels'));
    expect(() => note('c4').pitchsteps(pure(1) as never)).toThrow(plain('pitchsteps'));
    expect(() => note('c4').panpath(pure(1) as never)).toThrow(plain('panpath'));
    expect(() => note('c4').panslide(0, pure(1) as never)).toThrow(plain('panslide'));
  });

  it('a plain-value control given a pattern (refused in Rust, with the same message)', () => {
    expect(() => note('c4').cut(sine as never)).toThrow(plain('cut'));
    expect(() => note('c4').orbit(pure(1) as never)).toThrow(plain('orbit'));
  });

  it('a patternable control given nothing', () => {
    expect(() => note('c4').gain(undefined as never)).toThrow(
      'gain() needs a number, a mini-notation string, or a pattern, got undefined'
    );
  });

  it('n() given a signal without events', () => {
    expect(() => n(sine)).toThrow('n() needs events: call .segment(n) on a signal first');
  });
});

describe('warnings', () => {
  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('print from the module with console.warn, once per key, until resetWarnings()', () => {
    const spy = warn();
    const query = () => cycle(note('c4*4').pan(sine.range(-3, 3)));
    query();
    expect(spy).toHaveBeenCalledTimes(1);
    query();
    expect(spy).toHaveBeenCalledTimes(1);
    resetWarnings();
    query();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('are named for the control a pattern fed (fmi warns as fm)', () => {
    const spy = warn();
    cycle(note('c4').fmi(pure(Number.NaN)));
    expect(spy.mock.calls[0][0]).toMatch(/^undertone: fm\(\) got NaN/);
  });
});

describe('the engine helpers of ./testing', () => {
  it('still say what they wait for', () => {
    expect(() => playVoice({}, {})).toThrow(/not available yet/);
  });
});
