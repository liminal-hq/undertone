// The package's public names: everything an entry re-exports once it has loaded the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export { drift } from './drift.js';
export { fmPresets, fmVoice, layer } from './instruments.js';
export { chord, n, note, s, sound } from './notes.js';
export { resolveParams } from './params.js';
export { score } from './score.js';
export { CHANNEL_ORDER, MAX_CHANNELS, foldToStereo, surroundGains } from './surround.js';
export { SHAPED_WAVE_TYPES, isShapedWave } from './waves.js';
export {
  Pattern,
  arrange,
  brand,
  brandBy,
  cat,
  choose,
  cosine,
  cosine2,
  hasOnset,
  irand,
  isaw,
  isaw2,
  mini,
  perlin,
  pure,
  rand,
  rand2,
  rev,
  saw,
  saw2,
  seq,
  signal,
  silence,
  sine,
  sine2,
  square,
  square2,
  stack,
  timecat,
  tri,
  tri2
} from './pattern.js';
export { Fraction } from './fraction.js';
export { midiToFrequency, noteToFrequency, noteToMidi, seededRandom } from './helpers.js';
export type { Hap, Sampler, TimeSpan } from './pattern.js';
export type { AutopanShape } from './autopan.js';
export type { DriftOptions } from './drift.js';
export type { EnvelopeDefinition, FmVoiceDefinition, LayerOptions } from './instruments.js';
export type { Score, ScoreAutopan, ScoreDefinition, ScoreEvent, ScorePanPoint } from './score.js';
export type {
  LimiterOptions,
  LoopHandle,
  LoopOptions,
  LoopStopOptions,
  MasterBus,
  MasterBusOptions,
  OfflineContextInit,
  OrbitBus,
  OutputOptions,
  PlayOptions,
  PlaybackHandle,
  PlayParamsOptions,
  RenderOptions,
  SampleSource,
  StopOptions,
  TimerLike,
  WavOptions,
  WavSource
} from './engineTypes.js';
export type {
  AudioContextLike,
  AudioDestinationNodeLike,
  ControlInput,
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
