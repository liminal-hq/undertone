// Named scales: semitone-offset tables and scale-degree-to-pitch resolution
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { noteToMidi } from './pitch.js';

/**
 * Semitone offsets from the root, ascending, always starting at 0 — standard
 * Western music theory, the seven diatonic modes plus the two common minor
 * variants, two pentatonics, and the chromatic scale.
 */
export const SCALES: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicminor: [0, 2, 3, 5, 7, 8, 11],
  melodicminor: [0, 2, 3, 5, 7, 9, 11],
  majorpentatonic: [0, 2, 4, 7, 9],
  minorpentatonic: [0, 3, 5, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

const SCALE_SPEC_PATTERN = /^([A-Ga-g][#b]?-?\d+):(.+)$/;

/** Lowercases and strips spaces/hyphens/underscores so "Harmonic Minor" etc. also resolve. */
function normalizeScaleName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

export interface ParsedScale {
  readonly rootMidi: number;
  readonly intervals: readonly number[];
}

/** Parses a scale spec like "D5:minor" into a root MIDI note and its interval table. */
export function parseScale(spec: string): ParsedScale {
  const match = SCALE_SPEC_PATTERN.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid scale spec: "${spec}". Expected e.g. "D5:minor", "c4:majorPentatonic".`
    );
  }
  const [, rootName, scaleName] = match;
  const intervals = SCALES[normalizeScaleName(scaleName)];
  if (!intervals) {
    throw new Error(
      `Unknown scale name: "${scaleName}". Expected one of ${Object.keys(SCALES).join(', ')}.`
    );
  }
  return { rootMidi: noteToMidi(rootName), intervals };
}

/**
 * Resolves a scale degree (0-based, may be negative or beyond the scale's own
 * length) against an already-parsed scale to a MIDI note number, carrying the
 * octave for degrees outside [0, scale length). Split out from
 * scaleDegreeToMidi() so a caller resolving many degrees against the same
 * spec (e.g. .scale() over a whole pattern) can parse once and reuse it,
 * instead of re-parsing the spec string on every single event.
 */
export function degreeToMidi(parsed: ParsedScale, degree: number): number {
  const len = parsed.intervals.length;
  const octaveShift = Math.floor(degree / len);
  const indexInScale = ((degree % len) + len) % len;
  return parsed.rootMidi + octaveShift * 12 + parsed.intervals[indexInScale];
}

/**
 * Resolves a scale degree against a scale spec to a MIDI note number — see
 * degreeToMidi(). Parses `spec` fresh each call; prefer parseScale() +
 * degreeToMidi() directly when resolving many degrees against one spec.
 */
export function scaleDegreeToMidi(spec: string, degree: number): number {
  return degreeToMidi(parseScale(spec), degree);
}
