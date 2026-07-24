// Converts note names and raw Hz numbers to frequencies
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

const NOTE_OFFSETS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const NOTE_NAME_PATTERN = /^([a-gA-G])([#b]?)(-?\d+)$/;

/**
 * Converts a note name ("c2", "a4", "f#3", "bb3") to Hz using scientific pitch
 * notation (C4 = MIDI 60, A4 = 440Hz). Numbers pass through unchanged as raw Hz.
 */
export function noteToFrequency(pitch: string | number): number {
  if (typeof pitch === 'number') {
    if (!Number.isFinite(pitch) || pitch <= 0) {
      throw new Error(`Invalid frequency: ${pitch}`);
    }
    return pitch;
  }

  const match = NOTE_NAME_PATTERN.exec(pitch.trim());
  if (!match) {
    throw new Error(`Invalid note name: "${pitch}". Expected e.g. "c2", "a4", "f#3", "bb3".`);
  }

  const [, letter, accidental, octaveStr] = match;
  const base = NOTE_OFFSETS[letter.toLowerCase()];
  const accidentalOffset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  const octave = Number.parseInt(octaveStr, 10);
  const midi = (octave + 1) * 12 + base + accidentalOffset;

  return 440 * 2 ** ((midi - 69) / 12);
}
