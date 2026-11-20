// Exact rational arithmetic for cycle time: the reference's Fraction, exact beyond 2^53 through BigInt
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// A Fraction whose parts are safe integers behaves exactly as the reference's: plain number arithmetic, `n` and `d` the exact
// parts. When a result would not fit (or a part is itself beyond 2^53), the exact value is kept as a BigInt pair in `exact`, and
// `n` and `d` are the nearest numbers: the same maths as the Rust core's i128 fractions (docs/rust-migration, B3 and D-13), and
// the same text (`n/d`) the boundary uses for such a time.

/** The exact parts of a fraction whose parts are not both safe integers. */
const exact = new WeakMap<Fraction, readonly [bigint, bigint]>();

function gcd(a: number, b: number): number {
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function bigGcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A fraction from BigInt parts in any form: reduced, denominator positive, held as numbers when both fit. */
function fromBig(n: bigint, d: bigint): Fraction {
  if (d === 0n) {
    throw new Error('Fraction denominator cannot be 0');
  }
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = bigGcd(n, d) || 1n;
  n /= g;
  d /= g;
  if (n <= SAFE && n >= -SAFE && d <= SAFE) {
    return new Fraction(Number(n), Number(d));
  }
  const out = Object.create(Fraction.prototype) as { n: number; d: number };
  out.n = Number(n);
  out.d = Number(d);
  const fraction = out as Fraction;
  exact.set(fraction, [n, d]);
  return fraction;
}

/** The exact parts of any fraction as BigInts. */
function bigParts(f: Fraction): readonly [bigint, bigint] {
  return exact.get(f) ?? [BigInt(f.n), BigInt(f.d)];
}

/** Floor division of BigInts (rounds towards negative infinity). */
function bigFloor(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
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
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
      // Beyond 2^53 the parts are not exact numbers: hold them exactly, as the Rust core does.
      const big = fromBig(BigInt(numerator), BigInt(denominator));
      this.n = big.n;
      this.d = big.d;
      const parts = exact.get(big);
      if (parts) exact.set(this, parts);
      return;
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

  /** A Fraction from the boundary's text form: `"n"` or `"n/d"`, parts of any size. */
  static fromText(text: string): Fraction {
    const slash = text.indexOf('/');
    return slash < 0
      ? fromBig(BigInt(text), 1n)
      : fromBig(BigInt(text.slice(0, slash)), BigInt(text.slice(slash + 1)));
  }

  /** Whether both parts are exact numbers (always, short of a result beyond 2^53). */
  private get small(): boolean {
    return !exact.has(this);
  }

  add(other: Fraction): Fraction {
    if (this.small && other.small) {
      const n = this.n * other.d + other.n * this.d;
      const d = this.d * other.d;
      if (Number.isSafeInteger(n) && Number.isSafeInteger(d)) return new Fraction(n, d);
    }
    const [a, b] = bigParts(this);
    const [c, e] = bigParts(other);
    return fromBig(a * e + c * b, b * e);
  }

  sub(other: Fraction): Fraction {
    if (this.small && other.small) {
      const n = this.n * other.d - other.n * this.d;
      const d = this.d * other.d;
      if (Number.isSafeInteger(n) && Number.isSafeInteger(d)) return new Fraction(n, d);
    }
    const [a, b] = bigParts(this);
    const [c, e] = bigParts(other);
    return fromBig(a * e - c * b, b * e);
  }

  mul(other: Fraction): Fraction {
    if (this.small && other.small) {
      const n = this.n * other.n;
      const d = this.d * other.d;
      if (Number.isSafeInteger(n) && Number.isSafeInteger(d)) return new Fraction(n, d);
    }
    const [a, b] = bigParts(this);
    const [c, e] = bigParts(other);
    return fromBig(a * c, b * e);
  }

  div(other: Fraction): Fraction {
    if (other.n === 0) {
      throw new Error('Division by zero fraction');
    }
    if (this.small && other.small) {
      const n = this.n * other.d;
      const d = this.d * other.n;
      if (Number.isSafeInteger(n) && Number.isSafeInteger(d)) return new Fraction(n, d);
    }
    const [a, b] = bigParts(this);
    const [c, e] = bigParts(other);
    return fromBig(a * e, b * c);
  }

  /** Negative, zero, or positive as this is less than, equal to, or greater than `other`. */
  cmp(other: Fraction): number {
    if (this.small && other.small) {
      const left = this.n * other.d;
      const right = other.n * this.d;
      if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right;
    }
    const [a, b] = bigParts(this);
    const [c, e] = bigParts(other);
    const diff = a * e - c * b;
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
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
    const parts = exact.get(this);
    return parts ? Number(bigFloor(parts[0], parts[1])) : Math.floor(this.n / this.d);
  }

  /** The start of the cycle this time falls in ("sam" in Tidal terminology). */
  sam(): Fraction {
    const parts = exact.get(this);
    return parts ? fromBig(bigFloor(parts[0], parts[1]), 1n) : new Fraction(this.floor());
  }

  /** The start of the next cycle. */
  nextSam(): Fraction {
    const parts = exact.get(this);
    return parts ? fromBig(bigFloor(parts[0], parts[1]) + 1n, 1n) : new Fraction(this.floor() + 1);
  }

  /** Position within the current cycle, in [0, 1). */
  cyclePos(): Fraction {
    return this.sub(this.sam());
  }

  toNumber(): number {
    const parts = exact.get(this);
    if (!parts) return this.n / this.d;
    const quotient = this.n / this.d;
    if (Number.isFinite(this.n) && Number.isFinite(this.d) && Number.isFinite(quotient)) {
      return quotient;
    }
    // A part past the range of a double: scale the exact division instead.
    const scale = 10n ** 20n;
    return Number((parts[0] * scale) / parts[1]) / 1e20;
  }

  toString(): string {
    const parts = exact.get(this);
    if (parts) return parts[1] === 1n ? `${parts[0]}` : `${parts[0]}/${parts[1]}`;
    return this.d === 1 ? `${this.n}` : `${this.n}/${this.d}`;
  }
}

export const ZERO = new Fraction(0);
export const ONE = new Fraction(1);
