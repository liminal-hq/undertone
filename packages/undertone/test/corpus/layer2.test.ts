// Corpus layer 2 (programs booked as voices and resolved to VoiceParams) through the package's public API
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { groups, runLayer2 } from './runner';

describe('corpus layer 2 through the package', () => {
  let cases = 0;
  for (const group of groups(2)) {
    it(`${group}: every case resolves to the reference's voice parameters`, () => {
      const result = runLayer2(group);
      expect(result.failed.slice(0, 10)).toEqual([]);
      expect(result.passed).toBe(result.cases);
      cases += result.passed;
    });
  }

  it('covers 335 cases in all', () => {
    expect(cases).toBe(335);
  });
});
