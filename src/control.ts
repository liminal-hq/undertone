// The note()/sound() pattern constructors: mini-notation in, voice-parameter patterns out
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { parseChord } from './chord.js';
import { mini } from './mini.js';
import { Pattern, pure } from './pattern.js';
import { noteToFrequency } from './pitch.js';
import { SOUND_TYPES, isSoundType } from './types.js';
import type { ControlPatch, SoundType } from './types.js';

function parsePitchWord(word: string): string | number {
  // Both branches validate eagerly so bad pitches fail at build time, not play time.
  if (/^\d+(\.\d+)?$/.test(word)) {
    const hz = Number(word);
    noteToFrequency(hz);
    return hz;
  }
  noteToFrequency(word);
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
    if (!isSoundType(word)) {
      throw new Error(`Invalid sound type: "${word}". Expected one of ${SOUND_TYPES.join(', ')}.`);
    }
    return { soundType: word };
  });
}

/**
 * Starts a pattern of synth voices or registered samples: a word matching one
 * of the seven synth SoundTypes behaves exactly like sound(); any other word
 * becomes a sample name (see samples.ts's registerSample()), validated
 * against the registry at play time rather than here, since registration can
 * happen after the pattern is built. Accepts a mini-notation string
 * ("bd ~ [bd bd] sd", "<gm_acoustic_bass>").
 */
export function s(input: SoundType | string): Pattern<ControlPatch> {
  return mini<ControlPatch>(input, (word) =>
    isSoundType(word) ? { soundType: word } : { sampleName: word }
  );
}

const INTEGER_WORD_PATTERN = /^-?\d+$/;

function parseDegreeWord(word: string): number {
  if (!INTEGER_WORD_PATTERN.test(word)) {
    throw new Error(`Invalid scale degree: "${word}". Expected an integer.`);
  }
  return Number.parseInt(word, 10);
}

/**
 * Starts a scale-degree pattern — chain `.scale("D5:minor")` to resolve it
 * into real pitches. Accepts a raw integer degree or a mini-notation string of
 * them ("0 2 4 <1 3>").
 */
export function n(input: string | number): Pattern<ControlPatch> {
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      throw new Error(`Invalid scale degree: ${input}. Expected an integer.`);
    }
    return pure<ControlPatch>({ degree: input });
  }
  return mini<ControlPatch>(input, (word) => ({ degree: parseDegreeWord(word) }));
}

/**
 * Starts a chord-symbol pattern — chain `.voicing()` to expand each chord into
 * simultaneous notes. Accepts a mini-notation string of chord symbols
 * ("<Dm9 BbM7 Gm9 A7sus>").
 */
export function chord(input: string): Pattern<ControlPatch> {
  return mini<ControlPatch>(input, (word) => {
    parseChord(word); // eager validation, same timing as note()'s pitch parsing
    return { chord: word };
  });
}
