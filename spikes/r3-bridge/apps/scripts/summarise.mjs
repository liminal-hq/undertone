// Median import, module-ready, and first-play times over the JSON lines of repeated Node, Bun, or Deno runs
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(
  rows[0].runtime,
  `runs ${rows.length}`,
  `import ${med(rows.map((r) => r.importMs)).toFixed(2)} ms`,
  `ready ${med(rows.map((r) => r.moduleReadyMs)).toFixed(2)} ms`,
  `firstPlay ${med(rows.map((r) => r.rows[0].playMs)).toFixed(2)} ms`,
  `start ${rows[0].rows[0].start}`,
  `distinct hash sets ${new Set(rows.map((r) => r.rows.map((x) => x.hash).join())).size}`
);
