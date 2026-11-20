// Layer 1 of the corpus against the WebAssembly module: the recorder's own interpreter and recording, driven through the exports
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, with Bun (the recorder's modules use extensionless imports):
//   bun crates/undertone-wasm/tests/js/layer1.ts [group ...]
// With no group it runs every group part 1 of RF-24 covers (PART_1_GROUPS). For each case it rebuilds the ProgramCase from
// the corpus file, records it with conformance/recorder/programs.ts' recordProgram (the `random` group with randomCases.ts'
// recordRandom) over the test wrapper's `lib` (harness.ts), and compares the record with the corpus. A case whose program
// names something part 1 does not export (a control, `note`, `s`, or the `drum` leaf rule, which calls `s()`) is skipped and
// counted, never failed: part 2 of RF-24 adds those names, and this runner then covers them unchanged.
//
// It also compares one window of at least 1,000 haps per program of the `core` and `mini` groups with the TypeScript reference
// (src/), so the hap encoding is checked at scale, not only on the corpus's short spans.
//
// This is the start of RF-27's layer 1 runner: RF-27 points `lib` at the bridge package instead of harness.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SPANS,
  encodeHap,
  recordProgram,
  sortHaps
} from '../../../../conformance/recorder/programs';
import type { ProgramCase, SpanText } from '../../../../conformance/recorder/programs';
import { randomCases, recordRandom } from '../../../../conformance/recorder/randomCases';
import { interpret, isProgram } from '../../../../conformance/recorder/interpret';
import type { Program } from '../../../../conformance/recorder/interpret';
import type { Reference } from '../../../../conformance/recorder/reference';
import { loadReference } from '../../../../conformance/recorder/reference';
import type { Json } from '../../../../conformance/recorder/format';
import { Pattern, lib } from './harness.ts';

/** The layer 1 groups whose programs use only part 1's exports (some cases of the first three still need part 2). */
export const PART_1_GROUPS = ['core', 'mini', 'combinators', 'signals', 'random'] as const;

/** Every name a program may use with part 1's exports: the `lib` names, the Pattern methods, and the recorder's own steps. */
const SUPPORTED = new Set<string>([
  ...Object.keys(lib),
  ...Object.getOwnPropertyNames(Pattern.prototype),
  'mini',
  'pure',
  'fmap'
]);

/** The leaf rules of `mini` part 1 can run (`drum` calls `s()`, part 2). */
const SUPPORTED_LEAVES = new Set(['word', 'number', 'pitch']);

/** The first name a program uses that part 1 does not export, or undefined when it can run. */
export function unsupported(program: Program): string | undefined {
  for (const [name, ...args] of program) {
    if (!SUPPORTED.has(name)) return name;
    if (name === 'mini' && !SUPPORTED_LEAVES.has(String(args[1])))
      return `mini leaf rule "${String(args[1])}"`;
    for (const arg of args) {
      const inner = nested(arg);
      if (inner) return inner;
    }
  }
  return undefined;
}

function nested(value: unknown): string | undefined {
  if (isProgram(value)) return unsupported(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const inner = nested(item);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** Floats compare within 1e-14 relative (1e-15 absolute near zero), D-23 and D-25; everything else exactly. */
export function sameJson(a: Json, b: Json, path = ''): string | undefined {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return undefined;
    const close = Math.abs(a - b) <= Math.max(1e-15, 1e-14 * Math.max(Math.abs(a), Math.abs(b)));
    return close ? undefined : `${path}: ${a} != ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const diff = sameJson(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return undefined;
  }
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      if (!(key in a) || !(key in b)) return `${path}.${key}: missing on one side`;
      const diff = sameJson(a[key], b[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return undefined;
  }
  return JSON.stringify(a) === JSON.stringify(b)
    ? undefined
    : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

interface CorpusCase {
  id: string;
  group: string;
  from: string;
  program?: Program;
  queries?: SpanText[];
  samples?: [string, Json][];
  [key: string]: unknown;
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const wasmRef = { root, lib } as unknown as Reference;

/** Results of one group. */
export interface GroupResult {
  group: string;
  cases: number;
  passed: number;
  skipped: Map<string, number>;
  failed: string[];
}

export function runGroup(group: string): GroupResult {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/1/${group}.json`, 'utf8')) as {
    cases: CorpusCase[];
  };
  const result: GroupResult = {
    group,
    cases: file.cases.length,
    passed: 0,
    skipped: new Map(),
    failed: []
  };
  const randoms =
    group === 'random' ? new Map(randomCases().map((spec) => [spec.id, spec])) : undefined;
  for (const recorded of file.cases) {
    let record: Json;
    if (randoms) {
      const spec = randoms.get(recorded.id);
      if (!spec) {
        result.failed.push(`${recorded.id}: not in randomCases()`);
        continue;
      }
      record = recordRandom(wasmRef, spec);
    } else {
      const program = recorded.program as Program;
      const missing = unsupported(program);
      if (missing) {
        result.skipped.set(missing, (result.skipped.get(missing) ?? 0) + 1);
        continue;
      }
      const spec: ProgramCase = {
        id: recorded.id,
        group: recorded.group,
        from: recorded.from,
        program,
        spans: recorded.queries ?? DEFAULT_SPANS,
        samples: recorded.samples?.map(([at]) => at)
      };
      try {
        record = recordProgram(wasmRef, spec);
      } catch (error) {
        result.failed.push(`${recorded.id}: threw ${String(error)}`);
        continue;
      }
    }
    const diff = sameJson(record, recorded as unknown as Json);
    if (diff) result.failed.push(`${recorded.id}${diff}`);
    else result.passed += 1;
  }
  return result;
}

