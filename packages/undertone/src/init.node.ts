// The explicit-init entry under Node, Bun, and Deno: the module loads synchronously, so init() has nothing left to do
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { loadSync } from './load.node.js';

export * from './api.js';

loadSync();

/** Present so that code written for the browser's explicit init runs unchanged here; the module is already ready. */
export async function init(): Promise<void> {}
