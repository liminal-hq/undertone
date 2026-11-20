// Tests for the opt-in pan law: the unchanged default, the side gains, pan paths, stops and precedence (ported from src/panLaw.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Fraction, score } from '@liminal-hq/undertone';

describe('panLaw', () => {
  it('is given to every score event by the definition, unless the event sets its own', () => {
    const cue = score({
      ticksPerSecond: 100,
      lengthTicks: 100,
      panLaw: 0,
      events: [
        { tick: 0, note: 'c4', pan: 0 },
        { tick: 50, note: 'e4', pan: 0, voice: { panLaw: -6 } }
      ]
    });
    const laws = cue.pattern
      .query({ begin: new Fraction(0), end: new Fraction(1) })
      .map((hap) => hap.value.panLaw);
    expect(laws).toEqual([0, -6]);
    expect(() => score({ ticksPerSecond: 100, lengthTicks: 100, panLaw: -7, events: [] })).toThrow(
      'score() panLaw must be between -6 and 0 dB, got -7'
    );
  });
});
