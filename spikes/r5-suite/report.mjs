// Joins a vitest JSON result with conformance/test-classes.json and prints the pass/fail tables (spike R5)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Usage: bun spikes/r5-suite/report.mjs <vitest-json> [covered-files-comma-separated]
// A test missing from the result (its file failed to load) counts as failed with the load error as its cause.
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const covered = new Set((process.argv[3] ?? '').split(',').filter(Boolean));
const classes = JSON.parse(readFileSync(root + 'conformance/test-classes.json', 'utf8'));

const byKey = new Map();
const loadError = new Map();
for (const f of result.testResults) {
  const file = f.name.replace(root, '');
  if (f.assertionResults.length === 0) loadError.set(file, (f.message ?? '').split('\n')[0]);
  const seen = new Map();
  for (const a of f.assertionResults) {
    const name = a.ancestorTitles.concat(a.title).join(' > ');
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    byKey.set(file + '\0' + (n === 1 ? name : `${name} #${n}`), a);
  }
}

function cause(a, file) {
  if (!a) return `file did not load: ${loadError.get(file) ?? 'unknown'}`;
  const m = (a.failureMessages[0] ?? '').split('\n')[0];
  const fn =
    /\(0 , __vite_ssr_import_\d+__\.(\w+)\)(\(\.\.\.\))?(\.\w+)? is not a function/.exec(m) ??
    /(\w+)\(\.\.\.\)\.(\w+) is not a function/.exec(m);
  if (/is not a function/.test(m)) {
    const named = /\.(\w+) is not a function/.exec(m) ?? /(\w+) is not a function/.exec(m);
    return `not bound: ${named ? named[1] : m}`;
  }
  if (/signal\(fn\) is not bound/.test(m)) return 'not bound: signal(fn) with a JavaScript sampler';
  if (/cannot hold this JavaScript value/.test(m)) return `design: ${m}`;
  if (/expected instance of Handle/.test(m) || /needs a number or a pattern/.test(m))
    return 'wrapper check not written (error message differs)';
  if (/Cannot read properties of undefined/.test(m))
    return `not bound (an export is undefined): ${m.slice(0, 80)}`;
  return `other: ${m.slice(0, 110)}`;
}

const rows = {};
const causes = {};
let total = { n: 0, pass: 0 };
for (const e of classes.tests) {
  const a = byKey.get(e.file + '\0' + e.test);
  const pass = a?.status === 'passed';
  const r = (rows[e.file] ??= { public: [0, 0], internal: [0, 0], 'web-audio': [0, 0] });
  r[e.class][0] += 1;
  if (pass) r[e.class][1] += 1;
  if (e.class === 'public' && !pass) {
    const c = cause(a, e.file);
    const key =
      (covered.has(e.file) ? 'COVERED ' : 'uncovered ') +
      c.replace(/__vite_ssr_import_\d+__\./, '');
    (causes[key] ??= []).push(e.file.replace('src/', '') + ': ' + e.test);
  }
}
console.log('file | public n/pass | internal n/pass | web-audio n/pass | covered');
for (const [file, r] of Object.entries(rows))
  console.log(
    `${file} | ${r.public.join('/')} | ${r.internal.join('/')} | ${r['web-audio'].join('/')} | ${covered.has(file) ? 'yes' : 'no'}`
  );
const sum = (pred, cls) =>
  Object.entries(rows)
    .filter(([f]) => pred(f))
    .reduce((s, [, r]) => [s[0] + r[cls][0], s[1] + r[cls][1]], [0, 0]);
for (const cls of ['public', 'internal', 'web-audio'])
  console.log(
    cls,
    'all',
    sum(() => true, cls),
    'covered',
    sum((f) => covered.has(f), cls)
  );
console.log('\nfailure causes among public tests (count, cause, examples):');
for (const [c, list] of Object.entries(causes).sort((a, b) => b[1].length - a[1].length))
  console.log(list.length, '|', c, '|', list.slice(0, 2).join(' ; ').slice(0, 160));
