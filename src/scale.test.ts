// Unit tests for named scales and scale-degree resolution
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { noteToMidi } from './pitch';
import { SCALES, parseScale, scaleDegreeToMidi } from './scale';

describe('SCALES', () => {
  it('every table starts at 0 and has no out-of-range or duplicate offsets', () => {
    for (const [name, intervals] of Object.entries(SCALES)) {
      expect(intervals[0], name).toBe(0);
      expect(new Set(intervals).size, name).toBe(intervals.length);
      for (const offset of intervals) {
        expect(offset, name).toBeGreaterThanOrEqual(0);
        expect(offset, name).toBeLessThan(12);
      }
    }
  });
});

describe('parseScale', () => {
  it('resolves a root note and scale name', () => {
    const { rootMidi, intervals } = parseScale('D5:minor');
    expect(rootMidi).toBe(noteToMidi('d5'));
    expect(intervals).toEqual(SCALES.minor);
  });

  it('is case-insensitive and ignores separators in the scale name', () => {
    expect(parseScale('c4:MAJOR').intervals).toEqual(SCALES.major);
    expect(parseScale('c4:harmonic-minor').intervals).toEqual(SCALES.harmonicminor);
    expect(parseScale('c4:Harmonic Minor').intervals).toEqual(SCALES.harmonicminor);
  });

  it('rejects a malformed spec', () => {
    expect(() => parseScale('minor')).toThrow(/Invalid scale spec/);
    expect(() => parseScale('D5-minor')).toThrow(/Invalid scale spec/);
  });

  it('rejects an unknown scale name', () => {
    expect(() => parseScale('c4:atonal')).toThrow(/Unknown scale name/);
  });

  it('rejects an invalid root note', () => {
    expect(() => parseScale('h4:minor')).toThrow(/Invalid scale spec/);
  });
});

describe('scaleDegreeToMidi', () => {
  it('resolves in-range degrees directly against the interval table', () => {
    expect(scaleDegreeToMidi('c4:major', 0)).toBe(noteToMidi('c4'));
    expect(scaleDegreeToMidi('c4:major', 2)).toBe(noteToMidi('e4'));
    expect(scaleDegreeToMidi('c4:major', 4)).toBe(noteToMidi('g4'));
  });

  it('carries the octave for degrees at and beyond the scale length', () => {
    expect(scaleDegreeToMidi('c4:major', 7)).toBe(noteToMidi('c5'));
    expect(scaleDegreeToMidi('c4:major', 8)).toBe(noteToMidi('d5'));
    expect(scaleDegreeToMidi('c4:major', 14)).toBe(noteToMidi('c6'));
  });

  it('carries the octave downward for negative degrees', () => {
    expect(scaleDegreeToMidi('c4:major', -1)).toBe(noteToMidi('b3'));
    expect(scaleDegreeToMidi('c4:major', -7)).toBe(noteToMidi('c3'));
  });

  it("matches the D5:minor spec used by the sample songs' memory motif", () => {
    // scale degree 0 of D5:minor is the root itself
    expect(scaleDegreeToMidi('D5:minor', 0)).toBe(noteToMidi('d5'));
  });
});
