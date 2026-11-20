// Tests for autopan and the pan slide: the LFO's nodes, connections and calls, phases, stops, laws and scores (ported from src/autopan.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, Fraction, score } from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnings();
});

describe('autopan', () => {
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
