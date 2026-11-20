// Loads the built render module for the tests, as the wrapper's dynamic import will (synchronously here, from disk)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// The bridge (RF-25) loads packages/undertone/wasm/render/ with a dynamic `import()` on the first render; the tests read it from
// disk and instantiate it once, a second WebAssembly instance beside the main module's (harness.ts), and the worklet's build of the same crate beside them.

import { readFileSync } from 'node:fs';
import * as render from '../../../../packages/undertone/wasm/render/undertone_wasm_render.js';
import * as speed from '../../../../packages/undertone/wasm/worklet/undertone_worklet.js';

render.initSync({
  module: readFileSync(
    new URL(
      '../../../../packages/undertone/wasm/render/undertone_wasm_render_bg.wasm',
      import.meta.url
    )
  )
});

// The worklet's build of the same crate (opt-level 3, wasm-opt -O3), a third instance: worklet.ts holds it to the same checks.
speed.initSync({
  module: readFileSync(
    new URL(
      '../../../../packages/undertone/wasm/worklet/undertone_worklet_bg.wasm',
      import.meta.url
    )
  )
});

export { render, speed };
