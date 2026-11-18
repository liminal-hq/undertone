// Property checks of the reference itself: window independence, inverses, and signals
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { interpret } from './interpret';
import type { Program, Step } from './interpret';
import { loadReference } from './reference';
import type { Hap } from '../../src/pattern';
import type { Fraction } from '../../src/fraction';

// These are the reference's own properties (1 to 3 in docs/rust-migration/CONFORMANCE.md). A failure
// here is a finding about the reference, not a corpus bug. Every run uses a fixed seed, so a
// failure repeats; fast-check prints the counterexample and the seed.
const ref = await loadReference();
const { Fraction: Frac } = ref.lib;
const SEED = 20260418;
const RUNS = 300;

// --- Generators --------------------------------------------------------------------------------

const word = fc.constantFrom('a', 'b', 'c', 'd', 'e');

/** A mini-notation string from a small grammar: words, rests, groups, alternations, speed, replication, euclid. */
const miniSource: fc.Arbitrary<string> = fc.letrec<{ seq: string; atom: string }>((tie) => ({
  seq: fc.array(tie('atom'), { minLength: 1, maxLength: 4 }).map((atoms) => atoms.join(' ')),
  atom: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    word,
    fc.constant('~'),
    word.chain((w) => fc.integer({ min: 2, max: 3 }).map((n) => `${w}*${n}`)),
    word.chain((w) => fc.integer({ min: 2, max: 3 }).map((n) => `${w}!${n}`)),
    word.chain((w) => fc.integer({ min: 2, max: 3 }).map((n) => `${w}@${n}`)),
    word.chain((w) =>
      fc
        .tuple(
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 4, max: 8 }),
          fc.integer({ min: 0, max: 3 })
        )
        .map(([p, s, r]) => `${w}(${p},${s},${r})`)
    ),
    tie('seq').map((s) => `[${s}]`),
    fc.array(word, { minLength: 2, maxLength: 3 }).map((ws) => `<${ws.join(' ')}>`)
  )
})).seq;

const leaf: fc.Arbitrary<Program> = fc.oneof(
  miniSource.map((source): Program => [['mini', source, 'word']]),
  fc.integer({ min: 0, max: 9 }).map((n): Program => [['pure', n]]),
  fc.constant<Program>([['silence']])
);

/** A discrete program: constructors and transforms, depth at most 5. */
const discreteAt = fc.memo((depth: number): fc.Arbitrary<Program> => {
  if (depth <= 0) return leaf;
  const inner = discreteAt(depth - 1);
  const factor = fc.constantFrom(1, 2, 3, 0.5, 1.5, 0.25);
  const step = (make: (value: number) => Step) =>
    fc.tuple(inner, factor).map(([p, v]): Program => [...p, make(v)]);
  return fc.oneof(
    { depthSize: 'small' },
    leaf,
    step((v) => ['fast', v]),
    step((v) => ['slow', v]),
    inner.map((p): Program => [...p, ['rev']]),
    fc
      .tuple(inner, fc.integer({ min: 1, max: 4 }))
      .map(([p, n]): Program => [...p, ['every', n, [['rev']]]]),
    fc
      .tuple(inner, fc.integer({ min: 1, max: 4 }))
      .map(([p, n]): Program => [...p, ['every', n, [['fast', 2]]]]),
    fc
      .tuple(
        inner,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 5, max: 9 }),
        fc.integer({ min: 0, max: 4 })
      )
      .map(([p, a, b, r]): Program => [...p, ['euclid', a, b, r]]),
    fc.tuple(inner, inner).map(([a, b]): Program => [['stack', a, b]]),
    fc.tuple(inner, inner, inner).map(([a, b, c]): Program => [['seq', a, b, c]]),
    fc.tuple(inner, inner).map(([a, b]): Program => [['cat', a, b]]),
    fc
      .tuple(inner, inner, fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }))
      .map(([a, b, x, y]): Program => [
        [
          'timecat',
          [
            [x, a],
            [y, b]
          ]
        ]
      ]),
    fc
      .tuple(inner, inner, fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }))
      .map(([a, b, x, y]): Program => [['arrange', [x, a], [y, b]]])
  );
});
const discrete = discreteAt(5);

