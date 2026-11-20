// The explicit-init entry: no top-level await; the caller awaits init() once before using the API
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import initWasm from '../wasm/undertone_wasm.js';
import { install } from './install.js';
import { browserRenderLoader } from './render.browser.js';
import { setRenderLoader } from './render.js';

export * from './api.js';

setRenderLoader(browserRenderLoader);

let ready: Promise<void> | undefined;

/**
 * Instantiates the module once; calls made while it loads, and after it has loaded, share the same promise. A load that fails
 * (a fetch that dropped, say) is not kept: the next call tries again.
 */
export function init(): Promise<void> {
  ready ??= initWasm()
    .then(() => {
      install();
    })
    .catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
  return ready;
}
