// Layer 1: programs recorded as haps (exact fractions), with the first subset's programs as data
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Hap, Pattern } from '../../src/pattern';
import { encodeValue, fractionText, messageOf, programJson } from './format';
import type { CaseRecord, CorpusFile, Json } from './format';
import { interpret } from './interpret';
import type { Program } from './interpret';
import type { Reference } from './reference';

/** A query span as two fraction texts: `"1/3"` or `"4"`. */
export type SpanText = readonly [begin: string, end: string];

/** One program in the corpus, before it is recorded. */
export interface ProgramCase {
  id: string;
  group: string;
  /** Where the program came from: a test, a documentation page, a playground example, or `generated: ...`. */
  from: string;
  program: Program;
  /** The spans to query. Default: `DEFAULT_SPANS`. */
  spans?: readonly SpanText[];
  /** Instants to read with `sampleAt` (signals). Layer 1 only. */
  samples?: readonly string[];
}

/** The spans a case is queried over unless it names its own: four cycles, the first, the third, and a span that starts inside a cycle. */
export const DEFAULT_SPANS: readonly SpanText[] = [
  ['0', '4'],
  ['0', '1'],
  ['2', '3'],
  ['1/3', '7/4']
];

/** The instants a signal case is sampled at, negative time included. */
export const DEFAULT_SAMPLES: readonly string[] = ['-3/2', '0', '1/8', '1/3', '3/4', '7/4', '13/2'];

/** A step list from a mini-notation string of words (the `word` leaf rule). */
export const words = (source: string) => ['mini', source, 'word'] as const;

/** The groups of layer 1 in the first subset, in file order. */
export const LAYER1_GROUPS = [
  'core',
  'combinators',
  'notes',
  'controls',
  'signals',
  'mini'
] as const;

export function parseFraction(ref: Reference, text: string) {
  const [numerator, denominator] = text.split('/');
  return new ref.lib.Fraction(
    Number(numerator),
    denominator === undefined ? 1 : Number(denominator)
  );
}

type Fractional = { n: number; d: number };

const cmp = (a: Fractional, b: Fractional) => a.n * b.d - b.n * a.d;

/** Orders haps as the format says: part begin, part end, whole begin, whole end (none first), then value. */
export function sortHaps(haps: readonly Hap<unknown>[]): Hap<unknown>[] {
  const valueKey = (hap: Hap<unknown>) => JSON.stringify(encodeValue(hap.value));
  return [...haps].sort((a, b) => {
    const order =
      cmp(a.part.begin, b.part.begin) ||
      cmp(a.part.end, b.part.end) ||
      (a.whole && b.whole
        ? cmp(a.whole.begin, b.whole.begin) || cmp(a.whole.end, b.whole.end)
        : Number(Boolean(a.whole)) - Number(Boolean(b.whole)));
    if (order !== 0) return order;
    const [ka, kb] = [valueKey(a), valueKey(b)];
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** One hap as the corpus writes it. */
export function encodeHap(hap: Hap<unknown>): Json {
  return {
    whole: hap.whole ? [fractionText(hap.whole.begin), fractionText(hap.whole.end)] : null,
    part: [fractionText(hap.part.begin), fractionText(hap.part.end)],
    value: encodeValue(hap.value)
  };
}

/** Builds a case's pattern, or the error that building it throws. */
export function build(
  ref: Reference,
  program: Program
): { pattern: Pattern<unknown> } | { error: string } {
  try {
    return { pattern: interpret(ref, program) };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** Records one layer 1 case: the haps of each query, or the error the program or a query throws. */
export function recordProgram(ref: Reference, spec: ProgramCase): CaseRecord {
  const head = {
    id: spec.id,
    group: spec.group,
    from: spec.from,
    program: programJson(spec.program)
  };
  const built = build(ref, spec.program);
  if ('error' in built) return { ...head, error: built.error };
  const spans = spec.spans ?? DEFAULT_SPANS;
  const haps = spans.map((span): Json => {
    try {
      const begin = parseFraction(ref, span[0]);
      const end = parseFraction(ref, span[1]);
      return sortHaps(built.pattern.query({ begin, end })).map(encodeHap);
    } catch (error) {
      return { error: messageOf(error) };
    }
  });
  const record: CaseRecord = { ...head, queries: spans.map((span) => [...span]), haps };
  if (spec.samples !== undefined) {
    record.samples = spec.samples.map((text): Json => {
      try {
        const value = built.pattern.sampleAt(parseFraction(ref, text));
        return [text, value === undefined ? null : encodeValue(value)];
      } catch (error) {
        return [text, { error: messageOf(error) }];
      }
    });
  }
  return record;
}

/** Records every layer 1 file of the first subset. */
export function recordLayer1(ref: Reference, cases: readonly ProgramCase[]): CorpusFile[] {
  return LAYER1_GROUPS.map((group) => ({
    layer: 1 as const,
    group,
    cases: cases.filter((spec) => spec.group === group).map((spec) => recordProgram(ref, spec))
  }));
}
