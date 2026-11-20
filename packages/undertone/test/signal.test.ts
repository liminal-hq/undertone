// Tests for the periodic signals, their ranges, and the combinators reading them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  brand,
  brandBy,
  cat,
  choose,
  cosine,
  cosine2,
  Fraction,
  hasOnset,
  irand,
  isaw,
  isaw2,
  Pattern,
  perlin,
  pure,
  rand,
  rand2,
  saw,
  saw2,
  seededRandom,
  seq,
  signal,
  sine,
  sine2,
  square,
  square2,
  stack,
  tri,
  tri2
} from '@liminal-hq/undertone';

/** The reference's `timeRandom`, as the scheme the test freezes: the first output of `seededRandom('seed|kind|n/d')`. */
function timeRandom(seed: number | string, kind: string, t: Fraction): number {
  return seededRandom(`${seed}|${kind}|${t.n}/${t.d}`)();
}

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

// --- Random signals ---

/** onset -> value for every event with an onset in the haps, keyed by the exact onset. */
function onsets<T>(pat: Pattern<T>, spans: [Fraction, Fraction][]): Map<string, T> {
  const seen = new Map<string, T>();
  for (const [begin, end] of spans) {
    for (const hap of pat.query({ begin, end }).filter(hasOnset)) {
      seen.set(hap.whole!.begin.toString(), hap.value);
    }
  }
  return seen;
}

/** Cuts [0, 8) at sorted random rationals into chunks, from a seeded generator so the test is repeatable. */
function chunks(seed: number): [Fraction, Fraction][] {
  const random = seededRandom(seed);
  const cuts = Array.from({ length: 20 }, () => new Fraction(Math.floor(random() * 8 * 35), 35));
  const points = [at(0), ...cuts.sort((a, b) => a.cmp(b)), at(8)];
  return points.slice(1).map((end, i) => [points[i], end] as [Fraction, Fraction]);
}

describe('random signals', () => {
  const busy = stack(rand.segment(7), perlin.segment(5), irand(16).segment(3), rand2.segment(4));

  it('freeze the scheme: seededRandom of seed|kind|n/d, stable from 0.4.0', () => {
    expect(rand.sampleAt(at(0))).toBe(0.31715847947634757);
    expect(rand.sampleAt(at(1, 4))).toBe(0.9029091894626617);
    expect(rand.seed(7).sampleAt(at(3, 2))).toBe(0.607158035505563);
    expect(perlin.sampleAt(at(1, 2))).toBe(0.8483375826617703);
    expect(rand.sampleAt(at(2, 6))).toBe(seededRandom('0|rand|1/3')());
    expect(timeRandom(0, 'rand', at(5, 3))).toBe(rand.sampleAt(at(5, 3)));
  });

  it('give the same values however the span is cut into queries', () => {
    const whole = onsets(busy, [[at(0), at(8)]]);
    expect(whole.size).toBeGreaterThan(100);
    for (const seed of [1, 2, 3]) {
      expect(onsets(busy, chunks(seed))).toEqual(whole);
    }
  });

  it('give the same values in whatever order the cycles are queried', () => {
    const forward = onsets(
      busy,
      Array.from({ length: 8 }, (_, c) => [at(c), at(c + 1)] as [Fraction, Fraction])
    );
    const shuffled = onsets(
      busy,
      [5, 2, 7, 0, 3, 6, 1, 4].map((c) => [at(c), at(c + 1)] as [Fraction, Fraction])
    );
    expect(shuffled).toEqual(forward);
  });

  it('read each value at the event onset, so a query mid-event changes nothing', () => {
    const late = rand.segment(2).query({ begin: at(1, 3), end: at(1, 2) });
    expect(late[0].value).toBe(rand.sampleAt(at(0)));
  });

  it('give events at the same instant the same value', () => {
    expect(values(stack(rand.segment(4), rand.segment(2)))).toEqual(
      values(stack(rand.segment(4), rand.segment(2)))
    );
    const [a, b] = stack(rand.segment(1), rand.segment(1)).query({ begin: at(3), end: at(4) });
    expect(a.value).toBe(b.value);
  });

  it('are spread evenly: rand averages about 0.5 and stays in [0, 1)', () => {
    const samples = Array.from({ length: 10000 }, (_, k) => rand.sampleAt(at(k, 37)) as number);
    const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThan(1);
    const below = samples.filter((v) => v < 0.25).length / samples.length;
    expect(below).toBeGreaterThan(0.23);
    expect(below).toBeLessThan(0.27);
  });

  it('derive rand2, irand, choose and brandBy from the rand stream', () => {
    for (let k = 0; k < 200; k++) {
      const t = at(k, 9);
      const u = rand.sampleAt(t) as number;
      expect(rand2.sampleAt(t)).toBe(2 * u - 1);
      expect(irand(8).sampleAt(t)).toBe(Math.floor(u * 8));
      expect(choose('a', 'b', 'c').sampleAt(t)).toBe(['a', 'b', 'c'][Math.floor(u * 3)]);
      expect(brandBy(0.3).sampleAt(t)).toBe(u < 0.3 ? 1 : 0);
      expect(brand.sampleAt(t)).toBe(u < 0.5 ? 1 : 0);
    }
  });

  it('cover their ranges: irand every integer, choose every value, brandBy its probability', () => {
    const times = Array.from({ length: 4000 }, (_, k) => at(k, 13));
    expect(new Set(times.map((t) => irand(5).sampleAt(t)))).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(new Set(times.map((t) => choose(-1, 0, 1).sampleAt(t)))).toEqual(new Set([-1, 0, 1]));
    const ones = times.filter((t) => brandBy(0.2).sampleAt(t) === 1).length / times.length;
    expect(ones).toBeGreaterThan(0.17);
    expect(ones).toBeLessThan(0.23);
    expect(times.every((t) => brandBy(0).sampleAt(t) === 0)).toBe(true);
    expect(times.every((t) => brandBy(1).sampleAt(t) === 1)).toBe(true);
  });

  it('validate their arguments', () => {
    expect(() => irand(2.5)).toThrow('irand() needs a positive integer, got 2.5');
    expect(() => irand(0)).toThrow('irand() needs a positive integer, got 0');
    expect(() => choose()).toThrow('choose() needs at least one value');
    expect(() => brandBy(2)).toThrow('brandBy() probability must be between 0 and 1, got 2');
    expect(() => brandBy(Number.NaN)).toThrow(/brandBy\(\) probability/);
  });
});

