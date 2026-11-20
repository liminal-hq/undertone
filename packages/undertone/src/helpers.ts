// Pitch helpers and the seeded random source, thin calls into the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { glue } from './wasm.js';

/**
 * Converts a note name ("c2", "a4", "f#3", "bb3") to a MIDI note number using
 * scientific pitch notation (C4 = MIDI 60).
 */
export function noteToMidi(name: string): number {
  return glue.noteToMidi(name);
}

/** Converts a MIDI note number to Hz (A4 = MIDI 69 = 440Hz). */
export function midiToFrequency(midi: number): number {
  return glue.midiToFrequency(midi);
}

/**
 * Converts a note name ("c2", "a4", "f#3", "bb3") to Hz using scientific pitch
 * notation (C4 = MIDI 60, A4 = 440Hz). Numbers pass through unchanged as raw Hz.
 */
export function noteToFrequency(pitch: string | number): number {
  return glue.noteToFrequency(pitch);
}

/**
 * A deterministic random source: the same seed gives the same sequence of
 * numbers in [0, 1), in the browser and on every platform.
 */
export function seededRandom(seed: number | string): () => number {
  const random = glue.seededRandom(seed);
  return () => random.next();
}
