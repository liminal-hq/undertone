// Unit tests for the Voice builder's chaining and defaults
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, sound, Voice } from './voice';

describe('Voice builder', () => {
  it('note() defaults to sine with the given pitch', () => {
    const params = note('c2').getParams();
    expect(params.soundType).toBe('sine');
    expect(params.pitch).toBe('c2');
  });

  it('sound() starts with no pitch set', () => {
    const params = sound('white').getParams();
    expect(params.soundType).toBe('white');
    expect(params.pitch).toBeUndefined();
  });

  it('chains accumulate onto the params object', () => {
    const params = note('c2')
      .sound('triangle')
      .attack(0.001)
      .decay(0.1)
      .sustain(0)
      .release(0.05)
      .gain(0.9)
      .lpf(220)
      .lpenv(5)
      .lpa(0.001)
      .lpd(0.08)
      .lps(0)
      .lpr(0.05)
      .slide(0.07)
      .nudge(0.02)
      .getParams();

    expect(params).toMatchObject({
      soundType: 'triangle',
      pitch: 'c2',
      attack: 0.001,
      decay: 0.1,
      sustain: 0,
      release: 0.05,
      gainLevel: 0.9,
      filterCutoff: 220,
      filterEnvAmount: 5,
      filterAttack: 0.001,
      filterDecay: 0.08,
      filterSustain: 0,
      filterRelease: 0.05,
      slideTime: 0.07,
      nudgeTime: 0.02
    });
  });

  it('each chained call returns a new Voice, leaving the original untouched', () => {
    const base = note('c2');
    const louder = base.gain(0.9);

    expect(base.getParams().gainLevel).toBe(0.8);
    expect(louder.getParams().gainLevel).toBe(0.9);
    expect(base).not.toBe(louder);
    expect(louder).toBeInstanceOf(Voice);
  });

  it('applies sensible one-shot defaults when nothing is chained', () => {
    const params = note('a4').getParams();
    expect(params.gainLevel).toBe(0.8);
    expect(params.sustain).toBe(0);
    expect(params.nudgeTime).toBe(0);
    expect(params.filterCutoff).toBeUndefined();
  });
});
