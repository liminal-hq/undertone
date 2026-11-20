// Holds the WebAssembly control module to its D-07 size budget and reports raw, gzip, and Brotli sizes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: bun scripts/check-wasm-size.ts [--report] [module.wasm]
//
// The module defaults to packages/undertone/wasm/undertone_wasm_bg.wasm (what scripts/build-wasm.sh writes). The budget is D-07's:
// the control module at most 150 KB after Brotli (KB is 1,000 bytes, as in R4), with a warning from 90% (135 KB). The check fails
// over the limit; `--report` only prints. Brotli is quality 11 (Node's zlib, as the `brotli -q 11` tool R4 used); gzip is level 9.
// The glue JavaScript beside the module is reported for information and has no budget. With GITHUB_STEP_SUMMARY set, the figures
// are appended to the job summary as a table.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const LIMIT = 150_000;
const WARN = 0.9 * LIMIT;

const args = process.argv.slice(2);
const report = args.includes('--report');
const path =
  args.find((arg) => !arg.startsWith('--')) ?? 'packages/undertone/wasm/undertone_wasm_bg.wasm';

if (!existsSync(path)) {
  console.error(`check-wasm-size: ${path} does not exist; run scripts/build-wasm.sh first`);
  process.exit(1);
}

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
const module = sizes(readFileSync(path));
const gluePath = join(dirname(path), basename(path).replace(/_bg\.wasm$/, '.js'));
const glue = existsSync(gluePath) ? sizes(readFileSync(gluePath)) : undefined;

const share = module.brotli / LIMIT;
const status = module.brotli > LIMIT ? 'over budget' : module.brotli > WARN ? 'warning' : 'ok';

console.log(`${path}`);
console.log(
  `  module: raw ${module.raw} (${kb(module.raw)}), gzip -9 ${module.gzip}, Brotli 11 ${module.brotli} (${kb(module.brotli)})`
);
console.log(
  `  budget: ${kb(LIMIT)} after Brotli (D-07), warning from ${kb(WARN)}: ${(share * 100).toFixed(1)}%, ${status}`
);
if (glue) {
  console.log(`  glue:   ${gluePath} raw ${glue.raw}, Brotli 11 ${glue.brotli} (no budget)`);
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const rows = [
    '### WebAssembly size (D-07)',
    '',
    '| File | Raw | gzip -9 | Brotli 11 | Budget (Brotli) | Status |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    `| \`${basename(path)}\` | ${module.raw} | ${module.gzip} | ${module.brotli} | ${LIMIT} (${(share * 100).toFixed(1)}%) | ${status} |`,
    ...(glue
      ? [
          `| \`${basename(gluePath)}\` (glue) | ${glue.raw} | ${glue.gzip} | ${glue.brotli} | none | - |`
        ]
      : []),
    ''
  ];
  appendFileSync(summary, `${rows.join('\n')}\n`);
}

if (status === 'warning') {
  console.warn(
    `check-wasm-size: warning: the control module is ${kb(module.brotli)} after Brotli, over 90% of its ${kb(LIMIT)} budget`
  );
}
if (status === 'over budget' && !report) {
  console.error(
    `check-wasm-size: the control module is ${kb(module.brotli)} after Brotli, over its ${kb(LIMIT)} budget (D-07). See D-07 for the order of response.`
  );
  process.exit(1);
}
