// Shared types for voice parameters and the minimal Web Audio surface the engine depends on
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export type OscType = 'sine' | 'triangle' | 'square' | 'sawtooth';
/** Waveforms cut from a sine: a half-wave rectified sine, a full-wave rectified (absolute) sine, and a pulsed sine. */
export type ShapedWaveType = 'halfsine' | 'abssine' | 'pulsesine';
export type NoiseType = 'white' | 'pink' | 'brown';
export type SoundType = OscType | ShapedWaveType | NoiseType;

/** Runtime companion to SoundType, for code that needs to check membership (s()/.s()/.bank()). */
export const SOUND_TYPES: readonly SoundType[] = [
  'sine',
  'triangle',
  'square',
  'sawtooth',
  'halfsine',
  'abssine',
  'pulsesine',
  'white',
  'pink',
  'brown'
];

export function isSoundType(word: string): word is SoundType {
  return (SOUND_TYPES as readonly string[]).includes(word);
}

export interface VoiceParams {
  soundType: SoundType;
  /** Note name ("c2", "a4", "f#3") or a raw Hz number. Ignored for noise sound types. */
  pitch?: string | number;
  /**
   * A name registered via registerSample() (see samples.ts). Takes precedence
   * over `soundType` when set — set by s()/.s() for any word that isn't a
   * synth SoundType.
   */
  sampleName?: string;
  /** `.bank(name)` — tried as `${sampleBank}_${sampleName}` before falling back to `sampleName` alone. */
  sampleBank?: string;
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
  /** Static highpass cutoff in Hz, in series after the lowpass. No filter is created when undefined. */
  hpfCutoff?: number;
  /** LFO rate in Hz driving a 4-stage allpass phaser. No phaser is created when undefined. */
  phaserRate?: number;
  /** Reverb send level (0-1) to this voice's orbit bus. No send at all when undefined or 0. */
  roomLevel?: number;
  /** Reverb decay character for the orbit's shared bus, roughly 1 (short) to 10 (long) — see effects.ts. */
  roomSize: number;
  /** Delay send level (0-1) to this voice's orbit bus. No send at all when undefined or 0. */
  delayLevel?: number;
  /** Delay time in seconds for the orbit's shared delay bus. */
  delayTime: number;
  /** Feedback (0-1) for the orbit's shared delay bus. */
  delayFeedback: number;
  /** Which shared effects bus (see effects.ts's getOrbitBus()) this voice's room/delay sends target. Default 0. */
  orbit?: number;
  /** Pitch glide (portamento) time in seconds; starts an octave above the target and slides down. */
  slideTime: number;
  /**
   * Pitch envelope depth in semitones (negative for a falling start): the
   * pitch moves from the note to this offset over `pitchAttack`, then returns
   * to the note over `pitchDecay`. Synth voices only. Unset or 0 means none.
   */
  pitchEnvAmount?: number;
  /** Seconds the pitch envelope takes to reach its offset (0 = starts there). Default 0. */
  pitchAttack?: number;
  /** Seconds the pitch envelope takes to return to the note. Default 0.1. */
  pitchDecay?: number;
  /**
   * A stepped pitch curve as semitone offsets from the note, one per frame:
   * the pitch jumps to each offset in turn and holds the last. Plain data, so
   * a sound editor can store and replay it. Takes priority over the envelope and slide.
   */
  pitchSteps?: number[];
  /** Frames per second for `pitchSteps`. Default 140 (the frame rate of classic AdLib effects). */
  pitchStepRate?: number;
  /**
   * FM modulation index (Strudel's `fm`): the modulator swings the carrier's
   * frequency by index × modulator frequency, so the sound stays equally bright
   * as the pitch changes. 0 or unset adds no FM nodes. Synth voices only.
   */
  fmIndex?: number;
  /** FM harmonicity (Strudel's `fmh`): modulator frequency ÷ carrier frequency. Non-integers give bell and metallic tones. Default 1. */
  fmHarmonicity?: number;
  /** Modulator-depth envelope (reaches the full index after `fmAttack`). Without any of the four envelope fields the index is constant. Default 0. */
  fmAttack?: number;
  /** Seconds for the modulator depth to fall to `fmSustain` × the index. Default 0. */
  fmDecay?: number;
  /** Fraction (0-1) of the index the modulator depth settles to. Default 1, or 0 when only `fmDecay` is set (as in Strudel). */
  fmSustain?: number;
  /** Seconds for the modulator depth to fall to 0 after the gate closes. Default 0. */
  fmRelease?: number;
  /** Ramp shape of the modulator-depth envelope: 'exp' (default, as in Strudel) or 'lin'. */
  fmEnvCurve?: 'lin' | 'exp';
  /** Modulator waveform — any oscillator or shaped waveform. Default 'sine'. */
  fmWave?: OscType | ShapedWaveType;
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
  /**
   * Gate length as a fraction of the event's own length in the pattern (1 = the
   * whole event, 0.5 = half of it). Applied by the pattern scheduler when it
   * turns events into voices, and forces a gate even in an ungated play().
   * Ignored when an explicit `duration` is set, and by playParams() (which has
   * no event lengths).
   */
  legato?: number;
  /**
   * Strength of this note, multiplying the peak amplitude only (not the
   * envelope shape or any other control). Lets one instrument keep its
   * identity from a ghost note to an accent. Default 1.
   */
  velocity?: number;
  /**
   * Cut group: a new voice in the same (context, output, group) stops the
   * previous voice in it with a very short fade, like a hi-hat choke or a
   * monophonic channel retriggering.
   */
  cutGroup?: number;
}

