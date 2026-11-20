// Layer 2 of the corpus against the WebAssembly module: programs booked as voices and resolved to VoiceParams
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, with Bun (the recorder's modules use extensionless imports):
//   bun crates/undertone-wasm/tests/js/layer2.ts [group ...]
// For each case of conformance/cases/2 it records the case with the recorder's own recordVoices (conformance/recorder/
// controls.ts) over the test wrapper (harness.ts): the program is built through the module's exports, each cycle is
// queried through the module, and each onset is resolved with the module's resolveParams. The onset collection itself
// (`collectOnsets`, a few lines of the reference's scheduler) is the harness's JavaScript stand-in, because the scheduler
// is part 2b. The record is compared with the corpus under the comparator the Rust runners use: every key, string, and
// structure exactly, every number identical or within a relative 1e-14 (an absolute 1e-15 near zero), D-23. It prints the
// counts per group and the cases that needed the tolerance; any failure exits non-zero.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordVoices } from '../../../../conformance/recorder/controls';
import type { VoiceCase } from '../../../../conformance/recorder/controls';
import type { Json } from '../../../../conformance/recorder/format';
import type { Reference } from '../../../../conformance/recorder/reference';
import { lib, scheduler } from './harness.ts';
import { sameJson } from './layer1.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const wasmRef = { root, lib, scheduler } as unknown as Reference;

/** Whether two records are equal only through the float tolerance (exactly equal JSON is not). */
function exact(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The keys of a record in a fixed order, so `exact` compares values, not insertion order. */
function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, Json>)[key])])
    );
  }
  return value;
}

export function runGroup(group: string) {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/2/${group}.json`, 'utf8')) as {
    cases: (VoiceCase & { events?: Json[]; error?: string })[];
  };
  let passed = 0;
  let objects = 0;
  const tolerant: string[] = [];
  const failed: string[] = [];
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
      record = recordVoices(wasmRef, spec) as unknown as Json;
    } catch (error) {
      failed.push(`${recorded.id}: threw ${String(error)}`);
      continue;
    }
    const diff = sameJson(record, recorded as unknown as Json);
    if (diff) {
      failed.push(`${recorded.id}${diff}`);
      continue;
    }
    passed += 1;
    objects += recorded.events?.length ?? 0;
    if (!exact(sorted(record), sorted(recorded as unknown as Json))) tolerant.push(recorded.id);
  }
  return { group, cases: file.cases.length, passed, objects, tolerant, failed };
}

if (import.meta.main) {
  const all = readdirSync(`${root}conformance/cases/2`)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  const groups = process.argv.slice(2).length > 0 ? process.argv.slice(2) : all;
  let failures = 0;
  let cases = 0;
  let passed = 0;
  const tolerant: string[] = [];
  for (const group of groups) {
    lib.resetWarnings();
    const result = runGroup(group);
    cases += result.cases;
    passed += result.passed;
    tolerant.push(...result.tolerant);
    console.log(
      `${group}: ${result.passed} of ${result.cases} equal (${result.objects} resolved objects, ${result.tolerant.length} only within the tolerance), ${result.failed.length} failed`
    );
    for (const failure of result.failed.slice(0, 20)) console.log(`  FAIL ${failure}`);
    failures += result.failed.length;
  }
  console.log(`layer 2: ${passed} of ${cases} equal, ${failures} failed`);
  if (tolerant.length > 0) console.log(`only within the tolerance: ${tolerant.join(', ')}`);
  if (failures > 0) process.exit(1);
}
