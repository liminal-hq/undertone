// The note(), sound(), s(), n(), and chord() constructors, thin calls into the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Pattern, handleOfPattern, patternOfHandle } from './pattern.js';
import type { ControlPatch, SoundType } from './types.js';
import { glue } from './wasm.js';

// Each parses its mini-notation in Rust (every word checked when the pattern is built, as the reference does) and reports a
// parse error with the source's own UTF-16 code units. The wrapper's part is the one check only it can make: whether `n()`
// was given one of its own patterns.

/**
 * Starts a pitched pattern (default sound: sine). Accepts a raw Hz number, a
 * note name ("c2", "a4", "f#3"), or a mini-notation string of them
 * (`"c3 [e3 g3] <a3 b3>"`).
 */
export function note(input: string | number): Pattern<ControlPatch> {
  return patternOfHandle(glue.note(input));
}

/**
 * Starts an unpitched pattern — the natural entry point for noise-type voices
 * (clicks, hits). Accepts a single sound type or a mini-notation string of
 * them ("white ~ pink(3,8)").
 */
export function sound(input: SoundType | string): Pattern<ControlPatch> {
  return patternOfHandle(glue.sound(input));
}

/**
 * Starts a pattern of synth voices or registered samples: a word matching one
 * of the ten synth SoundTypes behaves exactly like sound(); any other word
 * becomes a sample name (see samples.ts's registerSample()), validated
 * against the registry at play time rather than here, since registration can
 * happen after the pattern is built. Accepts a mini-notation string
 * (`"bd ~ [bd bd] sd"`, `"<gm_acoustic_bass>"`).
 */
export function s(input: SoundType | string): Pattern<ControlPatch> {
  return patternOfHandle(glue.s(input));
}

/**
 * Starts a scale-degree pattern — chain `.scale("D5:minor")` to resolve it
 * into real pitches. Accepts a raw integer degree or a mini-notation string of
 * them ("0 2 4 <1 3>"), or a pattern of numbers that has events
 * (`n(sine.segment(8).range(0, 7))`), each floored to a whole number.
 */
export function n(input: string | number | Pattern<number>): Pattern<ControlPatch> {
  if (input instanceof Pattern) {
    return patternOfHandle(glue.nPattern(handleOfPattern(input)));
  }
  return patternOfHandle(glue.n(input));
}

/**
 * Starts a chord-symbol pattern — chain `.voicing()` to expand each chord into
 * simultaneous notes. Accepts a mini-notation string of chord symbols
 * (`"<Dm9 BbM7 Gm9 A7sus>"`).
 */
export function chord(input: string): Pattern<ControlPatch> {
  return patternOfHandle(glue.chord(input));
}
