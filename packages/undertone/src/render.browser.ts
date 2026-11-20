// The render module in a browser: a dynamic import of its glue on the first render, which fetches and instantiates it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { RenderLoader } from './render.js';

export const browserRenderLoader: RenderLoader = {
  async: async () => {
    const render = await import('../wasm/render/undertone_wasm_render.js');
    await render.default();
    return render;
  }
};