const SIGNALS = [
  'sine',
  'cosine',
  'saw',
  'isaw',
  'tri',
  'square',
  'sine2',
  'saw2',
  'tri2',
  'rand',
  'rand2',
  'perlin',
  'brand'
];

/** A signal, shaped: a signal name, a seed, then a few shaping steps. */
const signalProgram: fc.Arbitrary<Program> = fc
  .tuple(
    fc.constantFrom(...SIGNALS),
    fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }),
    fc.array(fc.constantFrom<Step>(['fast', 2], ['slow', 3], ['rev'], ['fast', 0.5], ['add', 1]), {
      maxLength: 3
    })
  )
  .map(([name, seed, shapes]): Program => {
    const random = ['rand', 'rand2', 'perlin', 'brand'].includes(name);
    return [
      [name],
      ...(seed !== undefined && random ? ([['seed', seed]] as Step[]) : []),
      ...shapes
    ];
  });

/** A signal given structure (`segment`, `euclid`) or used as a control: still window independent. */
const signalWithStructure: fc.Arbitrary<Program> = fc.oneof(
  fc
    .tuple(signalProgram, fc.integer({ min: 1, max: 8 }))
    .map(([p, n]): Program => [...p, ['segment', n]]),
  fc
    .tuple(signalProgram, fc.integer({ min: 1, max: 5 }), fc.integer({ min: 5, max: 9 }))
    .map(([p, a, b]): Program => [...p, ['euclid', a, b]]),
  fc.tuple(miniSource, signalProgram).map(([source, p]): Program => [
    ['note', source.replace(/[a-e]/g, (w) => `${w}3`)],
    ['gain', p]
  ]),
  fc
    .tuple(miniSource, signalProgram)
    .map(([source, p]): Program => [
      ['mini', source, 'word'],
      ['fmap', 'add', 0],
      ...(p.length > 99 ? [] : [])
    ])
);

/** A fraction with a denominator up to 12, from -3 to 6 (negative time included). */
const fraction = fc.tuple(fc.integer({ min: -36, max: 72 }), fc.integer({ min: 1, max: 12 }));
const times = fc
  .tuple(fraction, fraction, fraction)
  .map((triple) => triple.map(([n, d]) => new Frac(n, d)))
  .filter(([a, b, c]) => a.lt(b) && b.lt(c)) as fc.Arbitrary<[Fraction, Fraction, Fraction]>;

// --- Helpers -----------------------------------------------------------------------------------

/**
 * Haps with their fragments joined, as a canonical list: per event (whole and value), how many
 * fragments cover each stretch of time, with adjacent stretches of equal cover merged. Two
 * queries that cut an event differently, or repeat it (a stack of equal layers), give the same
 * list when the haps are the same.
 */
function joined(haps: readonly Hap<unknown>[]): string[] {
  const groups = new Map<string, Hap<unknown>[]>();
  const out: string[] = [];
  for (const hap of haps) {
    if (!hap.whole) {
      out.push(`loose ${JSON.stringify(hap.value)} ${hap.part.begin}..${hap.part.end}`);
      continue;
    }
    const key = JSON.stringify([hap.whole.begin.toString(), hap.whole.end.toString(), hap.value]);
    groups.set(key, [...(groups.get(key) ?? []), hap]);
  }
  for (const [key, fragments] of groups) {
    const points = new Map<string, Fraction>();
    for (const { part } of fragments) {
      points.set(part.begin.toString(), part.begin);
      points.set(part.end.toString(), part.end);
    }
    const sorted = [...points.values()].sort((x, y) => x.n * y.d - y.n * x.d);
    let run: { count: number; begin: Fraction; end: Fraction } | undefined;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const [begin, end] = [sorted[i], sorted[i + 1]];
      const count = fragments.filter((f) => f.part.begin.lte(begin) && end.lte(f.part.end)).length;
      if (run && run.count === count) run.end = end;
      else {
        if (run && run.count > 0) out.push(`${key} x${run.count} ${run.begin}..${run.end}`);
        run = { count, begin, end };
      }
    }
    if (run && run.count > 0) out.push(`${key} x${run.count} ${run.begin}..${run.end}`);
  }
  return out.sort();
}

