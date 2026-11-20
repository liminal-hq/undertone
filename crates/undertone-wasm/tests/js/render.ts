// Loads the built render module for the tests, as the wrapper's dynamic import will (synchronously here, from disk)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// The bridge (RF-25) loads packages/undertone/wasm/render/ with a dynamic `import()` on the first render; the tests read it from
// disk and instantiate it once, a second WebAssembly instance beside the main module's (harness.ts).

import { readFileSync } from 'node:fs';
import * as render from '../../../../packages/undertone/wasm/render/undertone_wasm_render.js';

render.initSync({
  module: readFileSync(
    new URL(
      '../../../../packages/undertone/wasm/render/undertone_wasm_render_bg.wasm',
      import.meta.url
    )
  )
});

export { render };
