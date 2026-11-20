// Reads the WebAssembly module next to the glue and instantiates it synchronously, once
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { initSync } from '../wasm/undertone_wasm.js';

let loaded = false;

/** Instantiates the module from disk. Safe to call again: only the first call does anything. */
export function loadSync(): void {
  if (loaded) return;
  loaded = true;
  initSync({ module: readFileSync(new URL('../wasm/undertone_wasm_bg.wasm', import.meta.url)) });
}
