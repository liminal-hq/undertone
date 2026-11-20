// The testing entry (D-28): helpers for tests of code that uses Undertone; scaffolded until the engine exports land
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// What each helper needs from the module is listed in docs/rust-migration/results/M6-BOUNDARY.md, section 8. This entry is
// not part of the API report (D-28). Nothing here needs the module to be loaded.

/** Clears the once-only set of warnings the package has given, so a test sees a warning again. No warning exists yet. */
export function resetWarnings(): void {}

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
