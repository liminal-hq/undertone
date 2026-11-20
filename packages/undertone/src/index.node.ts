// The Node, Bun, and Deno entry: reads the module from disk and instantiates it synchronously (no await needed)
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
