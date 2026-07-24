// Unit tests for the mini-notation parser
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Fraction } from './fraction';
import { mini } from './mini';
import { hasOnset, type Pattern } from './pattern';

/** Queries one cycle and flattens onsets to [value, begin, end] triples in time order. */
function cycle(pat: Pattern<string>, n = 0): [string, number, number][] {
  return pat
    .query({ begin: new Fraction(n), end: new Fraction(n + 1) })
    .filter(hasOnset)
    .map(
      (hap) =>
        [hap.value, hap.part.begin.toNumber(), hap.part.end.toNumber()] as [string, number, number]
    )
    .sort((a, b) => a[1] - b[1]);
}

const parse = (source: string) => mini(source, (word) => word);

describe('mini', () => {
  it('parses a single word as one event per cycle', () => {
    expect(cycle(parse('a'))).toEqual([['a', 0, 1]]);
  });

  it('divides the cycle across a whitespace sequence', () => {
    expect(cycle(parse('a b c d'))).toEqual([
      ['a', 0, 0.25],
      ['b', 0.25, 0.5],
      ['c', 0.5, 0.75],
      ['d', 0.75, 1]
    ]);
  });

  it('treats ~ as a rest', () => {
    expect(cycle(parse('a ~ b ~'))).toEqual([
      ['a', 0, 0.25],
      ['b', 0.5, 0.75]
    ]);
  });

  it('subdivides bracketed groups', () => {
    expect(cycle(parse('a [b c]'))).toEqual([
      ['a', 0, 0.5],
      ['b', 0.5, 0.75],
      ['c', 0.75, 1]
    ]);
  });

  it('speeds up with * and slows down with /', () => {
    expect(cycle(parse('a*2 b'))).toEqual([
      ['a', 0, 0.25],
      ['a', 0.25, 0.5],
      ['b', 0.5, 1]
    ]);

    // a/2 only has its onset every other cycle; its part is clipped to the queried cycle
    expect(cycle(parse('a/2'), 0)).toEqual([['a', 0, 1]]);
    expect(cycle(parse('a/2'), 1)).toEqual([]);
  });

  it('alternates <> children one per cycle', () => {
    const pat = parse('<a b c>');
    expect(cycle(pat, 0)).toEqual([['a', 0, 1]]);
    expect(cycle(pat, 1)).toEqual([['b', 1, 2]]);
    expect(cycle(pat, 2)).toEqual([['c', 2, 3]]);
    expect(cycle(pat, 3)).toEqual([['a', 3, 4]]);
  });

  it('applies postfix modifiers to a whole <> group', () => {
    const pat = parse('<a b>*2');
    expect(cycle(pat, 0)).toEqual([
      ['a', 0, 0.5],
      ['b', 0.5, 1]
    ]);
  });

  it('replicates with ! and elongates with @', () => {
    expect(cycle(parse('a!2 b'))).toEqual(cycle(parse('a a b')));
    expect(cycle(parse('a@3 b'))).toEqual([
      ['a', 0, 0.75],
      ['b', 0.75, 1]
    ]);
  });

  it('stacks comma-separated sequences (chords)', () => {
    expect(cycle(parse('[a,b]'))).toEqual([
      ['a', 0, 1],
      ['b', 0, 1]
    ]);
    expect(cycle(parse('a c, b'))).toEqual([
      ['a', 0, 0.5],
      ['b', 0, 1],
      ['c', 0.5, 1]
    ]);
  });

  it('parses euclidean shorthand with optional rotation', () => {
    expect(cycle(parse('a(3,8)')).map(([, begin]) => begin)).toEqual([0, 3 / 8, 6 / 8]);
    expect(cycle(parse('a(3,8,1)')).map(([, begin]) => begin)).toEqual([2 / 8, 5 / 8, 7 / 8]);
  });

  it('reports errors with their position in the source', () => {
    expect(() => parse('')).toThrow(/Empty mini-notation/);
    expect(() => parse('a ]')).toThrow(/position 2/);
    expect(() => parse('[a b')).toThrow(/unexpected end/);
    expect(() => parse('a*x')).toThrow(/expected a number/);
    expect(() => parse('a(3)')).toThrow(/expected ","/);
    expect(() => parse('a $ b')).toThrow(/unexpected "\$"/);
    expect(() => parse('a*2.5.1')).toThrow(/expected a number/);
    expect(() => parse('<a@2 b>')).toThrow(/not supported inside <>/);
  });

  it('rejects hex/exponent notation instead of silently coercing it', () => {
    expect(() => parse('a*0x10')).toThrow(/expected a number/);
    expect(() => parse('a*1e3')).toThrow(/expected a number/);
  });

  it('wraps combinator errors with the modifier position', () => {
    expect(() => parse('a*-2')).toThrow(/position 1.*positive/);
    expect(() => parse('a(-1,4)')).toThrow(/position 1.*pulses/);
  });

  it('reports leaf validation errors with their position', () => {
    const strict = (source: string) =>
      mini(source, (word) => {
        if (word === 'bad') {
          throw new Error('no good');
        }
        return word;
      });
    expect(() => strict('a bad c')).toThrow(/position 2.*no good/);
  });
});
