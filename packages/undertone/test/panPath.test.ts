// Tests for pan automation inside a note: the booked pan calls, an early stop, panpath(), and pan paths in scores (ported from src/panPath.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, Fraction, score } from '@liminal-hq/undertone';

describe('score panPath', () => {
  const FIRST_CYCLE = { begin: new Fraction(0), end: new Fraction(1) };
  it('leaves events without a path as they were', () => {
    const [hap] = score({
      ticksPerSecond: 100,
      lengthTicks: 100,
      events: [{ tick: 0, note: 'a4', pan: 0.2, panPath: [] }]
    }).pattern.query(FIRST_CYCLE);

    expect(hap.value.panPath).toBeUndefined();
    expect(hap.value.pan).toBe(0.2);
  });
  it('rejects fractional, negative or backwards ticks and pans that are not numbers', () => {
    const at = (panPath: { tick: number; pan: number }[]) => () =>
      score({ ticksPerSecond: 100, lengthTicks: 100, events: [{ tick: 0, note: 'a4', panPath }] });

    expect(at([{ tick: 0.5, pan: 0 }])).toThrow(/panPath tick must be an integer/);
    expect(at([{ tick: -1, pan: 0 }])).toThrow(/panPath tick must be an integer/);
    expect(
      at([
        { tick: 10, pan: 0 },
        { tick: 5, pan: 0 }
      ])
    ).toThrow(/must not go backwards/);
    expect(at([{ tick: 0, pan: Number.NaN }])).toThrow(/pan must be a number/);
  });
});

describe('panpath()', () => {
  it('feeds the voice panPath, at a given frame rate', () => {
    const [hap] = note('a4')
      .panpath([0, 1], 10)
      .query({ begin: new Fraction(0), end: new Fraction(1) });
    expect(hap.value.panPath).toEqual([
      { time: 0, pan: 0 },
      { time: 0.1, pan: 0 },
      { time: 0.1, pan: 1 }
    ]);
  });
  it('rejects empty, out-of-range or badly timed paths, and a rate with points', () => {
    expect(() => note('a4').panpath([])).toThrow(
      'panpath() needs a non-empty array of pans or { time, pan } points'
    );
    expect(() => note('a4').panpath([0, 2])).toThrow('panpath() needs pans between -1 and 1');
    expect(() => note('a4').panpath([0, Number.NaN])).toThrow('between -1 and 1');
    expect(() => note('a4').panpath([0, 1], 0)).toThrow('panpath() rate must be positive, got 0');
    expect(() => note('a4').panpath([{ time: 0, pan: 0 }], 140)).toThrow(
      'panpath() takes a rate only with an array of pans'
    );
    expect(() =>
      note('a4').panpath([
        { time: 0.5, pan: 0 },
        { time: 0.25, pan: 1 }
      ])
    ).toThrow('panpath() times must not go backwards, got 0.25 after 0.5');
    expect(() => note('a4').panpath([{ time: Number.NaN, pan: 0 }])).toThrow(
      'panpath() points need a finite time and a pan between -1 and 1'
    );
  });
});
