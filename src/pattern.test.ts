// Unit tests for the pattern query core and its combinators
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Fraction } from './fraction';
import {
  Pattern,
  arrange,
  bjorklund,
  cat,
  hasOnset,
  pure,
  rev,
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

describe('arrange', () => {
  it('plays each section for its own span of whole cycles', () => {
    const pat = arrange([2, pure('a')], [1, pure('b')]);
    expect([0, 1, 2].map((c) => queryCycle(pat, c)[0].value)).toEqual(['a', 'a', 'b']);
  });

  it('loops the whole arrangement once the total is reached', () => {
    const pat = arrange([2, pure('a')], [1, pure('b')]);
    expect([3, 4, 5].map((c) => queryCycle(pat, c)[0].value)).toEqual(['a', 'a', 'b']);
  });

  it("restarts each section's pattern at its own cycle 0", () => {
    const pat = arrange([4, cat(pure('x'), pure('y'))]);
    expect([0, 1, 4, 5].map((c) => queryCycle(pat, c)[0].value)).toEqual(['x', 'y', 'x', 'y']);
  });

  it('handles a query spanning a section boundary', () => {
    const pat = arrange([1, pure('a')], [1, pure('b')]);
    const events = pat
      .query({ begin: new Fraction(0), end: new Fraction(2) })
      .map((hap) => hap.value);
    expect(events).toEqual(['a', 'b']);
  });

  it('rejects non-positive-integer cycle counts', () => {
    expect(() => arrange([0, pure('a')])).toThrow(/positive integers/);
    expect(() => arrange([1.5, pure('a')])).toThrow(/positive integers/);
  });

  it('returns silence for no sections', () => {
    expect(queryCycle(arrange())).toEqual([]);
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

// --- The point sampler (signals) ---

/** A test signal whose value is the cycle time itself, so every mapping of time shows in its values. */
const clock = new Pattern<number>(
  (span) => (span.begin.lt(span.end) ? [{ part: span, value: span.begin.toNumber() }] : []),
  (t) => t.toNumber()
);

/** The query route: the first event over [t, next cycle) whose part covers t. */
function viaQuery<T>(pat: Pattern<T>, t: Fraction): T | undefined {
  return pat
    .query({ begin: t, end: t.nextSam() })
    .find((hap) => hap.part.begin.lte(t) && t.lt(hap.part.end))?.value;
}

/** Instants from cycle -2 to cycle 6 in twelfths and sevenths, negative cycles included. */
const instants: Fraction[] = [
  ...Array.from({ length: 97 }, (_, k) => new Fraction(k - 24, 12)),
  ...Array.from({ length: 57 }, (_, k) => new Fraction(k - 14, 7))
];

describe('sampleAt', () => {
  it('uses the sampler when the pattern has one', () => {
    expect(clock.sampleAt(new Fraction(13, 4))).toBe(3.25);
  });

  it('falls back to the covering event of the query for a discrete pattern', () => {
    const steps = seq(pure(1), pure(2), silence);
    expect(steps.sample).toBeUndefined();
    expect(steps.sampleAt(new Fraction(0))).toBe(1);
    expect(steps.sampleAt(new Fraction(1, 2))).toBe(2);
    expect(steps.sampleAt(new Fraction(7, 3))).toBe(2);
    expect(steps.sampleAt(new Fraction(5, 6))).toBeUndefined(); // a rest
  });

  it('leaves discrete patterns without a sampler through every combinator', () => {
    const a = pure(1);
    for (const pat of [
      a.fmap((v) => v + 1),
      a.fast(2),
      a.slow(2),
      a.rev(),
      a.every(2, rev),
      a.euclid(3, 8),
      a.segment(4),
      cat(a, a),
      seq(a, a),
      timecat([[1, a]]),
      arrange([1, a]),
      stack(a, a),
      a.add(clock)
    ]) {
      expect(pat.sample).toBeUndefined();
    }
  });
});

describe('sampler and query agree', () => {
  const cases: [string, Pattern<number>][] = [
    ['fmap', clock.fmap((v) => v * 2)],
    ['fast', clock.fast(3)],
    ['fast by a fraction', clock.fast(1.5)],
    ['slow', clock.slow(2)],
    ['every', clock.every(3, (p) => p.fast(2))],
    ['cat', cat(clock, clock.fast(2), clock.slow(3))],
    ['arrange', arrange([2, clock], [1, clock.slow(2)])],
    ['seq', seq(clock, clock.fast(2), clock)],
    [
      'timecat',
      timecat([
        [1, clock],
        [3, clock.slow(2)]
      ])
    ],
    [
      'nested',
      seq(cat(clock, clock.fast(2)), clock)
        .fast(2)
        .every(2, (p) => p.slow(3))
    ],
    ['add a signal', clock.add(clock.fast(2))],
    ['add a discrete pattern', clock.add(seq(pure(10), pure(20)))]
  ];

  for (const [name, pat] of cases) {
    it(`for ${name}`, () => {
      expect(pat.sample).toBeDefined();
      for (const t of instants) {
        expect(pat.sampleAt(t), `at ${t}`).toBe(viaQuery(pat, t));
      }
    });
  }

  it('is undefined outside a seq window, where the query has no covering event', () => {
    const half = timecat([
      [1, clock],
      [1, silence as Pattern<number>]
    ]);
    expect(half.sample).toBeUndefined(); // silence has no sampler, so neither does the whole
    const windowed = seq(clock, clock);
    expect(windowed.sampleAt(new Fraction(1, 2))).toBe(0); // the second half restarts the clock
  });
});

describe('rev on a signal', () => {
  it('mirrors each cycle point by point: c + x reads c + 1 - x', () => {
    const reversed = clock.rev();
    expect(reversed.sampleAt(new Fraction(0))).toBe(1);
    expect(reversed.sampleAt(new Fraction(1, 4))).toBe(0.75);
    expect(reversed.sampleAt(new Fraction(9, 4))).toBe(2.75);
    expect(reversed.sampleAt(new Fraction(-3, 4))).toBe(-0.25);
  });

  it('is why the sampler exists: the query route reads the mirrored end instead', () => {
    const t = new Fraction(1, 4);
    expect(viaQuery(clock.rev(), t)).toBe(0); // the cycle's start, not 0.75
    expect(clock.rev().sampleAt(t)).toBe(0.75);
  });

  it('reads correctly through segment()', () => {
    expect(queryCycle(clock.rev().segment(4)).map((h) => h.value)).toEqual([1, 0.75, 0.5, 0.25]);
  });
});

describe('stack of signals', () => {
  it('has no sampler and reads the first layer covering the instant', () => {
    const layered = stack(clock, clock.fast(2));
    expect(layered.sample).toBeUndefined();
    expect(layered.sampleAt(new Fraction(1, 4))).toBe(0.25);
  });
});

describe('segment', () => {
  it('gives n events per cycle, each holding the value at its onset', () => {
    expect(queryCycle(clock.segment(4), 2)).toEqual([
      { value: 2, begin: 2, end: 2.25, onset: true },
      { value: 2.25, begin: 2.25, end: 2.5, onset: true },
      { value: 2.5, begin: 2.5, end: 2.75, onset: true },
      { value: 2.75, begin: 2.75, end: 3, onset: true }
    ]);
  });

  it('reads at the onset even when the query starts mid-event', () => {
    const haps = querySpan(clock.segment(2), new Fraction(1, 4), new Fraction(1));
    expect(haps).toEqual([
      { value: 0, begin: 0.25, end: 0.5, onset: false },
      { value: 0.5, begin: 0.5, end: 1, onset: true }
    ]);
  });

  it('drops an onset where a discrete pattern rests', () => {
    expect(queryCycle(seq(pure(1), silence).segment(4)).map((h) => [h.begin, h.value])).toEqual([
      [0, 1],
      [0.25, 1]
    ]);
  });

  it('takes a fractional count, like fast()', () => {
    expect(querySpan(clock.segment(2.5), new Fraction(0), new Fraction(2)).length).toBe(5);
  });

  it('rejects a count that is not positive and finite', () => {
    expect(() => clock.segment(0)).toThrow('segment() count must be positive, got 0');
    expect(() => clock.segment(-2)).toThrow('segment() count must be positive, got -2');
    expect(() => clock.segment(Number.NaN)).toThrow(/segment\(\) count must be positive/);
    expect(() => clock.segment(Infinity)).toThrow(/segment\(\) count must be positive/);
  });
});

describe('euclid on a signal', () => {
  it('acts as a structure: the rhythm, each event read at its onset', () => {
    expect(queryCycle(clock.euclid(3, 8), 1)).toEqual([
      { value: 1, begin: 1, end: 1.125, onset: true },
      { value: 1.375, begin: 1.375, end: 1.5, onset: true },
      { value: 1.75, begin: 1.75, end: 1.875, onset: true }
    ]);
  });

  it('rotates like the discrete form', () => {
    expect(queryCycle(clock.euclid(3, 8, 1)).map((h) => h.value)).toEqual([2 / 8, 5 / 8, 7 / 8]);
  });
});

describe('arithmetic', () => {
  const steps = seq(pure(1), pure(2));

  it('applies a number to every value and keeps a signal a signal', () => {
    expect(queryCycle(steps.add(10)).map((h) => h.value)).toEqual([11, 12]);
    expect(queryCycle(steps.sub(1)).map((h) => h.value)).toEqual([0, 1]);
    expect(queryCycle(steps.mul(3)).map((h) => h.value)).toEqual([3, 6]);
    expect(queryCycle(steps.div(2)).map((h) => h.value)).toEqual([0.5, 1]);
    expect(clock.mul(2).sampleAt(new Fraction(3, 4))).toBe(1.5);
  });

  it('reads a pattern on the right at each onset of the left: structure from the left', () => {
    expect(queryCycle(steps.add(clock))).toEqual([
      { value: 1, begin: 0, end: 0.5, onset: true },
      { value: 2.5, begin: 0.5, end: 1, onset: true }
    ]);
    // A busier right side adds no events.
    expect(queryCycle(steps.mul(seq(pure(10), pure(20), pure(30), pure(40)))).length).toBe(2);
  });

  it('drops an event where the right side rests', () => {
    expect(queryCycle(steps.add(seq(pure(10), silence))).map((h) => h.value)).toEqual([11]);
  });

  it('combines two signals point by point', () => {
    const sum = clock.add(clock.fast(2)).sub(clock);
    expect(sum.sampleAt(new Fraction(5, 4))).toBe(2.5);
  });

  it('divides by zero to Infinity', () => {
    expect(queryCycle(steps.div(0)).map((h) => h.value)).toEqual([Infinity, Infinity]);
  });

  it('rejects anything but a number or a pattern', () => {
    expect(() => steps.add('1' as unknown as number)).toThrow(
      'add() needs a number or a pattern of numbers'
    );
  });

  it('rounds and floors', () => {
    const values = seq(pure(-4.2), pure(2.5), pure(-2.5), pure(1.4));
    expect(queryCycle(values.round()).map((h) => h.value)).toEqual([-4, 3, -2, 1]);
    expect(queryCycle(values.floor()).map((h) => h.value)).toEqual([-5, 2, -3, 1]);
  });
});
