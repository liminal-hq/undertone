// Chord symbols and a deterministic, stateless voicing algorithm
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { noteToMidi } from './pitch.js';

/**
 * Semitone intervals from the root, standard triad/seventh/extension theory.
 * Extensions (9ths) are written as 14 rather than 2 so they land an octave
 * above the root when stacked directly, instead of folding back down next to
 * it — that's what gives voicingPitches() its spread without any extra
 * per-tone octave-placement logic. Case matters: `M7`/`maj7` (major seventh)
 * is a different chord from `m7` (minor seventh).
 */
const CHORD_QUALITIES: Record<string, readonly number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  M9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '7sus': [0, 5, 7, 10],
  '7sus4': [0, 5, 7, 10],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  aug: [0, 4, 8],
  m7b5: [0, 3, 6, 10]
};

const CHORD_SYMBOL_PATTERN = /^([A-Ga-g])([#b]?)(.*)$/;

export interface ParsedChord {
  readonly rootPitchClass: number;
  readonly intervals: readonly number[];
}

/** Parses a chord symbol ("Dm9", "BbM7", "A7sus") into a root pitch class and interval table. */
export function parseChord(symbol: string): ParsedChord {
  const match = CHORD_SYMBOL_PATTERN.exec(symbol.trim());
  if (!match) {
    throw new Error(`Invalid chord symbol: "${symbol}".`);
  }
  const [, letter, accidental, quality] = match;
  const intervals = CHORD_QUALITIES[quality];
  if (!intervals) {
    throw new Error(
      `Unknown chord quality: "${quality}" in "${symbol}". Expected one of ${Object.keys(
        CHORD_QUALITIES
      )
        .map((q) => (q === '' ? '(major)' : q))
        .join(', ')}.`
    );
  }
  // noteToMidi needs an octave digit; the actual octave is irrelevant since only the pitch class survives the mod 12.
  const rootPitchClass = ((noteToMidi(`${letter}${accidental}4`) % 12) + 12) % 12;
  return { rootPitchClass, intervals };
}

const DEFAULT_ANCHOR_MIDI = 60; // C4

/** The representative of `pitchClass` within [anchorMidi - 6, anchorMidi + 6). */
function rootMidiNearAnchor(pitchClass: number, anchorMidi: number): number {
  const low = anchorMidi - 6;
  return low + ((((pitchClass - low) % 12) + 12) % 12);
}

/**
 * Resolves a chord symbol to concrete MIDI note numbers: a stateless,
 * deterministic function of the symbol and an optional anchor pitch (default
 * middle C) — not Strudel's voicing-dictionary system, and not real voice
 * leading. The root lands within a half-octave of the anchor; every other
 * tone is stacked directly on top via its interval (see CHORD_QUALITIES),
 * which is what lets extensions like a 9th land an octave up instead of
 * folding back down next to the root. Because it's a pure function of the
 * symbol, two chords sharing the same root and overlapping intervals (e.g.
 * `Dm` then `Dm7`) automatically land their common tones on the same MIDI
 * notes — an approximation of voice-leading, not a guarantee of it across
 * different roots.
 */
export function voicingPitches(symbol: string, options?: { anchor?: string | number }): number[] {
  const { rootPitchClass, intervals } = parseChord(symbol);
  const anchorMidi =
    options?.anchor === undefined
      ? DEFAULT_ANCHOR_MIDI
      : typeof options.anchor === 'number'
        ? options.anchor
        : noteToMidi(options.anchor);
  const rootMidi = rootMidiNearAnchor(rootPitchClass, anchorMidi);
  const pitches = intervals.map((interval) => rootMidi + interval);
  return [...new Set(pitches)].sort((a, b) => a - b);
}
