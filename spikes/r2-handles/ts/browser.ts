// Browser entry for the R2 measurements: loads the module with fetch and exposes window.__run
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

import { load } from './wrapper.ts';
import { step1, step2, step3, type Settle } from './bench.ts';

(globalThis as Record<string, unknown>).__run = async (
  settle: Settle,
  gcInLoop: boolean,
  repeats: number
) => {
  const bytes = await (await fetch('./r2_handles_bg.wasm')).arrayBuffer();
  load(await WebAssembly.compile(bytes));
  const gc = (globalThis as Record<string, any>).gc as (() => void) | undefined;
  if (settle === 'gc' && !gc) throw new Error('no gc exposed in this browser');
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    settle,
    gcInLoop,
    step1: step1(),
    step2: step2(),
    step3: await step3({ gc, settle, gcInLoop, repeats })
  };
};
