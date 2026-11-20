// Type declarations for the engine, scheduler, render, WAV, sample, and master bus groups, copied from the reference
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Types only: the engine exports (RF-25c, after RF-24 part 2b) will put the functions behind them. They are here now so that
// `Score` and `Pattern` can name them exactly as 0.4.0 does, and so that the API report compares them.

import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  DynamicsCompressorNodeLike,
  GainNodeLike,
  OfflineAudioContextLike,
  RenderedAudioBufferLike,
  WaveShaperNodeLike
} from './types.js';

/** Options for stopping a playing voice (or a whole playback) early. */
export interface StopOptions {
  /** Fade-out length in seconds before the voice is silent. Default 0.01. */
  fade?: number;
}

/**
 * Returned by play(), playVoices() and playParams(): the scheduled voices'
 * time window, and a way to stop them early. Safe to call stop() any number
 * of times, before or after the voices have started or finished.
 */
export interface PlaybackHandle {
  /** Earliest start time of any voice in this playback, on the context's clock. */
  readonly startTime: number;
  /** Latest time any voice in this playback is still sounding (after its release), on the context's clock. */
  readonly endTime: number;
  /**
   * Stops every voice at `when` (default: now) with a short fade. Voices that
   * have not started yet never sound; voices that already finished are
   * untouched. Without `cancelScheduledValues` on the context's params the
   * voice is cut hard instead of faded.
   */
  stop(when?: number, options?: StopOptions): void;
}

/** Where a voice's output lands, and options shared by every way of playing voices. */
export interface OutputOptions {
  /** Node the voices (and their effects buses) connect to instead of `ctx.destination`, e.g. a game's own mix bus. */
  output?: AudioNodeLike;
}

/** Options for playParams(). */
export interface PlayParamsOptions extends OutputOptions {
  /** Absolute start time on the context's clock. Default: now. */
  when?: number;
}