/** The haps of a window as the corpus writes them, sorted. */
function encoded(pattern: { query: Pattern['query'] }, begin: unknown, end: unknown): Json {
  const haps = pattern.query({ begin, end } as Parameters<Pattern['query']>[0]);
  return sortHaps(haps as never).map(encodeHap);
}

/** Compares, for each buildable program of the group, a window of at least `minimum` haps with the TypeScript reference. */
export function largeWindows(group: string, reference: Reference, minimum = 1000) {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/1/${group}.json`, 'utf8')) as {
    cases: CorpusCase[];
  };
  let compared = 0;
  let haps = 0;
  const failed: string[] = [];
  for (const recorded of file.cases) {
    const program = recorded.program as Program;
    if ('error' in recorded || unsupported(program)) continue;
    let ours: Pattern;
    let theirs: ReturnType<typeof interpret>;
    try {
      ours = interpret(wasmRef, program) as unknown as Pattern;
      theirs = interpret(reference, program);
    } catch {
      continue;
    }
    const one = theirs.query({
      begin: new reference.lib.Fraction(0),
      end: new reference.lib.Fraction(1)
    }).length;
    if (one === 0) continue;
    const cycles = Math.ceil(minimum / one);
    const a = encoded(ours, new lib.Fraction(0), new lib.Fraction(cycles));
    const b = encoded(
      theirs as never,
      new reference.lib.Fraction(0),
      new reference.lib.Fraction(cycles)
    );
    const diff = sameJson(a, b);
    if (diff) failed.push(`${recorded.id} over ${cycles} cycles${diff}`);
    compared += 1;
    haps += (a as Json[]).length;
  }
  return { group, compared, haps, failed };
}

if (import.meta.main) {
  const groups = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [...PART_1_GROUPS];
  let failures = 0;
  let total = { cases: 0, passed: 0, skipped: 0 };
  for (const group of groups) {
    const result = runGroup(group);
    const skipped = [...result.skipped.values()].reduce((sum, n) => sum + n, 0);
    total = {
      cases: total.cases + result.cases,
      passed: total.passed + result.passed,
      skipped: total.skipped + skipped
    };
    const why = [...result.skipped].map(([name, n]) => `${name} ${n}`).join(', ');
    console.log(
      `${group}: ${result.passed} of ${result.cases} equal, ${skipped} skipped${why ? ` (need part 2: ${why})` : ''}, ${result.failed.length} failed`
    );
    for (const failure of result.failed.slice(0, 20)) console.log(`  FAIL ${failure}`);
    failures += result.failed.length;
  }
  console.log(
    `layer 1: ${total.passed} of ${total.cases} equal, ${total.skipped} skipped, ${failures} failed`
  );
  const reference = await loadReference(root);
  for (const group of ['core', 'mini'].filter((g) => groups.includes(g))) {
    const large = largeWindows(group, reference);
    console.log(
      `${group}, windows of at least 1,000 haps against the TypeScript reference: ${large.compared} programs, ${large.haps} haps, ${large.failed.length} failed`
    );
    for (const failure of large.failed.slice(0, 20)) console.log(`  FAIL ${failure}`);
    failures += large.failed.length;
  }
  if (failures > 0) process.exit(1);
}
