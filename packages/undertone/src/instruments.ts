// Instruments as plain voice data: FM voice definitions, the presets, and layering, from the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Pattern, handleOfPattern, patternOfHandle } from './pattern.js';
import type { ControlPatch, OscType, ShapedWaveType } from './types.js';
import { glue } from './wasm.js';

/** ADSR times in seconds, with sustain as a 0-1 level — the shape Tone.js uses for its envelopes. */
export interface EnvelopeDefinition {
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
}

/** Tone.js `FMSynth`-shaped definition of an FM instrument. Every field is optional. */
export interface FmVoiceDefinition {
  /** Modulator frequency ÷ carrier frequency (Tone's `harmonicity`). */
  harmonicity?: number;
  /** Tone's `modulationIndex`: peak deviation as a multiple of the *carrier* frequency. Omit for no FM. */
  modulationIndex?: number;
  /** The carrier's waveform (Tone's `oscillator.type`). */
  oscillator?: { type?: OscType | ShapedWaveType };
  /** The modulator's waveform (Tone's `modulation.type`). */
  modulation?: { type?: OscType | ShapedWaveType };
  /** The amplitude envelope. */
  envelope?: EnvelopeDefinition;
  /** The modulator-depth envelope (Tone's `modulationEnvelope`). */
  modulationEnvelope?: EnvelopeDefinition;
  /** Peak amplitude (0-1), as `.gain()`. */
  level?: number;
  /** Stereo position, -1 to 1. */
  pan?: number;
}

/** Options for layer(). Arrays are matched to the layers by position; missing entries use the defaults. */
export interface LayerOptions {
  /**
   * Seconds each successive layer starts after the previous one: layer `i` is
   * nudged `i × stagger`. A couple of milliseconds reads as width and body, not
   * an echo. Default 0.
   */
  stagger?: number;
  /** Per-layer strength, multiplying each note's own `velocity`, so a pluck can lead and a sustained partner fill in. Default 1 each. */
  levels?: readonly number[];
  /** Per-layer stereo position, -1 to 1, replacing any pan on the notes. A layer's own `pan` is used when this entry is missing. */
  pans?: readonly number[];
}

/**
 * Turns a Tone.js-shaped FM definition into a plain `ControlPatch` — JSON-safe
 * data you can apply with `pattern.voice(patch)`, save, and reload. Tone's
 * `modulationIndex` is relative to the carrier frequency while Undertone's
 * `.fm()` is relative to the modulator (Strudel's convention), so the index is
 * divided by the harmonicity on the way through. Fields you leave out stay
 * unset and take Undertone's usual defaults, not Tone's.
 */
export function fmVoice(definition: FmVoiceDefinition): ControlPatch {
  return glue.fmVoice(definition) as ControlPatch;
}

/**
 * Ready-made FM instruments, each a plain, frozen `ControlPatch`:
 * `note('e5 g5').voice(fmPresets.glassBell)`. A live binding, read from the
 * module once an entry has loaded it (see surround.ts); its keys are in alphabetical order.
 */
export let fmPresets: Readonly<
  Record<'glassBell' | 'roundBass' | 'softPad' | 'pluck' | 'lead', ControlPatch>
>;

/** Reads the presets from the module. Called by the entries once it is instantiated. */
export function loadInstruments(): void {
  const presets = glue.fmPresets() as Record<string, ControlPatch>;
  for (const name of Object.keys(presets)) Object.freeze(presets[name]);
  fmPresets = Object.freeze(presets) as typeof fmPresets;
}

/**
 * Plays one pattern of notes on several voices at once — the usual way to get
 * a thicker sound from a small synth. Each entry of `voices` is a plain
 * patch (an `fmVoice()` result, a preset, or any `ControlPatch`); the layers
 * are stacked, with an optional start stagger, level balance and pans.
 * Stagger adds to any `nudge` already on the notes and levels multiply their
 * `velocity`, so layering composes with `drift()` and with scored accents; a
 * layer `pans` entry replaces the notes' pan. A layer voice also keeps any
 * control the notes carry that its own patch does not set (a waveform or
 * filter from the incoming pattern, say), so set those in the voice patch.
 */
export function layer(
  notes: Pattern<ControlPatch>,
  voices: readonly ControlPatch[],
  options?: LayerOptions
): Pattern<ControlPatch> {
  return patternOfHandle(glue.layer(handleOfPattern(notes), voices as ControlPatch[], options));
}
