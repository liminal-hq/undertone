// Tests of the browser entry's explicit init(): a failed load is retried by the next call, concurrent first calls share one load
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const wasmPath = fileURLToPath(new URL('../wasm/undertone_wasm_bg.wasm', import.meta.url));

// The glue's default export is what `init()` calls to fetch and instantiate; here it fails the first `failures` times, then
// instantiates from disk (the browser's fetch has no file to read in a test).
const loads = vi.hoisted(() => ({ calls: 0, failures: 0 }));

vi.mock('../wasm/undertone_wasm.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../wasm/undertone_wasm.js')>();
  return {
    ...real,
    default: async () => {
      loads.calls += 1;
      await Promise.resolve();
      if (loads.failures > 0) {
        loads.failures -= 1;
        throw new TypeError('Failed to fetch');
      }
      real.initSync({ module: readFileSync(wasmPath) });
    }
  };
});

describe('init() of the explicit-init entry', () => {
  it('rejects every caller of a failed load, then retries on the next call instead of caching the rejection', async () => {
    const { init } = await import('../dist/init.js');
    loads.failures = 1;

    // Two callers racing on the first call share one load, and both see its failure.
    const first = init();
    const second = init();
    const settled = await Promise.allSettled([first, second]);
    expect(settled.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(loads.calls).toBe(1);

    // The failure was transient: the next call tries again, and succeeds.
    await expect(init()).resolves.toBeUndefined();
    expect(loads.calls).toBe(2);

    // A loaded module is not loaded again.
    await init();
    expect(loads.calls).toBe(2);
  });
});
