// Shared types for voice parameters and the minimal Web Audio surface the engine depends on
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export type OscType = 'sine' | 'triangle' | 'square' | 'sawtooth';
export type NoiseType = 'white' | 'pink' | 'brown';
export type SoundType = OscType | NoiseType;

export interface VoiceParams {
  soundType: SoundType;
  /** Note name ("c2", "a4", "f#3") or a raw Hz number. Ignored for noise sound types. */
  pitch?: string | number;
  gainLevel: number;
  attack: number;
  decay: number;
  /** Fraction (0-1) of gainLevel the decay stage settles to before release. */
  sustain: number;
  release: number;
  /** Base lowpass cutoff in Hz. No filter is created at all when undefined. */
  filterCutoff?: number;
  /** Hz the filter envelope adds on top of filterCutoff at its peak. */
  filterEnvAmount: number;
  filterAttack: number;
  filterDecay: number;
  /** Fraction (0-1) between filterCutoff and its peak the decay stage settles to. */
  filterSustain: number;
  filterRelease: number;
  /** Pitch glide (portamento) time in seconds; starts an octave above the target and slides down. */
  slideTime: number;
  /** Start-time offset in seconds, relative to a stack()'s shared start time. */
  nudgeTime: number;
}

/**
 * A partial set of voice parameters carried by each pattern event. Chainable
 * pattern methods merge patches; the engine fills in defaults at play time.
 */
export type ControlPatch = Partial<VoiceParams>;

/**
 * The minimal Web Audio surface engine.ts depends on. A real AudioContext/OscillatorNode/etc.
 * satisfies these structurally, so playVoice() works unchanged in a browser; tests pass a
 * hand-written fake instead (Web Audio doesn't exist outside a browser/jsdom-with-polyfill).
 */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): AudioNodeLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  /** Loosely typed (not OscType) so a real OscillatorNode — whose `type` also allows "custom" — still satisfies this structurally. */
  type: string;
  frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
  Q: AudioParamLike;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  currentTime: number;
  sampleRate: number;
  destination: AudioNodeLike;
  createOscillator(): OscillatorNodeLike;
  createGain(): GainNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createBuffer(numChannels: number, length: number, sampleRate: number): AudioBufferLike;
}
