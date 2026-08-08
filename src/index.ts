// Public API: pattern constructors, combinators, and playback entry points
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export { chord, n, note, s, sound } from './control.js';
export { mini } from './mini.js';
export {
  Pattern,
  arrange,
  cat,
  hasOnset,
  pure,
  rev,
  seq,
  silence,
  stack,
  timecat
} from './pattern.js';
export { Fraction } from './fraction.js';
export { midiToFrequency, noteToFrequency, noteToMidi } from './pitch.js';
export {
  clearSamples,
  getSampleBaseNote,
  getSampleBuffer,
  loadSamples,
  registerSample,
  registerSamples
} from './samples.js';
export {
  CHANNEL_ORDER,
  MAX_CHANNELS,
  enableMultichannel,
  foldToStereo,
  surroundGains
} from './surround.js';
export type { Hap, TimeSpan } from './pattern.js';
export type { LoopHandle, LoopOptions, PlayOptions, TimerLike } from './scheduler.js';
export type { SampleSource } from './samples.js';
export type {
  AudioContextLike,
  AudioDestinationNodeLike,
  ControlPatch,
  NoiseType,
  OscType,
  SoundType,
  VoiceParams
} from './types.js';
