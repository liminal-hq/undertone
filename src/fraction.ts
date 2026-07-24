// Exact rational arithmetic for cycle time — floating point drifts on triplets and euclids
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

function gcd(a: number, b: number): number {
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * An immutable rational number (numerator/denominator, always in lowest terms,
 * denominator always positive). Pattern time is measured in cycles as Fractions
 * so that subdivisions like triplets stay exact across arbitrarily many cycles.
 */
export class Fraction {
  readonly n: number;
  readonly d: number;

  constructor(numerator: number, denominator = 1) {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      throw new Error(`Fraction parts must be integers, got ${numerator}/${denominator}`);
    }
    if (denominator === 0) {
      throw new Error('Fraction denominator cannot be 0');
    }
    if (denominator < 0) {
      numerator = -numerator;
      denominator = -denominator;
    }
    const g = gcd(Math.abs(numerator), denominator) || 1;
    this.n = numerator / g;
    this.d = denominator / g;
  }

  /** Converts a number (integer or decimal like 1.5) or existing Fraction to a Fraction. */
  static from(value: number | Fraction): Fraction {
    if (value instanceof Fraction) {
      return value;
    }
    if (Number.isInteger(value)) {
      return new Fraction(value);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot convert ${value} to a fraction`);
    }
    // Continued-fraction approximation, exact for anything a user would type (0.25, 1.5, ...).
    const sign = value < 0 ? -1 : 1;
    const target = Math.abs(value);
    let [h1, h2, k1, k2] = [1, 0, 0, 1];
    let rest = target;
    do {
      const whole = Math.floor(rest);
      [h1, h2] = [whole * h1 + h2, h1];
      [k1, k2] = [whole * k1 + k2, k1];
      rest = 1 / (rest - whole);
    } while (Math.abs(target - h1 / k1) > target * Number.EPSILON && k1 < 1e9);
    return new Fraction(sign * h1, k1);
  }

  add(other: Fraction): Fraction {
    return new Fraction(this.n * other.d + other.n * this.d, this.d * other.d);
  }

  sub(other: Fraction): Fraction {
    return new Fraction(this.n * other.d - other.n * this.d, this.d * other.d);
  }

  mul(other: Fraction): Fraction {
    return new Fraction(this.n * other.n, this.d * other.d);
  }

  div(other: Fraction): Fraction {
    if (other.n === 0) {
      throw new Error('Division by zero fraction');
    }
    return new Fraction(this.n * other.d, this.d * other.n);
  }

  /** Negative, zero, or positive as this is less than, equal to, or greater than `other`. */
  cmp(other: Fraction): number {
    return this.n * other.d - other.n * this.d;
  }

  eq(other: Fraction): boolean {
    return this.cmp(other) === 0;
  }

  lt(other: Fraction): boolean {
    return this.cmp(other) < 0;
  }

  lte(other: Fraction): boolean {
    return this.cmp(other) <= 0;
  }

  gt(other: Fraction): boolean {
    return this.cmp(other) > 0;
  }

  gte(other: Fraction): boolean {
    return this.cmp(other) >= 0;
  }

  min(other: Fraction): Fraction {
    return this.lte(other) ? this : other;
  }

  max(other: Fraction): Fraction {
    return this.gte(other) ? this : other;
  }

  /** The largest integer <= this value (rounds towards negative infinity). */
  floor(): number {
    return Math.floor(this.n / this.d);
  }

  /** The start of the cycle this time falls in ("sam" in Tidal terminology). */
  sam(): Fraction {
    return new Fraction(this.floor());
  }

  /** The start of the next cycle. */
  nextSam(): Fraction {
    return new Fraction(this.floor() + 1);
  }

  /** Position within the current cycle, in [0, 1). */
  cyclePos(): Fraction {
    return this.sub(this.sam());
  }

  toNumber(): number {
    return this.n / this.d;
  }

  toString(): string {
    return this.d === 1 ? `${this.n}` : `${this.n}/${this.d}`;
  }
}

export const ZERO = new Fraction(0);
export const ONE = new Fraction(1);
