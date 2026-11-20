// The testing entry (D-28): helpers for tests of code that uses Undertone, kept out of the public API report
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { resetRenderWarnings } from './render.js';
import { resetWrapperWarnings } from './warn.js';
import { glue } from './wasm.js';

export { playVoice, playVoices, seedContext } from './engine.js';

/**
 * Clears the once-only set of warnings the package has given, so a test sees a warning again. The modules print their
 * warnings themselves with `console.warn` (so `vi.spyOn(console, 'warn')` sees every one) and keep a set each, the main
 * module's and the render module's; this clears both, and the few the wrapper gives itself. Before the main module is
 * loaded no warning can have been given, so it does nothing then.
 */
export function resetWarnings(): void {
  resetWrapperWarnings();
  resetRenderWarnings();
  try {
    glue.resetWarnings();
  } catch {
    // The module is not instantiated yet (the `./init` entry, before `await init()`): there is nothing to clear.
  }
}
