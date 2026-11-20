// Tests for the explicit gate (duration/legato), velocity, and cut-group controls (ported from src/gate.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note } from '@liminal-hq/undertone';

describe('duration()', () => {
  it('rejects a negative duration', () => {
    expect(() => note('c3').duration(-1)).toThrow(/must not be negative/);
  });
});

describe('legato()', () => {
  it('rejects a negative fraction', () => {
    expect(() => note('c3').legato(-0.1)).toThrow(/must not be negative/);
  });
});

describe('velocity()', () => {
  it('rejects a negative velocity', () => {
    expect(() => note('c3').velocity(-1)).toThrow(/must not be negative/);
  });
});
