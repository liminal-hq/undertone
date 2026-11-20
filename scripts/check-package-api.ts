// Compares the package's emitted declarations with the 0.4.0 API report, name by name, against an allow-list of what is pending
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// `bun run package:api` (after `bun run package:build`). For every name in conformance/api/undertone.api.md it prints
// present (the same declaration), different, missing, or pending (missing and listed in conformance/api/package-pending.txt),
// and for the classes and interfaces it does the same for each member. It fails when
//   - a name or member is missing and not listed (the list is how the work is tracked);
//   - a listed name or member exists after all (delete the line: the list only shrinks);
//   - a declaration differs and no `~` line accepts it;
//   - the package declares a name or member the reference does not, and no `+` line accepts it.
// Private members (`private x`, `#private`) are not public API (B7) and are left out of both sides.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../conformance/api/report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const referencePath = join(root, 'conformance', 'api', 'undertone.api.md');
const pendingPath = join(root, 'conformance', 'api', 'package-pending.txt');
const entry = join(root, 'packages', 'undertone', 'dist', 'index.d.ts');

type Status = 'present' | 'different' | 'missing' | 'pending' | 'extra';

/** `Name -> declaration text` from a report. */
function parseReport(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of text.matchAll(/^## (.+)\n\n```ts\n([\s\S]*?)\n```/gm)) {
    out.set(match[1], match[2]);
  }
  return out;
}

/** A whitespace-normalised copy, with accessors written as the properties they act as. */
function normalise(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\bget (\w+)\(\): ([^;]*);/g, 'readonly $1: $2;')
    .replace(/\?: ([^;,)]*?) \| undefined/g, '?: $1')
    .replace(/\bdeclare\b ?/g, '')
    .replace(/\blet\b|\bconst\b|\bvar\b/g, '')
    .trim();
}

/** A class's or interface's members, `name -> normalised text`, private ones left out; undefined for any other declaration. */
function members(text: string): Map<string, string> | undefined {
  if (!/^export (declare )?(class|interface) /.test(text)) return undefined;
  const out = new Map<string, string>();
  const lines = text.split('\n');
  let current: { name: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const joined = current.lines.join('\n');
    if (!/^\s*(private |#private)/.test(joined)) {
      const text = normalise(joined);
      // Overloads share a name: keep them together.
      out.set(current.name, out.has(current.name) ? `${out.get(current.name)} | ${text}` : text);
    }
    current = undefined;
  };
  for (const line of lines.slice(1)) {
    const header =
      /^ {4}(?:static |readonly |get |private |protected )*([A-Za-z0-9_]+|\[[^\]]+\]|constructor)\??[(<:;]/.exec(
        line
      );
    if (header && !line.startsWith('     ')) {
      flush();
      current = { name: header[1], lines: [line] };
    } else if (/^ {4}#private/.test(line)) {
      flush();
    } else if (current && line.startsWith('     ')) {
      current.lines.push(line);
    } else if (current && /^ {4}[}\]]/.test(line)) {
      current.lines.push(line);
    } else if (line === '}') {
      flush();
    }
  }
  flush();
  return out;
}

interface Allow {
  pending: Set<string>;
  accepted: Set<string>;
  additions: Set<string>;
}

function readAllow(): Allow {
  const allow: Allow = { pending: new Set(), accepted: new Set(), additions: new Set() };
  for (const raw of readFileSync(pendingPath, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (line.startsWith('~')) allow.accepted.add(line.slice(1).trim());
    else if (line.startsWith('+')) allow.additions.add(line.slice(1).trim());
    else allow.pending.add(line);
  }
  return allow;
}

const reference = parseReport(readFileSync(referencePath, 'utf8'));
const packaged = parseReport(buildReport(entry));
const allow = readAllow();

const rows: { name: string; status: Status }[] = [];
const problems: string[] = [];
const counts: Record<Status, number> = {
  present: 0,
  different: 0,
  missing: 0,
  pending: 0,
  extra: 0
};
const used = new Set<string>();

function record(name: string, status: Status, detail?: string): void {
  rows.push({ name, status });
  counts[status] += 1;
  if (status === 'pending') used.add(name);
  if (detail) console.log(`${status.padEnd(9)} ${name}\n          ${detail}`);
}

/** Judges one name or member: its reference text against the package's, or its absence. */
function judge(name: string, expected: string | undefined, actual: string | undefined): void {
  if (expected === undefined) {
    if (allow.additions.has(name)) {
      used.add(`+${name}`);
      record(name, 'extra');
    } else {
      record(name, 'extra', 'in the package, not in the reference (accept with a `+` line)');
      problems.push(`${name} is not in the reference API`);
    }
  } else if (actual === undefined) {
    if (allow.pending.has(name)) {
      record(name, 'pending');
    } else {
      record(name, 'missing', 'missing and not listed as pending');
      problems.push(`${name} is missing and not listed as pending`);
    }
  } else if (allow.pending.has(name)) {
    record(name, normalise(expected) === normalise(actual) ? 'present' : 'different');
    problems.push(`${name} exists but is still listed as pending: delete the line`);
  } else if (normalise(expected) === normalise(actual)) {
    record(name, 'present');
  } else if (allow.accepted.has(name)) {
    used.add(`~${name}`);
    record(name, 'present');
  } else {
    record(
      name,
      'different',
      `reference: ${normalise(expected)}\n          package:   ${normalise(actual)}`
    );
    problems.push(`${name} differs from the reference`);
  }
}

const names = [...new Set([...reference.keys(), ...packaged.keys()])].sort();
for (const name of names) {
  const expected = reference.get(name);
  const actual = packaged.get(name);
  const expectedMembers = expected === undefined ? undefined : members(expected);
  const actualMembers = actual === undefined ? undefined : members(actual);
  if (expectedMembers && actualMembers) {
    // A class or interface: judge each member, and the name by its worst member.
    const memberNames = [...new Set([...expectedMembers.keys(), ...actualMembers.keys()])].sort();
    for (const member of memberNames) {
      judge(`${name}.${member}`, expectedMembers.get(member), actualMembers.get(member));
    }
  } else if (expectedMembers && actual === undefined) {
    // A whole class missing: one row for the name, or pending members.
    judge(name, expected, actual);
  } else {
    judge(name, expected, actual);
  }
}

for (const line of [
  ...allow.pending,
  ...[...allow.accepted].map((l) => `~${l}`),
  ...[...allow.additions].map((l) => `+${l}`)
]) {
  if (
    !used.has(line) &&
    !line.startsWith('~') &&
    !line.startsWith('+') &&
    !rows.some((r) => r.name === line)
  ) {
    problems.push(
      rows.some((r) => r.name.startsWith(`${line}.`))
        ? `${line} exists in the package but is still listed as pending: delete the line`
        : `${line} is listed but is not a name in the reference or the package`
    );
  }
  if (line.startsWith('~') && !used.has(line))
    problems.push(`${line} accepts a difference that no longer exists`);
  if (line.startsWith('+') && !used.has(line))
    problems.push(`${line} accepts an addition that no longer exists`);
}

const width = Math.max(...rows.map((row) => row.name.length));
if (process.argv.includes('--verbose')) {
  for (const row of rows) console.log(`${row.status.padEnd(9)} ${row.name.padEnd(width)}`);
}
console.log(
  `\nPackage API against the 0.4.0 report: ${counts.present} present, ${counts.pending} pending, ${counts.missing} missing, ${counts.different} different, ${counts.extra} accepted additions (${rows.length} names and members).`
);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
