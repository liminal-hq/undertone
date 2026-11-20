// Runs the conformance corpus (layers 1 and 2) through the package's public API, so the wrapper is proved, not only the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The logic is that of crates/undertone-wasm/tests/js/layer1.ts and layer2.ts, which drive the module's exports through a test
// stand-in for the wrapper (harness.ts). Here `lib` is the package itself (`@liminal-hq/undertone`, plus `resetWarnings` from
// its `./testing` entry), so what runs is the code a user imports: the Pattern class, the generated control methods, the
// constants, and the wrapper's refusals. The onset collection of layer 2 (`collectOnsets`, a few lines of the reference's
// scheduler) is still a JavaScript stand-in, resolved by the package's `resolveParams`, until the scheduler exports land.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pkg from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';
import { recordVoices } from '../../../../conformance/recorder/controls';
import type { VoiceCase } from '../../../../conformance/recorder/controls';
import type { Json } from '../../../../conformance/recorder/format';
import { interpret, isProgram } from '../../../../conformance/recorder/interpret';
import type { Program } from '../../../../conformance/recorder/interpret';
import {
  DEFAULT_SPANS,
  encodeHap,
  recordProgram,
  sortHaps
} from '../../../../conformance/recorder/programs';
import type { ProgramCase, SpanText } from '../../../../conformance/recorder/programs';
import { randomCases, recordRandom } from '../../../../conformance/recorder/randomCases';
import type { Reference } from '../../../../conformance/recorder/reference';

export const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** The package as the recorder's `lib`: every public name, plus the testing entry's `resetWarnings`. */
export const lib = { ...pkg, resetWarnings };

/** `collectOnsets` of the reference's scheduler, over the package's `resolveParams`. */
const scheduler = {
  cycleSecondsFor: (_bpm: number | undefined, cps: number) => 1 / cps,
  collectOnsets(
    pattern: pkg.Pattern<Record<string, unknown>>,
    span: pkg.TimeSpan,
    patternStartTime: number,
    cycleSeconds: number,
    gated: boolean
  ) {
    const voices: { startTime: number; params: unknown }[] = [];
    for (const hap of pattern.query(span)) {
      if (!hap.whole || !hap.whole.begin.eq(hap.part.begin)) continue;
      const startTime = patternStartTime + hap.whole.begin.toNumber() * cycleSeconds;
      const eventSeconds = hap.whole.end.sub(hap.whole.begin).toNumber() * cycleSeconds;
      const legato = hap.value.legato as number | undefined;
      const patch =
        legato !== undefined
          ? { duration: eventSeconds * legato, ...hap.value }
          : gated
            ? { duration: eventSeconds, ...hap.value }
            : hap.value;
      voices.push({ startTime, params: pkg.resolveParams(patch) });
    }
    return voices;
  }
};

const packageReference = { root, lib, scheduler } as unknown as Reference;

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

/** Every name a program may use with the package: the `lib` names, the Pattern methods, and the recorder's own steps. */
const SUPPORTED = new Set<string>([
  ...Object.keys(lib),
  ...Object.getOwnPropertyNames(pkg.Pattern.prototype),
  'mini',
  'pure',
  'fmap'
]);
const SUPPORTED_LEAVES = new Set(['word', 'number', 'pitch', 'drum']);

/** The first name a program uses that the package does not export, or undefined when it can run. */
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

interface Layer1Case {
  id: string;
  group: string;
  from: string;
  program?: Program;
  queries?: SpanText[];
  samples?: [string, Json][];
  [key: string]: unknown;
}

/** The groups of the corpus for a layer, from its files. */
export function groups(layer: 1 | 2): string[] {
  return readdirSync(`${root}conformance/cases/${layer}`)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

export interface GroupResult {
  group: string;
  cases: number;
  passed: number;
  skipped: Map<string, number>;
  failed: string[];
  /** Layer 2: the resolved voice objects compared. */
  objects: number;
}

export function runLayer1(group: string): GroupResult {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/1/${group}.json`, 'utf8')) as {
    cases: Layer1Case[];
  };
  const result: GroupResult = {
    group,
    cases: file.cases.length,
    passed: 0,
    skipped: new Map(),
    failed: [],
    objects: 0
  };
  const randoms =
    group === 'random' ? new Map(randomCases().map((spec) => [spec.id, spec])) : undefined;
  resetWarnings();
  for (const recorded of file.cases) {
    let record: Json;
    if (randoms) {
      const spec = randoms.get(recorded.id);
      if (!spec) {
        result.failed.push(`${recorded.id}: not in randomCases()`);
        continue;
      }
      record = recordRandom(packageReference, spec);
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
        record = recordProgram(packageReference, spec);
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

export function runLayer2(group: string): GroupResult {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/2/${group}.json`, 'utf8')) as {
    cases: (VoiceCase & { events?: Json[] })[];
  };
  const result: GroupResult = {
    group,
    cases: file.cases.length,
    passed: 0,
    skipped: new Map(),
    failed: [],
    objects: 0
  };
  resetWarnings();
  for (const recorded of file.cases) {
    const spec: VoiceCase = {
      id: recorded.id,
      group: recorded.group,
      from: recorded.from,
      program: recorded.program,
      cycles: recorded.cycles,
      cps: recorded.cps,
      gated: recorded.gated
    };
    let record: Json;
    try {
      record = recordVoices(packageReference, spec) as unknown as Json;
    } catch (error) {
      result.failed.push(`${recorded.id}: threw ${String(error)}`);
      continue;
    }
    const diff = sameJson(record, recorded as unknown as Json);
    if (diff) {
      result.failed.push(`${recorded.id}${diff}`);
      continue;
    }
    result.passed += 1;
    result.objects += recorded.events?.length ?? 0;
  }
  return result;
}

/** The haps of a window as the corpus writes them, sorted. */
function encoded(
  pattern: { query: (span: never) => unknown[] },
  begin: unknown,
  end: unknown
): Json {
  const haps = pattern.query({ begin, end } as never);
  return sortHaps(haps as never).map(encodeHap);
}

/** Compares, for each buildable program of a group, a window of at least `minimum` haps with the TypeScript reference. */
export function largeWindows(group: string, reference: Reference, minimum = 1000) {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/1/${group}.json`, 'utf8')) as {
    cases: Layer1Case[];
  };
  let compared = 0;
  let haps = 0;
  const failed: string[] = [];
  for (const recorded of file.cases) {
    const program = recorded.program as Program;
    if ('error' in recorded || unsupported(program)) continue;
    let ours: pkg.Pattern<unknown>;
    let theirs: ReturnType<typeof interpret>;
    try {
      ours = interpret(packageReference, program) as unknown as pkg.Pattern<unknown>;
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
    const a = encoded(ours, new pkg.Fraction(0), new pkg.Fraction(cycles));
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
