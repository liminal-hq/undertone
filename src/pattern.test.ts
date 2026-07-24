// Unit tests for the pattern query core and its combinators
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Fraction } from './fraction';
import {
  Pattern,
  bjorklund,
  cat,
  hasOnset,
  pure,
  seq,
  silence,
  stack,
  timecat,
  type Hap
} from './pattern';

/** Flattens a hap into plain numbers for readable assertions. */
function ev<T>(hap: Hap<T>): { value: T; begin: number; end: number; onset: boolean } {
  return {
    value: hap.value,
    begin: hap.part.begin.toNumber(),
    end: hap.part.end.toNumber(),
    onset: hasOnset(hap)
  };
}

function queryCycle<T>(pat: Pattern<T>, cycle = 0): ReturnType<typeof ev<T>>[] {
  return pat
    .query({ begin: new Fraction(cycle), end: new Fraction(cycle + 1) })
    .map(ev)
    .sort((a, b) => a.begin - b.begin);
}

function querySpan<T>(pat: Pattern<T>, begin: Fraction, end: Fraction): ReturnType<typeof ev<T>>[] {
  return pat
    .query({ begin, end })
    .map(ev)
    .sort((a, b) => a.begin - b.begin);
}

describe('pure', () => {
  it('repeats its value once per cycle', () => {
    expect(queryCycle(pure('a'))).toEqual([{ value: 'a', begin: 0, end: 1, onset: true }]);
    expect(queryCycle(pure('a'), 5)).toEqual([{ value: 'a', begin: 5, end: 6, onset: true }]);
  });

  it('returns partial haps (no onset) when queried mid-event', () => {
    const haps = querySpan(pure('a'), new Fraction(1, 2), new Fraction(3, 2));
    expect(haps).toEqual([
      { value: 'a', begin: 0.5, end: 1, onset: false },
      { value: 'a', begin: 1, end: 1.5, onset: true }
    ]);
  });

  it('returns nothing for an empty span', () => {
    expect(querySpan(pure('a'), new Fraction(1, 2), new Fraction(1, 2))).toEqual([]);
  });
});

describe('silence', () => {
  it('never returns events', () => {
    expect(queryCycle(silence)).toEqual([]);
  });
});

describe('seq', () => {
  it('divides the cycle equally', () => {
    expect(queryCycle(seq(pure('a'), pure('b')))).toEqual([
      { value: 'a', begin: 0, end: 0.5, onset: true },
      { value: 'b', begin: 0.5, end: 1, onset: true }
    ]);
  });

  it('nests, subdividing the parent slot', () => {
    expect(queryCycle(seq(pure('a'), seq(pure('b'), pure('c'))))).toEqual([
      { value: 'a', begin: 0, end: 0.5, onset: true },
      { value: 'b', begin: 0.5, end: 0.75, onset: true },
      { value: 'c', begin: 0.75, end: 1, onset: true }
    ]);
  });

  it('keeps exact thirds across many cycles', () => {
    const triplet = seq(pure('a'), pure('b'), pure('c'));
    const haps = queryCycle(triplet, 99);
    expect(haps).toHaveLength(3);
    expect(haps[1].begin).toBeCloseTo(99 + 1 / 3, 12);
    expect(haps.every((h) => h.onset)).toBe(true);
  });
});

describe('timecat', () => {
  it('rejects non-positive weights', () => {
    expect(() => timecat([[0, pure('a')]])).toThrow(/positive/);
    expect(() => timecat([[-1, pure('a')]])).toThrow(/positive/);
  });

  it('divides the cycle by weight', () => {
    expect(
      queryCycle(
        timecat([
          [3, pure('a')],
          [1, pure('b')]
        ])
      )
    ).toEqual([
      { value: 'a', begin: 0, end: 0.75, onset: true },
      { value: 'b', begin: 0.75, end: 1, onset: true }
    ]);
  });
});

describe('stack', () => {
  it('plays all patterns at once', () => {
    const haps = queryCycle(stack(pure('a'), pure('b')));
    expect(haps.map((h) => h.value).sort()).toEqual(['a', 'b']);
    expect(haps.every((h) => h.begin === 0 && h.end === 1)).toBe(true);
  });
});

