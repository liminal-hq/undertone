// Holds the two WebAssembly modules to their size budgets and reports raw, gzip, and Brotli sizes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: bun scripts/check-wasm-size.ts [--report] [module.wasm ...]
//
// The modules default to the two scripts/build-wasm.sh writes: the main module (packages/undertone/wasm/undertone_wasm_bg.wasm) and the
// lazily loaded render module (packages/undertone/wasm/render/undertone_wasm_render_bg.wasm). Each has its own budget after Brotli 11
// (KB is 1,000 bytes, as in R4), with a warning from 90%: the main module D-07's 150 KB; the render module 120 KB, the ceiling the
// person set for it in D-43 (the warning from 90% is 108 KB). The check fails when a module is over its budget; `--report` only
// prints (and writes no summary). gzip -9 is reported beside Brotli, with a warning line (no failure) over a gzip figure 1.2 times the
// Brotli budget, because a host that serves gzip only (GitHub Pages, probably) sends that size. The glue JavaScript beside each module
// is reported for information and has no budget. With GITHUB_STEP_SUMMARY set, the figures are appended to the job summary as a table.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

interface Budget {
  label: string;
  limit: number;
}

/** The budget of a module, by file name. */
const BUDGETS: Record<string, Budget> = {
  'undertone_wasm_bg.wasm': { label: 'main module', limit: 150_000 },
  'undertone_wasm_render_bg.wasm': { label: 'render module', limit: 120_000 }
};
const WARN = 0.9;
const GZIP_RATIO = 1.2;

const args = process.argv.slice(2);
const report = args.includes('--report');
const given = args.filter((arg) => !arg.startsWith('--'));
const paths =
  given.length > 0
    ? given
    : [
        'packages/undertone/wasm/undertone_wasm_bg.wasm',
        'packages/undertone/wasm/render/undertone_wasm_render_bg.wasm'
      ];

interface Sizes {
  raw: number;
  gzip: number;
  brotli: number;
}

function sizes(bytes: Buffer): Sizes {
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length
      }
    }).length
  };
}

const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;
const rows: string[] = [];
let failed = false;

for (const path of paths) {
  if (!existsSync(path)) {
    console.error(`check-wasm-size: ${path} does not exist; run scripts/build-wasm.sh first`);
    process.exit(1);
  }
  const budget = BUDGETS[basename(path)] ?? { label: basename(path), limit: 150_000 };
  const module = sizes(readFileSync(path));
  const gluePath = join(dirname(path), basename(path).replace(/_bg\.wasm$/, '.js'));
  const glue = existsSync(gluePath) ? sizes(readFileSync(gluePath)) : undefined;
  const share = module.brotli / budget.limit;
  const status = module.brotli > budget.limit ? 'over budget' : share > WARN ? 'warning' : 'ok';
  const gzipLimit = GZIP_RATIO * budget.limit;

  console.log(`${path} (${budget.label})`);
  console.log(
    `  module: raw ${module.raw} (${kb(module.raw)}), gzip -9 ${module.gzip} (${kb(module.gzip)}), Brotli 11 ${module.brotli} (${kb(module.brotli)})`
  );
  console.log(
    `  budget: ${kb(budget.limit)} after Brotli, warning from ${kb(WARN * budget.limit)}: ${(share * 100).toFixed(1)}%, ${status}`
  );
  if (glue) {
    console.log(
      `  glue:   ${gluePath} raw ${glue.raw}, gzip -9 ${glue.gzip}, Brotli 11 ${glue.brotli} (no budget)`
    );
  }
  rows.push(
    `| \`${basename(path)}\` (${budget.label}) | ${module.raw} | ${module.gzip} | ${module.brotli} | ${budget.limit} (${(share * 100).toFixed(1)}%) | ${status} |`
  );
  if (glue) {
    rows.push(
      `| \`${basename(gluePath)}\` (glue) | ${glue.raw} | ${glue.gzip} | ${glue.brotli} | none | - |`
    );
  }
  if (module.gzip > gzipLimit) {
    console.warn(
      `check-wasm-size: warning: the ${budget.label} is ${kb(module.gzip)} after gzip -9, over ${kb(gzipLimit)} (${GZIP_RATIO} times its Brotli budget), what a gzip-only host sends`
    );
  }
  if (status === 'warning') {
    console.warn(
      `check-wasm-size: warning: the ${budget.label} is ${kb(module.brotli)} after Brotli, over 90% of its ${kb(budget.limit)} budget`
    );
  }
  if (status === 'over budget' && !report) {
    console.error(
      `check-wasm-size: the ${budget.label} is ${kb(module.brotli)} after Brotli, over its ${kb(budget.limit)} budget. See D-07 for the order of response.`
    );
    failed = true;
  }
}

// The build's own `--report` run leaves the summary to the check step, so the table is written once.
const summary = report ? undefined : process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const table = [
    '### WebAssembly size (D-07)',
    '',
    '| File | Raw | gzip -9 | Brotli 11 | Budget (Brotli) | Status |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    ''
  ];
  appendFileSync(summary, `${table.join('\n')}\n`);
}

if (failed) process.exit(1);
