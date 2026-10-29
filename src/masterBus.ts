// An opt-in master bus: a gain stage and a limiter between your voices and the speakers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type {
  AudioContextLike,
  AudioNodeLike,
  DynamicsCompressorNodeLike,
  GainNodeLike
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
}

export interface MasterBus {
  /** Pass this as `output` to play(), loop() or playParams(). Its `gain` param is the bus level. */
  readonly input: GainNodeLike;
  /** The limiter, when one is in the path. */
  readonly compressor?: DynamicsCompressorNodeLike;
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

  const input = ctx.createGain();
  input.gain.setValueAtTime(level, ctx.currentTime);

  const limiter = options.limiter ?? true;
  if (limiter === false) {
    input.connect(output);
    return { input };
  }

  const channels = (output as { channelCount?: number }).channelCount ?? 2;
  if (channels > 2) {
    warnOnce(
      'master-bus-surround',
      `undertone: the master bus limiter is skipped because the output has ${channels} channels; a compressor would fold it to stereo.`
    );
    input.connect(output);
    return { input };
  }
  if (!ctx.createDynamicsCompressor) {
    warnOnce(
      'master-bus-no-compressor',
      'undertone: this audio context has no createDynamicsCompressor(), so the master bus has no limiter.'
    );
    input.connect(output);
    return { input };
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
    makeup.connect(output);
  } else {
    compressor.connect(output);
  }
  return { input, compressor };
}
