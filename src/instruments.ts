// Reusable instruments as plain voice data: Tone-shaped FM voice definitions, presets, and layering
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Pattern } from './pattern.js';
import { stack } from './pattern.js';
import type { ControlPatch, OscType, ShapedWaveType } from './types.js';

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

/**
 * Turns a Tone.js-shaped FM definition into a plain `ControlPatch` — JSON-safe
 * data you can apply with `pattern.voice(patch)`, save, and reload. Tone's
 * `modulationIndex` is relative to the carrier frequency while Undertone's
 * `.fm()` is relative to the modulator (Strudel's convention), so the index is
 * divided by the harmonicity on the way through. Fields you leave out stay
 * unset and take Undertone's usual defaults, not Tone's.
 */
export function fmVoice(definition: FmVoiceDefinition): ControlPatch {
  const { harmonicity, modulationIndex, oscillator, modulation, envelope, modulationEnvelope } =
    definition;
  if (harmonicity !== undefined && !(harmonicity > 0)) {
    throw new Error(`fmVoice() harmonicity must be positive, got ${harmonicity}`);
  }
  if (modulationIndex !== undefined && !(modulationIndex >= 0)) {
    throw new Error(`fmVoice() modulationIndex must not be negative, got ${modulationIndex}`);
  }

  const patch: ControlPatch = {};
  if (oscillator?.type !== undefined) patch.soundType = oscillator.type;
  if (envelope?.attack !== undefined) patch.attack = envelope.attack;
  if (envelope?.decay !== undefined) patch.decay = envelope.decay;
  if (envelope?.sustain !== undefined) patch.sustain = envelope.sustain;
  if (envelope?.release !== undefined) patch.release = envelope.release;
  if (definition.level !== undefined) patch.gainLevel = definition.level;
  if (definition.pan !== undefined) patch.pan = definition.pan;

  if (modulationIndex !== undefined && modulationIndex > 0) {
    patch.fmIndex = modulationIndex / (harmonicity ?? 1);
    if (harmonicity !== undefined) patch.fmHarmonicity = harmonicity;
    if (modulation?.type !== undefined) patch.fmWave = modulation.type;
    if (modulationEnvelope?.attack !== undefined) patch.fmAttack = modulationEnvelope.attack;
    if (modulationEnvelope?.decay !== undefined) patch.fmDecay = modulationEnvelope.decay;
    if (modulationEnvelope?.sustain !== undefined) patch.fmSustain = modulationEnvelope.sustain;
    if (modulationEnvelope?.release !== undefined) patch.fmRelease = modulationEnvelope.release;
  }
  return patch;
}

/**
 * A small set of readable FM instruments — starting points to copy and bend,
 * as much as presets. Each is a plain `ControlPatch`: `note('e5 g5').voice(fmPresets.glassBell)`.
 */
export const fmPresets: Readonly<
  Record<'glassBell' | 'roundBass' | 'softPad' | 'pluck' | 'lead', ControlPatch>
> = Object.freeze({
  /** An inharmonic ratio with a quick-fading modulator: a bright strike that rings clean. */
  glassBell: Object.freeze(
    fmVoice({
      harmonicity: 3.5,
      modulationIndex: 5,
      envelope: { attack: 0.002, decay: 0.7, sustain: 0, release: 0.9 },
      modulationEnvelope: { attack: 0, decay: 0.35, release: 0.2 },
      level: 0.3
    })
  ),
  /** Matched ratio with a soft triangle modulator: round weight, little edge. */
  roundBass: Object.freeze(
    fmVoice({
      harmonicity: 1,
      modulationIndex: 3.5,
      modulation: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.12 },
      modulationEnvelope: { attack: 0, decay: 0.18, sustain: 0.3, release: 0.1 },
      level: 0.5
    })
  ),
  /** A slow attack and a gently breathing modulator for sustained chords. */
  softPad: Object.freeze(
    fmVoice({
      harmonicity: 2,
      modulationIndex: 1.2,
      envelope: { attack: 0.4, decay: 0.3, sustain: 0.8, release: 0.9 },
      modulationEnvelope: { attack: 0.5, decay: 0.6, sustain: 0.5, release: 0.8 },
      level: 0.22
    })
  ),
  /** A short, bright-to-mellow pluck. */
  pluck: Object.freeze(
    fmVoice({
      harmonicity: 2,
      modulationIndex: 6,
      envelope: { attack: 0.003, decay: 0.2, sustain: 0.25, release: 0.15 },
      modulationEnvelope: { attack: 0, decay: 0.12, sustain: 0.1, release: 0.1 },
      level: 0.35
    })
  ),
  /** A sustained lead whose modulator settles to a steady, reedy edge. */
  lead: Object.freeze(
    fmVoice({
      harmonicity: 2,
      modulationIndex: 3.4,
      envelope: { attack: 0.008, decay: 0.12, sustain: 0.52, release: 0.16 },
      modulationEnvelope: { attack: 0.004, decay: 0.16, sustain: 0.14, release: 0.1 },
      level: 0.32
    })
  )
});

/** Options for layer(). Arrays are matched to the layers by position; missing entries use the defaults. */
export interface LayerOptions {
  /**
   * Seconds each successive layer starts after the previous one: layer `i` is
   * nudged `i × stagger`. A couple of milliseconds reads as width and body, not
   * an echo. Default 0.
   */
  stagger?: number;
  /** Per-layer strength (the `velocity` control), so a pluck can lead and a sustained partner fill in. Default 1 each. */
  levels?: readonly number[];
  /** Per-layer stereo position, -1 to 1. A layer's own `pan` is used when this entry is missing. */
  pans?: readonly number[];
}

/**
 * Plays one pattern of notes on several voices at once — the usual way to get
 * a thicker sound from a small synth. Each entry of `voices` is a plain
 * patch (an `fmVoice()` result, a preset, or any `ControlPatch`); the layers
 * are stacked, with an optional start stagger, level balance and pans.
 * Layering sets each layer's `nudge`, `velocity` and `pan`, overriding those
 * controls on the incoming pattern.
 */
export function layer(
  notes: Pattern<ControlPatch>,
  voices: readonly ControlPatch[],
  options: LayerOptions = {}
): Pattern<ControlPatch> {
  if (voices.length === 0) {
    throw new Error('layer() needs at least one voice');
  }
  const stagger = options.stagger ?? 0;
  if (!(stagger >= 0)) {
    throw new Error(`layer() stagger must not be negative, got ${stagger}`);
  }
  return stack(
    ...voices.map((voice, index) => {
      const patch: ControlPatch = { ...voice, nudgeTime: index * stagger };
      const level = options.levels?.[index];
      if (level !== undefined) patch.velocity = level;
      const pan = options.pans?.[index];
      if (pan !== undefined) patch.pan = pan;
      return notes.voice(patch);
    })
  );
}
