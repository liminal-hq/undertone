// The default entry: instantiates the WebAssembly module with top-level await, so the API works right after import
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import init from '../wasm/undertone_wasm.js';
import { install } from './install.js';

export * from './api.js';

await init();
install();
