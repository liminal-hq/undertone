// Browser entry: instantiates the module with top-level await, so note() works right after import
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import init from './wasm/r3_bridge.js';

export * from './api.js';

/** When the module started to load and when it was ready, in `performance.now()` milliseconds. */
export const timing: { start: number; ready: number } = { start: performance.now(), ready: 0 };

await init();
timing.ready = performance.now();
