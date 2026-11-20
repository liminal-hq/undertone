// The explicit-init entry under Node, Bun, and Deno: the module loads synchronously, so init() has nothing left to do
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { install } from './install.js';
import { loadSync } from './load.node.js';
import { setRenderLoader } from './render.js';
import { nodeRenderLoader } from './render.node.js';

export * from './api.js';

setRenderLoader(nodeRenderLoader);
loadSync();
install();

/** Present so that code written for the browser's explicit init runs unchanged here; the module is already ready. */
export async function init(): Promise<void> {}
