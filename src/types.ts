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
  /** Start-time offset in seconds, relative to the pattern's shared start time. */
  nudgeTime: number;
  /** Stereo position from -1 (hard left) to 1 (hard right). No panner node is created when undefined. */
  pan?: number;
  /**
   * Per-speaker output gains for multichannel (up to 7.1) playback, in the
   * Web-Audio-conventional order FL, FR, C, LFE, SL, SR, RL, RR (1-8 entries).
   * Takes precedence over `pan` when set. Voices are folded down to stereo
   * automatically when the context's destination has fewer channels.
   */
  channelGains?: number[];
  /**
   * Gate length in seconds: the envelopes hold at their sustain level until this
   * long after the voice starts, then release. Percussive (no hold) when
   * undefined. The scheduler sets this from each event's pattern duration.
   */
  duration?: number;
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
  connect(destination: AudioNodeLike, output?: number, input?: number): AudioNodeLike;
}

/**
 * The destination surface the engine reads (and enableMultichannel() writes).
 * All members are optional because fakes and exotic contexts may not have
 * them; a plain stereo destination is assumed when absent.
 */
export interface AudioDestinationNodeLike extends AudioNodeLike {
  maxChannelCount?: number;
  channelCount?: number;
  channelInterpretation?: string;
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

export interface StereoPannerNodeLike extends AudioNodeLike {
  pan: AudioParamLike;
}

/** A channel merger has no extra members the engine needs — inputs are addressed via connect(). */
export type ChannelMergerNodeLike = AudioNodeLike;

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  currentTime: number;
  sampleRate: number;
  destination: AudioDestinationNodeLike;
  createOscillator(): OscillatorNodeLike;
  createGain(): GainNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createStereoPanner(): StereoPannerNodeLike;
  createChannelMerger(numberOfInputs: number): ChannelMergerNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createBuffer(numChannels: number, length: number, sampleRate: number): AudioBufferLike;
}
