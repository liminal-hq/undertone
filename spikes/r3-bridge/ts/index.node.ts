// Node, Bun, and Deno entry: reads the module from disk and instantiates it synchronously, so no await is needed
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { initSync } from './wasm/r3_bridge.js';

export * from './api.js';

/** When the module started to load and when it was ready, in `performance.now()` milliseconds. */
export const timing: { start: number; ready: number } = { start: performance.now(), ready: 0 };

initSync({ module: readFileSync(new URL('./wasm/r3_bridge_bg.wasm', import.meta.url)) });
timing.ready = performance.now();

/** Present so that code written for the explicit-init entry runs unchanged here; the module is already ready. */
export async function init(): Promise<void> {}
