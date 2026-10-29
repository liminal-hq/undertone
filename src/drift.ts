// Seeded, deterministic humanisation: timing, level, pitch and pan drift that varies each loop pass
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction } from './fraction.js';
import { Pattern } from './pattern.js';
import type { Hap } from './pattern.js';
import { noteToFrequency } from './pitch.js';
import { seededRandom } from './random.js';
import type { ControlPatch } from './types.js';

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

function offset(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
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
  const { seed, timing = 0, level = 0, cents = 0, pan = 0, push = 0 } = options;
  const cyclesPerPass = options.cyclesPerPass ?? 1;
  if (!Number.isInteger(cyclesPerPass) || cyclesPerPass < 1) {
    throw new Error(`drift() cyclesPerPass must be a positive integer, got ${cyclesPerPass}`);
  }
  for (const [name, value] of [
    ['timing', timing],
    ['level', level],
    ['cents', cents],
    ['pan', pan]
  ] as const) {
    if (!(value >= 0)) {
      throw new Error(`drift() ${name} must not be negative, got ${value}`);
    }
  }

  return new Pattern((span) =>
    pattern.query(span).map((hap): Hap<ControlPatch> => {
      if (!hap.whole) {
        return hap;
      }
      // Keyed by the pass and the note's position *within* the pass, so a repeat of the
      // same material in a later pass is humanised differently, but the same way every time.
      const pass = Math.floor(hap.whole.begin.floor() / cyclesPerPass);
      const inPass = hap.whole.begin.sub(new Fraction(pass * cyclesPerPass));
      const key = `${seed}|${pass}|${inPass.n}/${inPass.d}|${hap.value.pitch ?? ''}`;
      const random = seededRandom(key);
      const value: ControlPatch = { ...hap.value };

      const nudge = (value.nudgeTime ?? 0) + push + (timing > 0 ? offset(random, timing) : 0);
      if (nudge !== 0) value.nudgeTime = nudge;
      if (level > 0) value.velocity = (value.velocity ?? 1) * (1 + offset(random, level));
      if (cents > 0 && value.pitch !== undefined && value.sampleName === undefined) {
        value.pitch = noteToFrequency(value.pitch) * 2 ** (offset(random, cents) / 1200);
      }
      if (pan > 0) {
        value.pan = Math.max(-1, Math.min(1, (value.pan ?? 0) + offset(random, pan)));
      }
      return { ...hap, value };
    })
  );
}
