// Unit tests for note-name and raw-Hz frequency parsing
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { midiToFrequency, noteToFrequency, noteToMidi } from './pitch';

describe('noteToFrequency', () => {
  it('resolves a4 to 440Hz exactly', () => {
    expect(noteToFrequency('a4')).toBe(440);
  });

  it('resolves c4 (middle C) to ~261.63Hz', () => {
    expect(noteToFrequency('c4')).toBeCloseTo(261.626, 2);
  });

  it('resolves c2 to ~65.41Hz', () => {
    expect(noteToFrequency('c2')).toBeCloseTo(65.406, 2);
  });

  it('applies sharp and flat accidentals', () => {
    expect(noteToFrequency('c#4')).toBeCloseTo(277.183, 2);
    expect(noteToFrequency('db4')).toBeCloseTo(277.183, 2);
  });

  it('is case-insensitive', () => {
    expect(noteToFrequency('A4')).toBe(440);
  });

  it('passes numbers through unchanged as raw Hz', () => {
    expect(noteToFrequency(220)).toBe(220);
    expect(noteToFrequency(65.41)).toBe(65.41);
  });

  it('rejects non-positive or non-finite numbers', () => {
    expect(() => noteToFrequency(0)).toThrow();
    expect(() => noteToFrequency(-10)).toThrow();
    expect(() => noteToFrequency(Number.NaN)).toThrow();
  });

  it('rejects malformed note names', () => {
    expect(() => noteToFrequency('h4')).toThrow();
    expect(() => noteToFrequency('c')).toThrow();
    expect(() => noteToFrequency('')).toThrow();
  });
});

describe('noteToMidi', () => {
  it('resolves c4 (middle C) to MIDI 60 and a4 to MIDI 69', () => {
    expect(noteToMidi('c4')).toBe(60);
    expect(noteToMidi('a4')).toBe(69);
  });

  it('applies sharp and flat accidentals', () => {
    expect(noteToMidi('c#4')).toBe(61);
    expect(noteToMidi('db4')).toBe(61);
  });

  it('rejects malformed note names', () => {
    expect(() => noteToMidi('h4')).toThrow(/Invalid note name/);
  });
});

describe('midiToFrequency', () => {
  it('resolves MIDI 69 to 440Hz exactly, composing with noteToMidi to match noteToFrequency', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToFrequency(noteToMidi('c2'))).toBeCloseTo(noteToFrequency('c2'), 10);
  });
});
