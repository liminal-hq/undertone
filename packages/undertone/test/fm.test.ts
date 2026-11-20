// Tests for FM synthesis: modulator graph, pitch-curve tracking, depth envelope and controls (ported from src/fm.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note } from '@liminal-hq/undertone';

describe('FM control validation', () => {
  it('rejects bad values', () => {
    expect(() => note('a4').fm(-1)).toThrow(/must not be negative/);
    expect(() => note('a4').fmh(0)).toThrow(/must be positive/);
    expect(() => note('a4').fmwave('white' as never)).toThrow(/must be one of/);
    expect(() => note('a4').fmenv('log' as never)).toThrow(/'lin' or 'exp'/);
  });
});