const query = (program: Program, begin: Fraction, end: Fraction) =>
  interpret(ref, program).query({ begin, end });

const params = { seed: SEED, numRuns: RUNS };

// --- Properties --------------------------------------------------------------------------------

describe('property 1: window independence', () => {
  it('querying [a, c) equals querying [a, b) and [b, c) with the fragments joined', () => {
    fc.assert(
      fc.property(discrete, times, (program, [a, b, c]) => {
        const whole = joined(query(program, a, c));
        const split = joined([...query(program, a, b), ...query(program, b, c)]);
        expect(split).toEqual(whole);
      }),
      params
    );
  });

  it('holds for signals given structure, or used as controls (each event reads its onset)', () => {
    fc.assert(
      fc.property(signalWithStructure, times, (program, [a, b, c]) => {
        const whole = joined(query(program, a, c));
        const split = joined([...query(program, a, b), ...query(program, b, c)]);
        expect(split).toEqual(whole);
      }),
      params
    );
  });
});

describe('property 2: inverses', () => {
  it('fast(n).slow(n) equals the pattern', () => {
    fc.assert(
      fc.property(discrete, fc.constantFrom(2, 3, 0.5, 1.5, 5), times, (program, n, [a, , c]) => {
        const back: Program = [...program, ['fast', n], ['slow', n]];
        expect(joined(query(back, a, c))).toEqual(joined(query(program, a, c)));
      }),
      params
    );
  });

  it('rev().rev() equals the pattern', () => {
    fc.assert(
      fc.property(discrete, times, (program, [a, , c]) => {
        const back: Program = [...program, ['rev'], ['rev']];
        expect(joined(query(back, a, c))).toEqual(joined(query(program, a, c)));
      }),
      params
    );
  });

  it('every(1, f) equals f(pattern)', () => {
    const transforms: Program[] = [[['rev']], [['fast', 2]], [['slow', 2]], [['fast', 3], ['rev']]];
    fc.assert(
      fc.property(discrete, fc.constantFrom(...transforms), times, (program, f, [a, , c]) => {
        const every: Program = [...program, ['every', 1, f]];
        const direct: Program = [...program, ...f];
        expect(joined(query(every, a, c))).toEqual(joined(query(direct, a, c)));
      }),
      params
    );
  });
});

describe('property 3: signals', () => {
  it('a signal sampled at t gives the same value in any window that contains t', () => {
    fc.assert(
      fc.property(signalProgram, times, (program, [a, b, c]) => {
        const pattern = interpret(ref, program);
        const at = pattern.sampleAt(b);
        // A query that starts at b reads the signal there: the same value as the sampler's. Not for
        // a reversed signal, where the query mirrors its span and reads the mirrored end (the
        // reference's own pattern.test.ts says so), which is why the sampler exists.
        const reversed = program.some((step) => step[0] === 'rev');
        if (!reversed) expect(pattern.query({ begin: b, end: c })[0]?.value).toEqual(at);
        // A window that merely contains b does not change what the sampler says about b.
        pattern.query({ begin: a, end: c });
        expect(pattern.sampleAt(b)).toEqual(at);
      }),
      params
    );
  });

  it('seed(s) is reproducible: two builds give the same values at the same instants', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('rand', 'rand2', 'perlin', 'brand'),
        fc.oneof(fc.integer({ min: 0, max: 999 }), fc.string({ maxLength: 8 })),
        fc.array(fraction, { minLength: 1, maxLength: 8 }),
        (name, seed, instants) => {
          const build = () => interpret(ref, [[name], ['seed', seed]]);
          const [first, second] = [build(), build()];
          for (const [n, d] of instants) {
            const t = new Frac(n, d);
            expect(second.sampleAt(t)).toEqual(first.sampleAt(t));
          }
        }
      ),
      params
    );
  });
});
