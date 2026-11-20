// The explicit-init entry: no top-level await; the caller awaits init() once before using the API
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import initWasm from '../wasm/undertone_wasm.js';
import { installControls } from './controlsWiring.js';

export * from './api.js';

let ready: Promise<void> | undefined;

/** Instantiates the module once; every call returns the same promise. */
export function init(): Promise<void> {
  ready ??= initWasm().then(() => {
    installControls();
  });
  return ready;
}