describe('perlin', () => {
  it('passes through its own random value at every whole cycle', () => {
    for (let i = -3; i < 10; i++) {
      expect(perlin.sampleAt(at(i))).toBe(timeRandom(0, 'perlin', at(i)));
    }
  });

  it('is continuous, with no jumps at or between whole cycles', () => {
    const step = 1 / 1000;
    let previous = perlin.sampleAt(at(-1)) as number;
    for (let k = -999; k <= 4000; k++) {
      const value = perlin.sampleAt(at(k, 1000)) as number;
      expect(Math.abs(value - previous)).toBeLessThan(2 * step * 1.875); // smootherstep's slope peaks at 1.875
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      previous = value;
    }
  });

  it('flattens out at whole cycles (smootherstep has zero slope there)', () => {
    const near = (perlin.sampleAt(at(3001, 1000)) as number) - (perlin.sampleAt(at(3)) as number);
    const mid =
      (perlin.sampleAt(at(3501, 1000)) as number) - (perlin.sampleAt(at(3500, 1000)) as number);
    expect(Math.abs(near)).toBeLessThan(Math.abs(mid) + 1e-12);
  });
});

describe('seed()', () => {
  const times = Array.from({ length: 50 }, (_, k) => at(k, 7));
  const read = (pat: Pattern<unknown>) => times.map((t) => pat.sampleAt(t));

  it('defaults to 0, gives the same values for the same seed and others for another', () => {
    for (const pat of [
      rand,
      rand2,
      perlin,
      irand(100),
      choose(1, 2, 3, 4, 5, 6),
      brand,
      brandBy(0.4)
    ]) {
      const seeded = pat.seed(5) as Pattern<unknown>;
      expect(read(pat.seed(0) as Pattern<unknown>)).toEqual(read(pat as Pattern<unknown>));
      expect(read(seeded)).toEqual(read(pat.seed(5) as Pattern<unknown>));
      expect(read(seeded)).not.toEqual(read(pat as Pattern<unknown>));
    }
  });

  it('takes a string seed and can be chosen again', () => {
    expect(read(rand.seed('hats'))).toEqual(read(rand.seed('hats')));
    expect(read(rand.seed(1).seed(2))).toEqual(read(rand.seed(2)));
  });

  it('works only directly on a random signal', () => {
    const message =
      'seed() works directly on rand, rand2, perlin, irand(), choose() and brand — call it before range() or segment()';
    expect(() => rand.range(200, 2000).seed(7)).toThrow(message);
    expect(() => rand.segment(4).seed(7)).toThrow(message);
    expect(() => sine.seed(7)).toThrow(message);
    expect(() => pure(1).seed(7)).toThrow(message);
    expect(() => rand.seed(Number.NaN)).toThrow(
      'seed() needs a finite number or a string, got NaN'
    );
  });

  it('is independent of render seeds: values need no audio context', () => {
    expect(rand.seed(3).sampleAt(at(1, 2))).toBe(seededRandom('3|rand|1/2')());
  });
});
