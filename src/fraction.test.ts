// Unit tests for exact rational cycle-time arithmetic
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Fraction } from './fraction';

describe('Fraction', () => {
  it('normalizes to lowest terms with a positive denominator', () => {
    expect(new Fraction(2, 4)).toMatchObject({ n: 1, d: 2 });
    expect(new Fraction(3, -6)).toMatchObject({ n: -1, d: 2 });
    expect(new Fraction(-3, -6)).toMatchObject({ n: 1, d: 2 });
    expect(new Fraction(0, 7)).toMatchObject({ n: 0, d: 1 });
  });

  it('rejects non-integer parts and zero denominators', () => {
    expect(() => new Fraction(1.5)).toThrow(/must be integers/);
    expect(() => new Fraction(1, 0)).toThrow(/cannot be 0/);
  });

  it('converts decimals exactly via Fraction.from', () => {
    expect(Fraction.from(1.5)).toMatchObject({ n: 3, d: 2 });
    expect(Fraction.from(0.25)).toMatchObject({ n: 1, d: 4 });
    expect(Fraction.from(-0.75)).toMatchObject({ n: -3, d: 4 });
    expect(Fraction.from(3)).toMatchObject({ n: 3, d: 1 });
    expect(Fraction.from(new Fraction(1, 3))).toMatchObject({ n: 1, d: 3 });
  });

  it('does exact arithmetic', () => {
    const third = new Fraction(1, 3);
    expect(third.add(third).add(third).eq(new Fraction(1))).toBe(true);
    expect(new Fraction(1, 2).sub(new Fraction(1, 3))).toMatchObject({ n: 1, d: 6 });
    expect(new Fraction(2, 3).mul(new Fraction(3, 4))).toMatchObject({ n: 1, d: 2 });
    expect(new Fraction(1, 2).div(new Fraction(1, 8))).toMatchObject({ n: 4, d: 1 });
    expect(() => new Fraction(1).div(new Fraction(0))).toThrow(/Division by zero/);
  });

  it('compares correctly', () => {
    expect(new Fraction(1, 3).lt(new Fraction(1, 2))).toBe(true);
    expect(new Fraction(2, 4).eq(new Fraction(1, 2))).toBe(true);
    expect(new Fraction(5, 4).gte(new Fraction(1))).toBe(true);
    expect(new Fraction(1, 3).min(new Fraction(1, 2))).toMatchObject({ n: 1, d: 3 });
    expect(new Fraction(1, 3).max(new Fraction(1, 2))).toMatchObject({ n: 1, d: 2 });
  });

  it('computes sam/nextSam/cyclePos, including for negative times', () => {
    const t = new Fraction(7, 2); // 3.5
    expect(t.sam()).toMatchObject({ n: 3, d: 1 });
    expect(t.nextSam()).toMatchObject({ n: 4, d: 1 });
    expect(t.cyclePos()).toMatchObject({ n: 1, d: 2 });

    const negative = new Fraction(-1, 4);
    expect(negative.sam()).toMatchObject({ n: -1, d: 1 });
    expect(negative.cyclePos()).toMatchObject({ n: 3, d: 4 });
  });

  it('formats and converts to number', () => {
    expect(new Fraction(3, 2).toString()).toBe('3/2');
    expect(new Fraction(4, 2).toString()).toBe('2');
    expect(new Fraction(3, 4).toNumber()).toBe(0.75);
  });
});
