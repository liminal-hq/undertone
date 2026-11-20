// Corpus layer 4 (renders against Chromium's summaries) and the WAV corpus through the package's public API
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { runLayer4, runWav } from './engine';

describe('corpus layer 4 through the package', () => {
  it("renders every case within its tolerances of Chromium's render (20 cases)", async () => {
    const result = await runLayer4();
    expect(result.failed).toEqual([]);
    expect(result.cases).toBe(20);
  });

  it("fails every case, the quirk cases' wide guards included, when the render is 10% quieter (a negative control)", async () => {
    const result = await runLayer4(0.9);
    const failedCases = new Set(result.failed.map((failure) => failure.split(':')[0]));
    expect(failedCases.size).toBe(result.cases);
  });
});

describe('the WAV corpus through the package', () => {
  it('encodes every case byte for byte, or with its message (34 cases)', () => {
    const result = runWav();
    expect(result.failed).toEqual([]);
    expect(result.total).toBe(34);
  });

  it('fails the cases whose bytes depend on the first sample when it moves (a negative control)', () => {
    const result = runWav(0.25);
    expect(result.failed.length).toBeGreaterThan(result.total / 2);
  });
});
