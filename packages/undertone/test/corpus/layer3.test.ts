// Corpus layer 3 (booked graphs on the fake contexts) through the package's public API and its Web Audio backend
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAudioParam } from '../../../../src/test-utils/fakeAudioContext';
import { runLayer3 } from './engine';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('corpus layer 3 through the package', () => {
  it('books every case as the reference recorded it, group by group (337 cases)', async () => {
    const results = await runLayer3();
    for (const result of results) {
      expect({ group: result.group, failed: result.failed.slice(0, 5) }).toEqual({
        group: result.group,
        failed: []
      });
      expect(result.passed).toBe(result.cases);
    }
    expect(results.reduce((sum, result) => sum + result.passed, 0)).toBe(337);
    // Wave coefficients and a few gain values agree only within the Rust runner's 1e-15 floor: the same 11 cases as through
    // the module alone (crates/undertone-wasm/tests/js/layer3.ts).
    expect(results.flatMap((result) => result.floor)).toHaveLength(11);
  });

  it('fails nearly every case when the booked values move by 1e-9 (a negative control)', async () => {
    const original = FakeAudioParam.prototype.setValueAtTime;
    vi.spyOn(FakeAudioParam.prototype, 'setValueAtTime').mockImplementation(function (
      this: FakeAudioParam,
      value: number,
      time: number
    ) {
      return original.call(this, value * (1 + 1e-9) + 1e-9, time);
    });
    const results = await runLayer3();
    const cases = results.reduce((sum, result) => sum + result.cases, 0);
    const failed = results.reduce((sum, result) => sum + result.cases - result.passed, 0);
    expect(failed).toBeGreaterThan(cases / 2);
  });
});
