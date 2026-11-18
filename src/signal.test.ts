// Tests for the periodic signals, their ranges, and the combinators reading them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Fraction } from './fraction';
import { Pattern, cat, hasOnset, pure, seq, stack } from './pattern';
import {
  cosine,
  cosine2,
  isaw,
  isaw2,
  saw,
  saw2,
  signal,
  sine,
  sine2,
  square,
  square2,
  tri,
  tri2
} from './signal';

/** The values of one cycle's events, rounded off float noise. */
function values(pat: Pattern<number>, cycle = 0): number[] {
  return pat
    .query({ begin: new Fraction(cycle), end: new Fraction(cycle + 1) })
    .filter(hasOnset)
    .sort((a, b) => a.part.begin.cmp(b.part.begin))
    .map((hap) => Math.round(hap.value * 1e9) / 1e9 || 0); // || 0 folds -0 into 0
}

const at = (n: number, d = 1) => new Fraction(n, d);

describe('periodic signals', () => {
  it('read in quarters as Strudel’s public REPL shows them', () => {
    expect(values(sine.segment(4))).toEqual([0.5, 1, 0.5, 0]);
    expect(values(cosine.segment(4))).toEqual([1, 0.5, 0, 0.5]);
    expect(values(saw.segment(4))).toEqual([0, 0.25, 0.5, 0.75]);
    expect(values(isaw.segment(4))).toEqual([1, 0.75, 0.5, 0.25]);
    expect(values(tri.segment(4))).toEqual([0, 0.5, 1, 0.5]);
    expect(values(square.segment(4))).toEqual([0, 0, 1, 1]);
    expect(values(saw.range(0, 8).segment(8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('give their bipolar forms as 2v - 1', () => {
    expect(values(sine2.segment(4))).toEqual([0, 1, 0, -1]);
    expect(values(cosine2.segment(4))).toEqual([1, 0, -1, 0]);
    expect(values(saw2.segment(4))).toEqual([-1, -0.5, 0, 0.5]);
    expect(values(isaw2.segment(4))).toEqual([1, 0.5, 0, -0.5]);
    expect(values(tri2.segment(4))).toEqual([-1, 0, 1, 0]);
    expect(values(square2.segment(4))).toEqual([-1, -1, 1, 1]);
  });

  it('repeat every cycle from the exact phase, negative cycles included', () => {
    for (const shape of [sine, cosine, saw, isaw, tri, square]) {
      for (const [n, d] of [
        [1, 3],
        [5, 8],
        [7, 12]
      ]) {
        const phase = shape.sampleAt(at(n, d));
        expect(shape.sampleAt(at(n, d).add(at(3)))).toBe(phase);
        expect(shape.sampleAt(at(n, d).sub(at(2)))).toBe(phase);
      }
    }
    expect(saw.sampleAt(at(13, 4))).toBe(0.25);
  });

  it('have one structureless event per query, valued at the span’s begin', () => {
    const haps = saw.query({ begin: at(1, 4), end: at(3) });
    expect(haps).toHaveLength(1);
    expect(haps[0].whole).toBeUndefined();
    expect(haps[0].value).toBe(0.25);
    expect(saw.query({ begin: at(1), end: at(1) })).toEqual([]);
  });

  it('make tri and square turn exactly at the half', () => {
    expect(tri.sampleAt(at(1, 2))).toBe(1);
    expect(tri.sampleAt(at(1, 8))).toBe(0.25);
    expect(tri.sampleAt(at(7, 8))).toBe(0.25);
    expect(square.sampleAt(at(1, 2).sub(at(1, 1000)))).toBe(0);
    expect(square.sampleAt(at(1, 2))).toBe(1);
  });
});

describe('signal(fn)', () => {
  it('passes the cycle time as a number, not the phase', () => {
    const seen: number[] = [];
    const time = signal((t) => {
      seen.push(t);
      return t;
    });
    expect(time.sampleAt(at(13, 4))).toBe(3.25);
    expect(values(signal((t) => t % 1).segment(4), 2)).toEqual(values(saw.segment(4)));
    expect(seen).toEqual([3.25]);
  });
});

describe('ranges', () => {
  it('range maps 0..1 linearly onto lo..hi, either way up', () => {
    expect(values(saw.range(100, 200).segment(4))).toEqual([100, 125, 150, 175]);
    expect(values(saw.range(1, -1).segment(2))).toEqual([1, 0]);
  });

  it('range2 maps -1..1 linearly onto lo..hi', () => {
    expect(values(sine2.range2(0, 10).segment(4))).toEqual([5, 10, 5, 0]);
  });

  it('range does not clamp', () => {
    expect(values(saw2.range(0, 1).segment(2))).toEqual([-1, 0]);
  });

  it('rangex maps exponentially, equal ratios for equal steps', () => {
    expect(values(saw.rangex(100, 1600).segment(4))).toEqual([100, 200, 400, 800]);
    expect(saw.rangex(200, 2000).sampleAt(at(1, 2))).toBeCloseTo(Math.sqrt(200 * 2000), 9);
  });

  it('rangex needs both bounds above 0', () => {
    expect(() => saw.rangex(0, 2000)).toThrow('rangex() bounds must be positive, got 0 and 2000');
    expect(() => saw.rangex(200, -1)).toThrow('rangex() bounds must be positive, got 200 and -1');
    expect(() => saw.rangex(1, Infinity)).toThrow(/rangex\(\) bounds must be positive/);
  });

  it('keep a signal a signal', () => {
    expect(saw.range(0, 8).sample).toBeDefined();
    expect(sine2.range2(0, 1).sampleAt(at(1, 4))).toBe(1);
  });
});

describe('combinators on signals', () => {
  it('fast and slow read at t·f and t/f', () => {
    expect(values(saw.fast(2).segment(4))).toEqual([0, 0.5, 0, 0.5]);
    expect(values(saw.slow(2).segment(4), 1)).toEqual([0.5, 0.625, 0.75, 0.875]);
  });

  it('rev mirrors each cycle', () => {
    expect(values(sine.rev().segment(4))).toEqual([0.5, 0, 0.5, 1]);
    expect(values(saw.rev().segment(4), 3)).toEqual([0, 0.75, 0.5, 0.25]);
  });

  it('every applies the function on cycles 0, n, 2n', () => {
    const pat = saw.every(2, (p) => p.rev()).segment(4);
    expect(values(pat, 0)).toEqual([0, 0.75, 0.5, 0.25]);
    expect(values(pat, 1)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(values(pat, 2)).toEqual([0, 0.75, 0.5, 0.25]);
  });

  it('cat plays one signal per cycle', () => {
    const pat = cat(saw, square).segment(4);
    expect(values(pat, 0)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(values(pat, 1)).toEqual([0, 0, 1, 1]);
  });

  it('seq squeezes each signal into its share of the cycle', () => {
    expect(values(seq(saw, tri).segment(8))).toEqual([0, 0.25, 0.5, 0.75, 0, 0.5, 1, 0.5]);
  });

  it('euclid gives the rhythm, each event read at its onset', () => {
    expect(values(saw.euclid(3, 8))).toEqual([0, 0.375, 0.75]);
  });

  it('stack of signals reads the first layer at a point', () => {
    expect(stack(saw, isaw).sampleAt(at(1, 4))).toBe(0.25);
    expect(values(stack(saw, isaw).segment(2))).toEqual([0, 0.5]);
  });

  it('arithmetic keeps structure from the left', () => {
    const steps = seq(pure(0), pure(10), pure(20), pure(30));
    expect(values(steps.add(saw))).toEqual([0, 10.25, 20.5, 30.75]);
    expect(values(sine.segment(4).add(saw))).toEqual([0.5, 1.25, 1, 0.75]);
    expect(values(saw.mul(8).floor().segment(8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('gives events at the same instant the same value', () => {
    const chord = stack(pure(0), pure(0), pure(0)).fast(4).add(sine);
    expect(values(chord)).toEqual([0.5, 0.5, 0.5, 1, 1, 1, 0.5, 0.5, 0.5, 0, 0, 0]);
  });
});
