// The render module under Node, Bun, and Deno: instantiated synchronously from disk the first time a render or encodeWav needs it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import * as render from '../wasm/render/undertone_wasm_render.js';
import type { RenderLoader } from './render.js';

// The glue is imported with the entry (it is plain JavaScript and instantiates nothing); the module itself is read and
// compiled only on first use, so a program that never renders never pays for it.
function loadRenderSync(): typeof render {
  render.initSync({
    module: readFileSync(new URL('../wasm/render/undertone_wasm_render_bg.wasm', import.meta.url))
  });
  return render;
}

export const nodeRenderLoader: RenderLoader = {
  sync: loadRenderSync,
  async: () => Promise.resolve().then(loadRenderSync)
};
