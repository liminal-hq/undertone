// The testing entry (D-28): helpers for tests of code that uses Undertone; `resetWarnings` is live; the engine helpers wait for the engine exports
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { glue } from './wasm.js';

// What each helper needs from the module is listed in docs/rust-migration/results/M6-BOUNDARY.md, section 8. This entry is
// not part of the API report (D-28).

/**
 * Clears the once-only set of warnings the package has given, so a test sees a warning again. The module prints each warning
 * itself with `console.warn` (so `vi.spyOn(console, 'warn')` sees it) and keeps the set; this calls its `resetWarnings`.
 * Before the module is loaded no warning can have been given, so it does nothing then.
 */
export function resetWarnings(): void {
  try {
    glue.resetWarnings();
  } catch {
    // The module is not instantiated yet (the `./init` entry, before `await init()`): there is nothing to clear.
  }
}

const pending = (name: string, needs: string): never => {
  throw new Error(`${name}() is not available yet: it needs ${needs} (RF-24 part 2, then RF-26)`);
};

/** Seeds the noise and impulse-response randomness of one context, so a render is repeatable. Needs the engine export. */
export const seedContext: (ctx: object, seed: number | string) => void = () =>
  pending('seedContext', 'the engine export that seeds a context');

/** Plays one resolved voice on a context (the reference's `playVoice`, now `playParams`). Needs the engine export. */
export const playVoice: (ctx: object, params: object, options?: object) => unknown = () =>
  pending('playVoice', 'Engine::play_params');

/** Plays several resolved voices on a context. Needs the engine export. */
export const playVoices: (
  ctx: object,
  voices: readonly object[],
  options?: object
) => unknown = () => pending('playVoices', 'Engine::play_params');
