// Scratch app: no bundler. A dynamic import() of the unpacked package, as a lazy-loading page does
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { run, direct } from '../shared/run.js';

const before = performance.now();
const api = await import('./pkg/index.js');
const resolved = performance.now();
globalThis.__r3dynamic = { importMs: resolved - before };
await run('dynamic import()', api, direct, api.timing.start, api.timing.ready);
globalThis.__r3.dynamicImportMs = resolved - before;
document.body.textContent = JSON.stringify(globalThis.__r3);
