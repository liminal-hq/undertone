// The Node, Bun, and Deno entry: reads the module from disk and instantiates it synchronously (no await needed)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { installControls } from './controlsWiring.js';
import { loadSync } from './load.node.js';

export * from './api.js';

loadSync();
installControls();