describe('cat', () => {
  it('plays one pattern per cycle in rotation', () => {
    const pat = cat(pure('a'), pure('b'));
    expect(queryCycle(pat, 0)[0].value).toBe('a');
    expect(queryCycle(pat, 1)[0].value).toBe('b');
    expect(queryCycle(pat, 2)[0].value).toBe('a');
  });

  it('unfolds nested alternations one step per visit (a b a c)', () => {
    const pat = cat(pure('a'), cat(pure('b'), pure('c')));
    expect([0, 1, 2, 3].map((c) => queryCycle(pat, c)[0].value)).toEqual(['a', 'b', 'a', 'c']);
  });
});

describe('fast/slow', () => {
  it('fast(2) squeezes two cycles into one', () => {
    expect(queryCycle(seq(pure('a'), pure('b')).fast(2))).toEqual([
      { value: 'a', begin: 0, end: 0.25, onset: true },
      { value: 'b', begin: 0.25, end: 0.5, onset: true },
      { value: 'a', begin: 0.5, end: 0.75, onset: true },
      { value: 'b', begin: 0.75, end: 1, onset: true }
    ]);
  });

  it('slow(2) stretches an event across two cycles, with the onset only in the first', () => {
    const pat = pure('a').slow(2);
    expect(queryCycle(pat, 0)).toEqual([{ value: 'a', begin: 0, end: 1, onset: true }]);
    expect(queryCycle(pat, 1)).toEqual([{ value: 'a', begin: 1, end: 2, onset: false }]);
  });

  it('accepts fractional factors', () => {
    expect(queryCycle(pure('a').fast(0.5), 0)).toEqual(queryCycle(pure('a').slow(2), 0));
  });

  it('rejects non-positive factors', () => {
    expect(() => pure('a').fast(0)).toThrow(/positive/);
    expect(() => pure('a').slow(-1)).toThrow(/positive/);
  });
});

describe('rev', () => {
  it('reverses each cycle', () => {
    expect(queryCycle(seq(pure('a'), pure('b'), pure('c')).rev())).toEqual([
      { value: 'c', begin: 0, end: 1 / 3, onset: true },
      { value: 'b', begin: 1 / 3, end: 2 / 3, onset: true },
      { value: 'a', begin: 2 / 3, end: 1, onset: true }
    ]);
  });

  it('is its own inverse', () => {
    const pat = seq(pure('a'), seq(pure('b'), pure('c')));
    expect(queryCycle(pat.rev().rev())).toEqual(queryCycle(pat));
  });
});

describe('every', () => {
  it('applies the transform on cycles 0, n, 2n, ...', () => {
    const pat = seq(pure('a'), pure('b')).every(2, (p) => p.rev());
    expect(queryCycle(pat, 0).map((h) => h.value)).toEqual(['b', 'a']);
    expect(queryCycle(pat, 1).map((h) => h.value)).toEqual(['a', 'b']);
    expect(queryCycle(pat, 2).map((h) => h.value)).toEqual(['b', 'a']);
  });

  it('rejects non-positive or fractional cycle counts', () => {
    expect(() => pure('a').every(0, (p) => p)).toThrow(/positive integer/);
    expect(() => pure('a').every(1.5, (p) => p)).toThrow(/positive integer/);
  });
});

describe('bjorklund', () => {
  it('produces the canonical euclidean necklaces', () => {
    const toStr = (slots: boolean[]) => slots.map((s) => (s ? 'x' : '.')).join('');
    expect(toStr(bjorklund(3, 8))).toBe('x..x..x.');
    expect(toStr(bjorklund(5, 8))).toBe('x.xx.xx.');
    expect(toStr(bjorklund(1, 4))).toBe('x...');
    expect(toStr(bjorklund(0, 4))).toBe('....');
    expect(toStr(bjorklund(4, 4))).toBe('xxxx');
  });

  it('rejects invalid arguments', () => {
    expect(() => bjorklund(5, 4)).toThrow(/between 0 and steps/);
    expect(() => bjorklund(1, 0)).toThrow(/Invalid euclidean/);
  });
});

describe('euclid', () => {
  it('places onsets on the euclidean slots', () => {
    const haps = queryCycle(pure('a').euclid(3, 8));
    expect(haps.map((h) => h.begin)).toEqual([0, 3 / 8, 6 / 8]);
    expect(haps.every((h) => h.onset && h.value === 'a')).toBe(true);
  });

  it('rotates the rhythm left', () => {
    const haps = queryCycle(pure('a').euclid(3, 8, 1));
    expect(haps.map((h) => h.begin)).toEqual([2 / 8, 5 / 8, 7 / 8]);
  });
});
