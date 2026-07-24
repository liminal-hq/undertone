// The note()/sound() pattern constructors: mini-notation in, voice-parameter patterns out
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { mini } from './mini.js';
import { Pattern, pure } from './pattern.js';
import { noteToFrequency } from './pitch.js';
import type { ControlPatch, SoundType } from './types.js';

const SOUND_TYPES: readonly string[] = [
  'sine',
  'triangle',
  'square',
  'sawtooth',
  'white',
  'pink',
  'brown'
];

function parsePitchWord(word: string): string | number {
  if (/^\d+(\.\d+)?$/.test(word)) {
    return Number(word);
  }
  noteToFrequency(word); // validates eagerly so bad notes fail at build time, not play time
  return word;
}

/**
 * Starts a pitched pattern (default sound: sine). Accepts a raw Hz number, a
 * note name ("c2", "a4", "f#3"), or a mini-notation string of them
 * ("c3 [e3 g3] <a3 b3>").
 */
export function note(input: string | number): Pattern<ControlPatch> {
  if (typeof input === 'number') {
    noteToFrequency(input);
    return pure<ControlPatch>({ pitch: input });
  }
  return mini<ControlPatch>(input, (word) => ({ pitch: parsePitchWord(word) }));
}

/**
 * Starts an unpitched pattern — the natural entry point for noise-type voices
 * (clicks, hits). Accepts a single sound type or a mini-notation string of
 * them ("white ~ pink(3,8)").
 */
export function sound(input: SoundType | string): Pattern<ControlPatch> {
  return mini<ControlPatch>(input, (word) => {
    if (!SOUND_TYPES.includes(word)) {
      throw new Error(`Invalid sound type: "${word}". Expected one of ${SOUND_TYPES.join(', ')}.`);
    }
    return { soundType: word as SoundType };
  });
}
