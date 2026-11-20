// Keeps conformance/test-classes.json in step with the TypeScript suite: lists every test and checks each has a class
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** The three classes of RF-12, and the placeholder `update` gives a test it has not seen before. */
export const CLASSES = ['public', 'internal', 'web-audio'] as const;
export type TestClass = (typeof CLASSES)[number];

/** What RF-27 does with a test. */
export const ACTIONS = ['alias', 'translate', 'replace', 'run-on-backend', 'keep'] as const;
export type Action = (typeof ACTIONS)[number];

export interface Entry {
  file: string;
  test: string;
  class: TestClass | 'unclassified';
  covers: string;
  rule: string;
  rf27: Action | '';
  note: string;
}

export interface ClassFile {
  corpus: 1;
  description: string;
  reference: string;
  counts: { total: number; files: number; byClass: Record<string, number> };
  rules: Record<string, string>;
  tests: Entry[];
}

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const classFile = join(root, 'conformance', 'test-classes.json');

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every test the reference suite runs now (the root config's `reference` project; the package's own tests are not classified), as `{ file, test }`, from `vitest list` (sorted; a repeated title gets ` #2`, ` #3`). */
export function currentTests(): { file: string; test: string }[] {
  const run = spawnSync(
    join(root, 'node_modules', '.bin', 'vitest'),
    ['list', '--json', '--project', 'reference'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28
    }
  );
  if (run.status !== 0) {
    throw new Error(`vitest list failed (${run.status}): ${run.stderr}`);
  }
  const listed = JSON.parse(run.stdout) as { name: string; file: string }[];
  const seen = new Map<string, number>();
  const tests = listed.map(({ name, file }) => {
    const rel = relative(root, file);
    const key = `${rel}\u0000${name}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return { file: rel, test: count === 1 ? name : `${name} #${count}` };
  });
  return tests.sort((a, b) => compare(a.file, b.file) || compare(a.test, b.test));
}

/** Writes the file in a fixed layout (one test per line), refreshing the counts. */
export function format(data: ClassFile): string {
  const byClass: Record<string, number> = {};
  for (const e of data.tests) byClass[e.class] = (byClass[e.class] ?? 0) + 1;
  const counts = {
    total: data.tests.length,
    files: new Set(data.tests.map((e) => e.file)).size,
    byClass: Object.fromEntries(Object.entries(byClass).sort(([a], [b]) => compare(a, b)))
  };
  const lines = [
    '{',
    `  "corpus": 1,`,
    `  "description": ${JSON.stringify(data.description)},`,
    `  "reference": ${JSON.stringify(data.reference)},`,
    `  "counts": ${JSON.stringify(counts)},`,
    `  "rules": {`,
    Object.entries(data.rules)
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n'),
    '  },',
    '  "tests": [',
    data.tests
      .map(
        (e) =>
          '    ' +
          JSON.stringify({
            file: e.file,
            test: e.test,
            class: e.class,
            covers: e.covers,
            rule: e.rule,
            rf27: e.rf27,
            note: e.note
          })
      )
      .join(',\n'),
    '  ]',
    '}',
    ''
  ];
  return lines.join('\n');
}

export function load(): ClassFile {
  return JSON.parse(readFileSync(classFile, 'utf8')) as ClassFile;
}

/** Problems with the committed file against the suite as it is now (empty when it lists exactly the current tests, each classed). */
export function check(): string[] {
  const data = load();
  const problems: string[] = [];
  const have = new Map(data.tests.map((e) => [`${e.file}\u0000${e.test}`, e]));
  if (have.size !== data.tests.length) problems.push('the file lists a test twice');
  const now = currentTests();
  const nowKeys = new Set(now.map((t) => `${t.file}\u0000${t.test}`));
  for (const t of now) {
    const entry = have.get(`${t.file}\u0000${t.test}`);
    if (!entry) problems.push(`no class for: ${t.file}: ${t.test}`);
    else if (!(CLASSES as readonly string[]).includes(entry.class)) {
      problems.push(`not classified (${entry.class}): ${t.file}: ${t.test}`);
    } else if (!(ACTIONS as readonly string[]).includes(entry.rf27)) {
      problems.push(`no RF-27 action: ${t.file}: ${t.test}`);
    }
  }
  for (const e of data.tests) {
    if (!nowKeys.has(`${e.file}\u0000${e.test}`))
      problems.push(`no longer in the suite: ${e.file}: ${e.test}`);
  }
  if (format(data) !== readFileSync(classFile, 'utf8')) {
    problems.push(
      'the file is not in the layout `update` writes (counts or ordering differ); run `bun run test-classes:update`'
    );
  }
  return problems;
}

/** Re-lists the suite: keeps the class of every test still there, adds new ones as `unclassified`, drops the gone. */
export function update(): void {
  const data = load();
  const have = new Map(data.tests.map((e) => [`${e.file}\u0000${e.test}`, e]));
  data.tests = currentTests().map(
    (t) =>
      have.get(`${t.file}\u0000${t.test}`) ?? {
        ...t,
        class: 'unclassified',
        covers: '',
        rule: '',
        rf27: '',
        note: ''
      }
  );
  writeFileSync(classFile, format(data));
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === 'check') {
    const problems = check();
    if (problems.length > 0) {
      console.error(problems.slice(0, 40).join('\n'));
      if (problems.length > 40) console.error(`... and ${problems.length - 40} more`);
      console.error(
        `test-classes: ${problems.length} problem(s). Run \`bun run test-classes:update\`, then class each new test by hand.`
      );
      process.exit(1);
    }
    console.log(`test-classes: ok (${load().tests.length} tests, each classed)`);
  } else if (mode === 'update') {
    update();
    console.log(
      'test-classes: updated; give each `unclassified` test a class, a covers, a rule, and an rf27 action'
    );
  } else {
    console.error('usage: bun conformance/recorder/test-classes.ts check|update');
    process.exit(2);
  }
}
