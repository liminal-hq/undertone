// Seeded, deterministic humanisation of a pattern, from the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { handleOfPattern, patternOfHandle } from './pattern.js';
import type { Pattern } from './pattern.js';
import type { ControlPatch } from './types.js';
import { glue } from './wasm.js';

export interface DriftOptions {
  /** Makes the variation repeatable. The same seed always gives the same result. */
  seed: number | string;
  /** Largest timing offset in seconds, either way, per note. Applied as a nudge. Default 0. */
  timing?: number;
  /** Largest level change as a fraction either way (0.1 = ±10% of the note's velocity). Default 0. */
  level?: number;
  /** Largest detune in cents, either way. Pitched voices only. Default 0. */
  cents?: number;
  /** Largest pan offset either way, kept within -1 to 1. Default 0. */
  pan?: number;
  /** Constant offset in seconds applied to every note: positive plays behind the beat, negative ahead of it. Default 0. */
  push?: number;
  /**
   * How many cycles make up one pass. The seed advances every pass, so pass N
   * differs from pass N+1 but is always the same for the same seed. Default 1.
   */
  cyclesPerPass?: number;
}

/**
 * Adds seeded humanisation to a pattern: small per-note timing, level, pitch
 * and pan drift, plus a constant push or pull. Off unless you set a range.
 * Every value is derived from the seed, the loop pass, the note's position and
 * its pitch — not from query order or the clock — so the same seed produces
 * the same events on every device and however the scheduler windows its
 * queries. Keep it off menu and interface sounds.
 */
export function drift(
  pattern: Pattern<ControlPatch>,
  options: DriftOptions
): Pattern<ControlPatch> {
  // The module reads the options as the reference's JavaScript does (a missing range is 0, `null` compares as 0, a numeric
  // string is used as its number), so the object goes across as given.
  return patternOfHandle(glue.drift(handleOfPattern(pattern), options));
}
