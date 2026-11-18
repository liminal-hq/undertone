// Public API: pattern constructors, combinators, and playback entry points
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export { chord, n, note, s, sound } from './control.js';
export { playParams, resolveParams } from './engine.js';
export { buildImpulseResponse, getOrbitBus } from './effects.js';
export { drift } from './drift.js';
export { seededRandom } from './random.js';
export { fmPresets, fmVoice, layer } from './instruments.js';
export { createMasterBus } from './masterBus.js';
export { createMonoFold } from './monoFold.js';
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
export {
  brand,
  brandBy,
  choose,
  cosine,
  cosine2,
  irand,
  isaw,
  isaw2,
  perlin,
  rand,
  rand2,
  saw,
  saw2,
  signal,
  sine,
  sine2,
  square,
  square2,
  tri,
  tri2
} from './signal.js';
export { Fraction } from './fraction.js';
export { SHAPED_WAVE_TYPES, isShapedWave } from './waves.js';
export { renderToBuffer } from './render.js';
export { encodeWav } from './wav.js';
export { midiToFrequency, noteToFrequency, noteToMidi } from './pitch.js';
export {
  clearSamples,
  getSampleBaseNote,
  getSampleBuffer,
  isSampleRegistered,
  loadSamples,
  registerSample,
  registerSamples
} from './samples.js';
export { score } from './score.js';
export { resetTempo, setcpm } from './scheduler.js';
export {
  CHANNEL_ORDER,
  MAX_CHANNELS,
  enableMultichannel,
  foldToStereo,
  surroundGains
} from './surround.js';
export type { DriftOptions } from './drift.js';
export type { EnvelopeDefinition, FmVoiceDefinition, LayerOptions } from './instruments.js';
export type { Score, ScoreAutopan, ScoreDefinition, ScoreEvent, ScorePanPoint } from './score.js';
export type { Hap, Sampler, TimeSpan } from './pattern.js';
export type { LimiterOptions, MasterBus, MasterBusOptions } from './masterBus.js';
export type { AutopanShape } from './autopan.js';
export type { OrbitBus } from './effects.js';
export type {
  LoopHandle,
  LoopOptions,
  LoopStopOptions,
  PlayOptions,
  TimerLike
} from './scheduler.js';
export type { OutputOptions, PlaybackHandle, PlayParamsOptions, StopOptions } from './engine.js';
export type { SampleSource } from './samples.js';
export type { OfflineContextInit, RenderOptions } from './render.js';
export type { WavOptions, WavSource } from './wav.js';
export type {
  AudioContextLike,
  AudioDestinationNodeLike,
  ControlPatch,
  DynamicsCompressorNodeLike,
  NoiseType,
  OfflineAudioContextLike,
  OscType,
  PanPoint,
  PeriodicWaveLike,
  RenderedAudioBufferLike,
  ShapedWaveType,
  SoundType,
  VoiceParams,
  WaveShaperNodeLike
} from './types.js';
