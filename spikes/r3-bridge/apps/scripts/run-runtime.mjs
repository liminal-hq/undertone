// Runs the five programs through the bridge in Node, Bun, or Deno and prints the call-log hash and timings
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { programs } from './programs.mjs';
import { recordingContext } from './recorder-context.mjs';

const t0 = performance.now();
const { note, timing } = await import('@liminal-hq/undertone');
const imported = performance.now();
const rows = [];
for (const program of programs) {
  const context = recordingContext();
  const before = performance.now();
  const playback = program.build(note).play({ context });
  const after = performance.now();
  const hash = createHash('sha256').update(context.log.join('\n')).digest('hex').slice(0, 16);
  rows.push({ id: program.id, hash, start: playback.startTime, playMs: after - before });
}
const runtime = globalThis.Bun
  ? `bun ${Bun.version}`
  : globalThis.Deno
    ? `deno ${Deno.version.deno}`
    : `node ${process.version}`;
console.log(
  JSON.stringify({
    runtime,
    importMs: imported - t0,
    moduleReadyMs: timing.ready - timing.start,
    rows
  })
);
