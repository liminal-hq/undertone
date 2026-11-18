// Records the conformance corpus from the TypeScript reference, or checks the files against it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { recordLayer2, layer2Cases } from './controls';
import { serialiseFile } from './format';
import type { CorpusFile } from './format';
import { layer3Cases } from './graphData';
import { recordGraphCase, recordLayer3 } from './graph';
import { layer1Programs } from './programData';
import { recordLayer1 } from './programs';
import { loadReference, repoRoot } from './reference';
import type { Reference } from './reference';

const casesDir = join(repoRoot, 'conformance', 'cases');

/** Every corpus file the recorder writes: its path under `conformance/cases/` and its bytes. */
export async function generate(ref: Reference): Promise<Map<string, string>> {
  const warn = console.warn;
  console.warn = () => undefined; // the reference warns once per clamp; the corpus records values, not logs
  try {
    const layer1 = layer1Programs();
    const files: CorpusFile[] = [
      ...recordLayer1(ref, layer1),
      ...recordLayer2(ref, layer2Cases(layer1)),
      ...(await recordLayer3(ref, layer3Cases()))
    ];
    return new Map(files.map((file) => [`${file.layer}/${file.group}.json`, serialiseFile(file)]));
  } finally {
    console.warn = warn;
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
  } catch {
    return [];
  }
}

function firstDifference(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n    recorded: ${(a[i] ?? '<end of file>').slice(0, 200)}\n    on disk:  ${(b[i] ?? '<end of file>').slice(0, 200)}`;
    }
  }
  return 'no line differs';
}

/** Writes the corpus, removing files the recorder no longer makes. */
async function record(ref: Reference): Promise<void> {
  const files = await generate(ref);
  rmSync(casesDir, { recursive: true, force: true });
  for (const [path, text] of files) {
    const target = join(casesDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  console.log(`recorded ${files.size} files under ${relative(repoRoot, casesDir)}/`);
}

/** Regenerates in memory and compares with the files on disk. Exits 1 on any difference. */
async function check(ref: Reference): Promise<void> {
  const files = await generate(ref);
  const problems: string[] = [];
  for (const [path, text] of files) {
    let onDisk: string;
    try {
      onDisk = readFileSync(join(casesDir, path), 'utf8');
    } catch {
      problems.push(`${path}: missing on disk (run bun run conformance:record)`);
      continue;
    }
    if (onDisk !== text) problems.push(`${path}: differs at ${firstDifference(text, onDisk)}`);
  }
  for (const file of listFiles(casesDir)) {
    const path = relative(casesDir, file).split('\\').join('/');
    if (!files.has(path)) problems.push(`${path}: on disk but not recorded`);
  }
  if (problems.length > 0) {
    console.error(`The corpus differs from the reference:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`conformance corpus is current (${files.size} files)`);
}

/**
 * One-off cross-check: records the cases marked `baseline` (a 0.3.0 behaviour with every 0.4.0
 * option off) against another reference, such as a worktree of the v0.3.0 tag, and compares each
 * graph and score with this checkout's. Nothing is written.
 */
async function crossCheck(ref: Reference, other: Reference): Promise<void> {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const baselines = layer3Cases().filter((spec) => spec.baseline);
    let different = 0;
    for (const spec of baselines) {
      const [a, b] = await Promise.all([recordGraphCase(ref, spec), recordGraphCase(other, spec)]);
      const same =
        JSON.stringify([a.score, a.graph, a.error]) === JSON.stringify([b.score, b.graph, b.error]);
      console.log(
        `${same ? 'equal    ' : 'DIFFERENT'} ${spec.id}${b.error ? ` (other: ${String(b.error)})` : ''}`
      );
      if (!same) different += 1;
    }
    console.log(`${baselines.length - different} of ${baselines.length} baseline cases equal`);
    if (different > 0) process.exitCode = 1;
  } finally {
    console.warn = warn;
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flag = rest.indexOf('--reference');
  const referenceRoot = flag >= 0 ? resolve(rest[flag + 1] ?? '') : undefined;
  if (command === 'record' || command === 'check') {
    const ref = await loadReference(referenceRoot);
    await (command === 'record' ? record(ref) : check(ref));
  } else if (command === 'cross-check' && referenceRoot !== undefined) {
    await crossCheck(await loadReference(), await loadReference(referenceRoot));
  } else {
    console.error(
      'usage: record.ts record|check [--reference <worktree>]\n       record.ts cross-check --reference <worktree>'
    );
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
