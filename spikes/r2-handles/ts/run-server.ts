// Runs the R2 measurements in Node, Bun, or Deno (the module is read from disk)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFileSync } from 'node:fs';
import { load } from './wrapper.ts';
import { step1, step2, step3, type Settle } from './bench.ts';

const g = globalThis as Record<string, any>;
const runtime = g.Deno
  ? `deno ${g.Deno.version.deno}`
  : g.Bun
    ? `bun ${g.Bun.version}`
    : `node ${process.version}`;
const mode = (process.argv.find((a) => a.startsWith('--settle='))?.slice(9) ?? 'idle') as Settle;
const gcInLoop = process.argv.includes('--gc-in-loop');
const repeats = Number(process.argv.find((a) => a.startsWith('--repeats='))?.slice(10) ?? 3);
const forced = mode === 'gc';
const gc: (() => void) | undefined = forced
  ? (g.gc ?? (g.Bun ? () => g.Bun.gc(true) : undefined))
  : undefined;
const loopGc = gcInLoop ? (g.gc ?? (g.Bun ? () => g.Bun.gc(true) : undefined)) : undefined;
if (forced && !gc) throw new Error('--settle=gc asked for but no gc function is exposed');

const wasm = readFileSync(new URL('../pkg/r2_handles_bg.wasm', import.meta.url));
load(new WebAssembly.Module(wasm));
const result = {
  runtime,
  settle: mode,
  gcInLoop,
  step1: step1(),
  step2: step2(),
  step3: await step3({ gc: gc ?? loopGc, settle: mode, gcInLoop, repeats })
};
console.log(JSON.stringify(result));
