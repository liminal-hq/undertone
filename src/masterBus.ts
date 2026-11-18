// An opt-in master bus: a gain stage, a limiter and an optional ceiling between your voices and the speakers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type {
  AudioContextLike,
  AudioNodeLike,
  DynamicsCompressorNodeLike,
  GainNodeLike,
  WaveShaperNodeLike
} from './types.js';
import { warnOnce } from './warn.js';

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

const DEFAULTS: Required<LimiterOptions> = {
  threshold: -2,
  knee: 0,
  ratio: 20,
  attack: 0.003,
  release: 0.1,
  compensate: true
};

// A compressor's automatic makeup gain, as implemented in WebKit/Blink and Gecko: the reciprocal of
// the gain a full-scale (0 dB) input would be left with, raised to 0.6.
const MAKEUP_EXPONENT = 0.6;

/** The linear gain that cancels the compressor's automatic makeup for a hard knee. */
function makeupCompensation(thresholdDb: number, ratio: number): number {
  if (!(thresholdDb < 0) || !(ratio > 1)) {
    return 1; // nothing above the threshold is reduced, so no makeup is added
  }
  const fullScaleOutDb = thresholdDb + (0 - thresholdDb) / ratio;
  const fullScaleGain = 10 ** (fullScaleOutDb / 20);
  return (1 / fullScaleGain) ** -MAKEUP_EXPONENT;
}

/** Points in the ceiling's curve: odd, so 0 maps to exactly 0, and fine enough that the knee is sharp. */
const CEILING_CURVE_POINTS = 4097;

/**
 * The clip curve for a ceiling at `level` (linear, 0 to 1): the identity,
 * clamped to ±level. A wave shaper maps input -1..1 onto the curve by linear
 * interpolation and holds the end values beyond it, so input past full scale
 * comes out at ±level too. Because the clamp is concave above zero (and
 * convex below), interpolating between points never overshoots the level.
 */
export function ceilingCurve(level: number): Float32Array {
  const top = float32Below(level);
  const curve = new Float32Array(CEILING_CURVE_POINTS);
  const last = CEILING_CURVE_POINTS - 1;
  for (let i = 0; i < CEILING_CURVE_POINTS; i++) {
    curve[i] = Math.max(-top, Math.min(top, (2 * i) / last - 1));
  }
  return curve;
}

/**
 * One float32 step below the largest float32 at or below `value`. A wave
 * shaper interpolates in float32, and blending two equal points can round up
 * by one step, so the flat part of the curve sits a step low to land at or
 * under the ceiling all the same (measured: without the step, a renderer's
 * output came one step, 3e-8, over).
 */
function float32Below(value: number): number {
  const word = new Float32Array([value]);
  const bits = new Uint32Array(word.buffer);
  if (word[0] > value) {
    bits[0] -= 1; // positive floats order like their bits
  }
  bits[0] -= 1;
  return word[0];
}

/** Puts the ceiling's clip between `from` and `output` when there is one, and returns it. */
function connectCeiling(
  ctx: AudioContextLike,
  from: AudioNodeLike,
  output: AudioNodeLike,
  ceiling: number | undefined
): WaveShaperNodeLike | undefined {
  if (ceiling === undefined) {
    from.connect(output);
    return undefined;
  }
  if (!ctx.createWaveShaper) {
    warnOnce(
      'master-bus-no-wave-shaper',
      'undertone: this audio context has no createWaveShaper(), so the master bus has no ceiling.'
    );
    from.connect(output);
    return undefined;
  }
  const clipper = ctx.createWaveShaper();
  clipper.curve = ceilingCurve(10 ** (ceiling / 20));
  clipper.oversample = 'none';
  from.connect(clipper);
  clipper.connect(output);
  return clipper;
}

/**
 * Creates a master bus: voices play into `bus.input`, pass a gain stage and a
 * limiter, and reach `output` (the speakers by default). Undertone writes
 * straight to the destination otherwise, so a dense mix can peak near or above
 * full scale; routing it through this keeps it in range.
 *
 * Nothing is created until you call this, and it is an ordinary object you
 * hold, so a game with several mix groups can make one per group. The limiter
 * is skipped, with a warning, when the output has more than two channels (a
 * dynamics compressor only handles stereo, so it would collapse a surround
 * mix) or when the context has no `createDynamicsCompressor`; the gain stage
 * still works.
 */
export function createMasterBus(ctx: AudioContextLike, options: MasterBusOptions = {}): MasterBus {
  const output = options.output ?? ctx.destination;
  const level = options.gain ?? 1;
  if (!(level >= 0)) {
    throw new Error(`createMasterBus() gain must not be negative, got ${level}`);
  }

  const ceiling = options.ceiling;
  if (ceiling !== undefined && !(ceiling <= 0)) {
    throw new Error(`createMasterBus() ceiling must be 0 dBFS or below, got ${ceiling}`);
  }
  if (ceiling === -Infinity) {
    throw new Error('createMasterBus() ceiling must be a finite level in dBFS');
  }

  const input = ctx.createGain();
  input.gain.setValueAtTime(level, ctx.currentTime);
  const finish = (from: AudioNodeLike, compressor?: DynamicsCompressorNodeLike): MasterBus => {
    const clipper = connectCeiling(ctx, from, output, ceiling);
    return { input, ...(compressor && { compressor }), ...(clipper && { clipper }) };
  };

  const limiter = options.limiter ?? true;
  if (limiter === false) {
    return finish(input);
  }

  const channels = (output as { channelCount?: number }).channelCount ?? 2;
  if (channels > 2) {
    warnOnce(
      'master-bus-surround',
      `undertone: the master bus limiter is skipped because the output has ${channels} channels; a compressor would fold it to stereo.`
    );
    return finish(input);
  }
  if (!ctx.createDynamicsCompressor) {
    warnOnce(
      'master-bus-no-compressor',
      'undertone: this audio context has no createDynamicsCompressor(), so the master bus has no limiter.'
    );
    return finish(input);
  }

  const settings = { ...DEFAULTS, ...(limiter === true ? {} : limiter) };
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(settings.threshold, ctx.currentTime);
  compressor.knee.setValueAtTime(settings.knee, ctx.currentTime);
  compressor.ratio.setValueAtTime(settings.ratio, ctx.currentTime);
  compressor.attack.setValueAtTime(settings.attack, ctx.currentTime);
  compressor.release.setValueAtTime(settings.release, ctx.currentTime);
  input.connect(compressor);
  if (settings.compensate) {
    const makeup = ctx.createGain();
    makeup.gain.setValueAtTime(
      makeupCompensation(settings.threshold, settings.ratio),
      ctx.currentTime
    );
    compressor.connect(makeup);
    return finish(makeup, compressor);
  }
  return finish(compressor, compressor);
}
