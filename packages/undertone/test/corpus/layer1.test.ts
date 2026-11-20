// Corpus layer 1 (patterns, haps, controls) through the package's public API
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { loadReference } from '../../../../conformance/recorder/reference';
import { groups, largeWindows, root, runLayer1 } from './runner';

describe('corpus layer 1 through the package', () => {
  let cases = 0;
  for (const group of groups(1)) {
    it(`${group}: every case equals the reference's record, none skipped`, () => {
      const result = runLayer1(group);
      expect(result.failed.slice(0, 10)).toEqual([]);
      expect([...result.skipped]).toEqual([]);
      expect(result.passed).toBe(result.cases);
      cases += result.passed;
    });
  }

  it('covers 1,121 cases in all', () => {
    expect(cases).toBe(1121);
  });

  it('gives the same haps as the TypeScript reference over windows of at least 1,000 haps', async () => {
    const reference = await loadReference(root);
    let programs = 0;
    for (const group of ['core', 'mini']) {
      const result = largeWindows(group, reference);
      expect(result.failed.slice(0, 10)).toEqual([]);
      programs += result.compared;
    }
    expect(programs).toBeGreaterThan(200);
  });
});
