// Browser entry with an explicit init(): no top-level await, the caller awaits init() before using the API
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import initWasm from './wasm/r3_bridge.js';

export * from './api.js';

let ready: Promise<void> | undefined;

/** Instantiates the module once; every call returns the same promise. */
export function init(): Promise<void> {
  ready ??= initWasm().then(() => undefined);
  return ready;
}
