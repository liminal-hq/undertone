// Unit tests for chord-symbol parsing and the voicing algorithm
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { parseChord, voicingPitches } from './chord';
import { noteToMidi } from './pitch';

describe('parseChord', () => {
  it('parses a bare major triad (empty quality)', () => {
    expect(parseChord('D')).toEqual({ rootPitchClass: 2, intervals: [0, 4, 7] });
  });

  it('parses a minor chord and applies accidentals to the root', () => {
    expect(parseChord('Dm9').rootPitchClass).toBe(2);
    expect(parseChord('Bbm').rootPitchClass).toBe(10);
    expect(parseChord('C#m').rootPitchClass).toBe(1);
  });

  it('is case-sensitive between major-seventh and minor-seventh spellings', () => {
    expect(parseChord('CM7').intervals).toEqual([0, 4, 7, 11]);
    expect(parseChord('Cmaj7').intervals).toEqual([0, 4, 7, 11]);
    expect(parseChord('Cm7').intervals).toEqual([0, 3, 7, 10]);
  });

  it('covers the quality table used by the sample songs', () => {
    expect(parseChord('Dm9').intervals).toEqual([0, 3, 7, 10, 14]);
    expect(parseChord('BbM7').intervals).toEqual([0, 4, 7, 11]);
    expect(parseChord('Gm9').intervals).toEqual([0, 3, 7, 10, 14]);
    expect(parseChord('A7sus').intervals).toEqual([0, 5, 7, 10]);
    expect(parseChord('Amadd9').intervals).toEqual([0, 3, 7, 14]);
    expect(parseChord('Fmaj7').intervals).toEqual([0, 4, 7, 11]);
    expect(parseChord('C6').intervals).toEqual([0, 4, 7, 9]);
    expect(parseChord('Gsus2').intervals).toEqual([0, 2, 7]);
  });

  it('rejects an unknown quality suffix', () => {
    expect(() => parseChord('Dxyz')).toThrow(/Unknown chord quality/);
  });

  it('rejects a malformed symbol', () => {
    expect(() => parseChord('H')).toThrow(/Invalid chord symbol/);
    expect(() => parseChord('')).toThrow(/Invalid chord symbol/);
  });
});

describe('voicingPitches', () => {
  it('is a pure, deterministic function of the symbol', () => {
    expect(voicingPitches('Dm9')).toEqual(voicingPitches('Dm9'));
  });

  it('returns pitches sorted ascending with the root within a half-octave of the anchor', () => {
    const pitches = voicingPitches('C');
    expect(pitches).toEqual([...pitches].sort((a, b) => a - b));
    expect(pitches[0]).toBeGreaterThanOrEqual(60 - 6);
    expect(pitches[0]).toBeLessThan(60 + 6);
  });

  it('stacks extensions above the root rather than folding them into one octave', () => {
    const pitches = voicingPitches('Dm9');
    expect(pitches.length).toBe(5);
    expect(pitches[pitches.length - 1] - pitches[0]).toBeGreaterThan(12);
  });

  it('accepts a numeric or note-name anchor', () => {
    const byNumber = voicingPitches('C', { anchor: 72 });
    const byName = voicingPitches('C', { anchor: 'c5' });
    expect(byNumber).toEqual(byName);
    expect(byNumber[0]).toBe(noteToMidi('c5'));
  });

  it('shares common tones between same-root chords (Dm vs Dm7)', () => {
    const dm = voicingPitches('Dm');
    const dm7 = voicingPitches('Dm7');
    for (const pitch of dm) {
      expect(dm7).toContain(pitch);
    }
  });
});
