// The corpus file format: value encoding, number printing, and the canonical file layout
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/** The corpus format version. A format change bumps it and regenerates every file in the same commit. */
export const CORPUS_VERSION = 1;

/** A JSON value as the corpus writes it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One recorded case: plain fields in a fixed order. */
export type CaseRecord = { [key: string]: Json };

/** One corpus file: the cases of a layer's group. */
export interface CorpusFile {
  layer: 1 | 2 | 3;
  group: string;
  cases: CaseRecord[];
}

/** An exact fraction as the corpus writes it: `n/d` in lowest terms, integers included (`4/1`). */
export function fractionText(fraction: { n: number; d: number }): string {
  return `${fraction.n}/${fraction.d}`;
}

/**
 * A number as JSON can hold it. Values JSON cannot print (NaN, the infinities, and negative zero)
 * become `{ "$num": "NaN" }` and so on, so no value loses its identity in the file.
 */
export function encodeNumber(value: number): Json {
  if (Number.isNaN(value)) return { $num: 'NaN' };
  if (value === Infinity) return { $num: 'Infinity' };
  if (value === -Infinity) return { $num: '-Infinity' };
  if (Object.is(value, -0)) return { $num: '-0' };
  return value;
}

/**
 * Any value a hap or a resolved voice can hold, as JSON with its object keys sorted (so key order
 * never depends on how the reference built the object). An `undefined` field is left out; an
 * `undefined` array element or a bare `undefined` becomes `{ "$undefined": true }`.
 */
export function encodeValue(value: unknown): Json {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map((item) => encodeValue(item));
  if (typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined) out[key] = encodeValue(field);
    }
    return out;
  }
  return { $unsupported: typeof value };
}

/** A number to nine significant digits, the precision of layer 3. Non-finite values stay as `encodeNumber` writes them. */
export function nineDigits(value: number): Json {
  if (!Number.isFinite(value) || value === 0) return encodeNumber(value);
  return Number(value.toPrecision(9));
}

/** The same value as a call-string token: JavaScript's own number printing at nine digits. */
export function nineDigitsText(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return String(Number(value.toPrecision(9)));
}

/** How many array levels of a field print one element per line (the rest of the field is compact). */
const LINEWISE: Record<string, number> = {
  haps: 2,
  events: 1,
  score: 1,
  nodes: 1,
  buffers: 1,
  waves: 1
};

function emitLines(value: Json, depth: number, indent: string): string {
  if (depth === 0 || !Array.isArray(value) || value.length === 0) return JSON.stringify(value);
  const inner = `${indent}  `;
  const lines = value.map((item) => `${inner}${emitLines(item, depth - 1, inner)}`);
  return `[\n${lines.join(',\n')}\n${indent}]`;
}

function emitObject(object: { [key: string]: Json }, indent: string): string {
  const inner = `${indent}  `;
  const lines = Object.entries(object).map(([key, value]) => {
    const nested = key === 'graph' && typeof value === 'object' && !Array.isArray(value);
    const text = nested
      ? emitObject(value as { [key: string]: Json }, inner)
      : emitLines(value, LINEWISE[key] ?? 0, inner);
    return `${inner}${JSON.stringify(key)}: ${text}`;
  });
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

/** The bytes of one corpus file: a stable layout, one hap, event, or node per line, a trailing newline. */
export function serialiseFile(file: CorpusFile): string {
  const cases = file.cases.map((record) => `    ${emitObject(record, '    ')}`);
  const body = cases.length === 0 ? '[]' : `[\n${cases.join(',\n')}\n  ]`;
  return `{\n  "corpus": ${CORPUS_VERSION},\n  "layer": ${file.layer},\n  "group": ${JSON.stringify(file.group)},\n  "cases": ${body}\n}\n`;
}

/** The message of a thrown value, word for word. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A program as the JSON it is: steps of names and plain arguments. */
export function programJson(program: readonly unknown[]): Json {
  return program as unknown as Json;
}