/**
 * A partial set of voice parameters carried by each pattern event. Chainable
 * pattern methods merge patches; the engine fills in defaults at play time.
 *
 * `degree` and `chord` are pre-play fields, not VoiceParams: n() sets `degree`
 * for `.scale()` to resolve into `pitch`, and chord() sets `chord` for
 * `.voicing()` to expand into per-note pitches. Neither survives past that
 * resolution step, and engine.ts never reads them — they pass through
 * resolveParams()'s spread harmlessly if a pattern reaches play time unresolved.
 */
export type ControlPatch = Partial<VoiceParams> & {
  degree?: number;
  chord?: string;
};

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
  /** Optional: used by playback handles to cancel automation when a voice is stopped early. A hard cut is used when absent. */
  cancelScheduledValues?(cancelTime: number): unknown;
  /** Optional: used by playback handles for a smooth fade-out when a voice is stopped early. */
  setTargetAtTime?(target: number, startTime: number, timeConstant: number): unknown;
}

export interface AudioNodeLike {
  /** A destination may be another node (audio-rate signal) or a param (e.g. the phaser LFO -> each stage's frequency). */
  connect(destination: AudioNodeLike | AudioParamLike, output?: number, input?: number): void;
  /** Optional: a real AudioNode has it; the engine never needs it, but consumers' output nodes may use it. */
  disconnect?(): void;
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
  /** Optional: only needed for shaped waveforms. Setting a wave makes a real OscillatorNode's `type` "custom". */
  setPeriodicWave?(wave: PeriodicWaveLike): void;
  start(when?: number): void;
  stop(when?: number): void;
}

/** Opaque handle to a custom waveform; a real PeriodicWave satisfies it. */
export type PeriodicWaveLike = object;

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

export interface ConvolverNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
}

export interface DelayNodeLike extends AudioNodeLike {
  delayTime: AudioParamLike;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  playbackRate: AudioParamLike;
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
  createConvolver(): ConvolverNodeLike;
  createDelay(maxDelayTime?: number): DelayNodeLike;
  /** Optional: needed for shaped waveforms (halfsine, abssine, pulsesine); without it they fall back to a sine. */
  createPeriodicWave?(
    real: Float32Array,
    imag: Float32Array,
    constraints?: { disableNormalization?: boolean }
  ): PeriodicWaveLike;
  /** Decodes encoded audio data (e.g. fetched via samples.ts's registerSample({url})). */
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}