export interface TimerLike {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PlayOptions extends OutputOptions {
  /** Audio context to schedule against; a lazily-created shared AudioContext when omitted. */
  ctx?: AudioContextLike;
  /** Tempo in beats per minute, four beats to a cycle. Default 120 (2-second cycles). */
  bpm?: number;
  /** Tempo in cycles per second — an alternative to `bpm` for scores that know their loop length in seconds. Passing both throws. */
  cps?: number;
  /** Absolute start time on the context's clock. Default: now. */
  when?: number;
  /**
   * Hold each event's envelope at its sustain level for its own share of the
   * cycle, exactly like loop() — for previewing what one looped cycle will
   * sound like. Default false: envelopes stay percussive (0.1.x SFX
   * behaviour), which is what one-shot game sound effects want.
   */
  gated?: boolean;
}

export interface LoopOptions extends OutputOptions {
  /** Audio context to schedule against; a lazily-created shared AudioContext when omitted. */
  ctx?: AudioContextLike;
  /** Tempo in beats per minute, four beats to a cycle. Default 120 (2-second cycles), or the setcpm() tempo, which a running loop follows. An explicit `bpm` pins the loop's tempo. */
  bpm?: number;
  /** Tempo in cycles per second — an alternative to `bpm` for scores that know their loop length in seconds. Passing both throws. An explicit `cps` pins the loop's tempo. */
  cps?: number;
  /** Injectable timer (tests tick it by hand); defaults to global setInterval/clearInterval. */
  timer?: TimerLike;
}

/** Options for stopping a loop. */
export interface LoopStopOptions extends StopOptions {
  /**
   * What happens to voices already scheduled or sounding. 'ring' (default)
   * lets them finish naturally; 'cut' fades them out now, including notes
   * booked into the lookahead window that have not started yet.
   */
  voices?: 'ring' | 'cut';
}

/**
 * Returned by loop(): call stop() to stop scheduling new cycles. By default
 * already-scheduled voices ring out; pass `{ voices: 'cut' }` to silence them.
 */
export interface LoopHandle {
  stop(options?: LoopStopOptions): void;
}

export interface OfflineContextInit {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
}

export interface RenderOptions {
  /** Whole pattern cycles to render. Default 1 when `seconds` is omitted. Pass this or `seconds`, not both. */
  cycles?: number;
  /** Seconds of the pattern to render: onsets at or after this time are dropped. */
  seconds?: number;
  /** Tempo, as in `loop()`: beats per minute (four beats a cycle). Pass this or `cps`. */
  bpm?: number;
  /** Tempo, as in `loop()`: cycles per second. Falls back to `setcpm()`, then the default tempo. */
  cps?: number;
  /** Sample rate of the render. Default 48000. */
  sampleRate?: number;
  /** Output channels: 1, 2, 4, 6 or 8. More than two uses discrete multichannel output. Default 2. */
  channels?: 1 | 2 | 4 | 6 | 8;
  /** Extra seconds rendered after the pattern, so releases and reverb can ring out. Default 0. */
  tail?: number;
  /** Fold the tail onto the start, so the result loops seamlessly. The result is then exactly one pass long. A master `ceiling` still holds after the fold: the folded sum is clamped to it. Default false. */
  wrap?: boolean;
  /** Seeds noise and reverb so the same inputs give the same samples on the same engine. Default 0. */
  seed?: number | string;
  /** Hold each note for its share of the cycle, like `loop()`. Use `false` for a one-shot like `play()`. Default true. */
  gated?: boolean;
  /** Route through the master bus and its limiter (default), tune it with an object, or `false` for the raw mix. A `ceiling` bounds the returned samples, including after `wrap` folds the tail. */
  master?: boolean | Omit<MasterBusOptions, 'output'>;
  /**
   * Books the voices in windows of this many seconds instead of all up front:
   * the render pauses (`suspend()`) a window ahead of each window's first
   * onset, books that window's voices, and resumes. The audio is the same as
   * booking up front; a renderer that processes every node from the moment it
   * is made does far less work this way. Must cover at least two render quanta
   * (256 frames). On a context without `suspend()` and `resume()` everything
   * is booked up front, with a warning. Default: off, every voice is booked
   * before the render starts.
   */
  bookingWindow?: number;
  /** Builds the offline context. Defaults to the global `OfflineAudioContext`; supply this outside a browser. */
  context?: (init: OfflineContextInit) => OfflineAudioContextLike;
}

/** Settings for the bus's limiter, which is a fast, high-ratio compressor. */
export interface LimiterOptions {
  /** Level in dB above which gain reduction starts. Default -2. */
  threshold?: number;
  /** dB range over which the reduction eases in. Default 0 (a hard knee). */
  knee?: number;
  /** Compression ratio; 20 is close to brick-wall. Default 20. */
  ratio?: number;
  /** Seconds the limiter takes to clamp down on a peak. Default 0.003. */
  attack?: number;
  /** Seconds the limiter takes to let go afterwards. Default 0.1. */
  release?: number;
  /**
   * Browsers' dynamics compressors add automatic makeup gain, which would
   * otherwise make the limited mix louder and push peaks back toward full
   * scale. With this on (the default) a gain stage after the compressor takes
   * that makeup back out, so the threshold really is near the ceiling. The
   * compensation is worked out for a hard knee at full-scale input, so it is
   * approximate when `knee` is above 0. Set `false` to keep the makeup.
   */
  compensate?: boolean;
}

export interface MasterBusOptions {
  /** Where the bus sends its signal. Default `ctx.destination`. */
  output?: AudioNodeLike;
  /** Output level multiplier applied before the limiter. Default 1. */
  gain?: number;
  /** `true` (default) for the default limiter, an object to tune it, or `false` for gain only. */
  limiter?: boolean | LimiterOptions;
  /**
   * A hard ceiling in dBFS (0 or below), as the last stage of the bus: a wave
   * shaper that passes every sample below the ceiling unchanged and clips any
   * sample above it to the ceiling, so the output never exceeds it. It catches
   * the transients the limiter's attack lets through. It works with or without
   * the limiter and on any number of channels, and is skipped, with a warning,
   * when the context has no `createWaveShaper`. It bounds sample values, not
   * the peaks between samples. Default: no ceiling, and no node.
   */
  ceiling?: number;
}

export interface MasterBus {
  /** Pass this as `output` to play(), loop() or playParams(). Its `gain` param is the bus level. */
  readonly input: GainNodeLike;
  /** The limiter, when one is in the path. */
  readonly compressor?: DynamicsCompressorNodeLike;
  /** The ceiling's clip, when `ceiling` is set. */
  readonly clipper?: WaveShaperNodeLike;
}

export interface OrbitBus {
  /** Send a voice's reverb-wet signal here. */
  readonly reverbInput: GainNodeLike;
  /** Send a voice's delay-wet signal here. */
  readonly delayInput: GainNodeLike;
  /** Regenerates the shared impulse response when `size` differs from what's already loaded. */
  setRoomSize(size: number): void;
  /**
   * Updates the shared delay/feedback when they differ from what's already set.
   * Changes land at `when` (default: now), so a booked voice's delay takes
   * effect at its onset rather than when it was scheduled.
   */
  setDelay(time: number, feedback: number, when?: number): void;
}

export interface SampleSource {
  /** Fetched with the platform `fetch()` and decoded on demand or via loadSamples(). */
  url?: string;
  /** Already-downloaded encoded audio, decoded on demand or via loadSamples(). */
  data?: ArrayBuffer;
  /** An already-decoded buffer — used as-is, no fetch/decode step at all. */
  buffer?: AudioBufferLike;
  /**
   * The pitch this recording actually sounds at. .s()'d samples playing a
   * pitched note() event use `noteToFrequency(pitch) / noteToFrequency(baseNote)`
   * as their playback rate. Defaults to "c4" when omitted.
   */
  baseNote?: string | number;
}

export interface WavOptions {
  /** Sample format: 16 or 24-bit integer PCM, or 32-bit IEEE float. Default 16. */
  bitDepth?: 16 | 24 | 32;
  /** Add TPDF dither before quantizing. 16-bit only. Default true. */
  dither?: boolean;
  /** Seed for the dither noise, so the same render always gives the same bytes. Default 0. */
  seed?: number | string;
  /** Speaker position mask for 3-8 channel files. Defaults follow the channel count. */
  channelMask?: number;
}

export type WavSource =
  RenderedAudioBufferLike | { sampleRate: number; channels: readonly Float32Array[] };
