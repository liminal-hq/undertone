// Offline rendering: books a whole pattern up front on an OfflineAudioContext and returns the audio
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { playVoice } from './engine.js';
import { Fraction } from './fraction.js';
import { createMasterBus } from './masterBus.js';
import type { MasterBusOptions } from './masterBus.js';
import type { Hap, TimeSpan } from './pattern.js';
import { seedContext } from './random.js';
import { loadSamples, resolveRegisteredKey } from './samples.js';
import { collectOnsets, cycleSecondsFor } from './scheduler.js';
import type { PendingVoice } from './scheduler.js';
import { enableMultichannel } from './surround.js';
import type {
  AudioContextLike,
  ControlPatch,
  OfflineAudioContextLike,
  RenderedAudioBufferLike
} from './types.js';

/** The minimal pattern surface a render needs (avoids a runtime import cycle). */
interface RenderablePattern {
  query(span: TimeSpan): Hap<ControlPatch>[];
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
  /** Fold the tail onto the start, so the result loops seamlessly. The result is then exactly one pass long. Default false. */
  wrap?: boolean;
  /** Seeds noise and reverb so the same inputs give the same samples on the same engine. Default 0. */
  seed?: number | string;
  /** Hold each note for its share of the cycle, like `loop()`. Use `false` for a one-shot like `play()`. Default true. */
  gated?: boolean;
  /** Route through the master bus and its limiter (default), tune it with an object, or `false` for the raw mix. */
  master?: boolean | Omit<MasterBusOptions, 'output'>;
  /** Builds the offline context. Defaults to the global `OfflineAudioContext`; supply this outside a browser. */
  context?: (init: OfflineContextInit) => OfflineAudioContextLike;
}

const DEFAULT_SAMPLE_RATE = 48000;
const CHANNEL_COUNTS: readonly number[] = [1, 2, 4, 6, 8];

function defaultContext(init: OfflineContextInit): OfflineAudioContextLike {
  const Offline = (
    globalThis as {
      OfflineAudioContext?: new (
        numberOfChannels: number,
        length: number,
        sampleRate: number
      ) => OfflineAudioContextLike;
    }
  ).OfflineAudioContext;
  if (!Offline) {
    throw new Error(
      'renderToBuffer needs OfflineAudioContext, which is not available here; pass a `context` factory'
    );
  }
  return new Offline(init.numberOfChannels, init.length, init.sampleRate);
}

function requirePositive(name: string, value: number): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error(`${name} must be positive, got ${value}`);
  }
}

/** Adds the tail's samples onto the start of a pass-length copy, so a looped file has no gap at the seam. */
function foldTail(
  ctx: AudioContextLike,
  rendered: RenderedAudioBufferLike,
  passLength: number
): RenderedAudioBufferLike {
  const folded = ctx.createBuffer(
    rendered.numberOfChannels,
    passLength,
    rendered.sampleRate
  ) as RenderedAudioBufferLike;
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    const source = rendered.getChannelData(c);
    const target = folded.getChannelData(c);
    target.set(source.subarray(0, passLength));
    for (let i = passLength; i < source.length; i++) {
      target[(i - passLength) % passLength] += source[i];
    }
  }
  return folded;
}

/**
 * Renders a pattern to an audio buffer with no real-time clock: every event is
 * booked up front on an offline context, so the same pattern, tempo and `seed`
 * give the same samples on the same engine. Pass the result to `encodeWav` to
 * write a file.
 *
 * Room size is fixed per orbit for the whole render (the last one booked wins),
 * because a reverb's impulse response cannot be scheduled.
 */
export async function renderToBuffer(
  pattern: RenderablePattern,
  options: RenderOptions = {}
): Promise<RenderedAudioBufferLike> {
  if (options.cycles !== undefined && options.seconds !== undefined) {
    throw new Error('Pass either cycles or seconds, not both');
  }
  const channels = options.channels ?? 2;
  if (!CHANNEL_COUNTS.includes(channels)) {
    throw new Error(`channels must be 1, 2, 4, 6 or 8, got ${channels}`);
  }
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  requirePositive('sampleRate', sampleRate);
  const tail = options.tail ?? 0;
  if (!(tail >= 0) || !Number.isFinite(tail)) {
    throw new Error(`tail must be zero or more seconds, got ${tail}`);
  }
  const cycleSeconds = cycleSecondsFor(options.bpm, options.cps);

  let cycles: number;
  let passSeconds: number;
  if (options.seconds !== undefined) {
    requirePositive('seconds', options.seconds);
    passSeconds = options.seconds;
    cycles = Math.ceil(passSeconds / cycleSeconds);
  } else {
    cycles = options.cycles ?? 1;
    if (!Number.isInteger(cycles) || cycles < 1) {
      throw new Error(`cycles must be a positive whole number, got ${cycles}`);
    }
    passSeconds = cycles * cycleSeconds;
  }

  const passLength = Math.max(1, Math.round(passSeconds * sampleRate));
  const length = Math.max(1, Math.round((passSeconds + tail) * sampleRate));
  const ctx = (options.context ?? defaultContext)({
    numberOfChannels: channels,
    length,
    sampleRate
  });
  if (channels > 2) {
    enableMultichannel(ctx);
  }
  seedContext(ctx, options.seed ?? 0);

  const output =
    options.master === false
      ? undefined
      : createMasterBus(ctx, options.master === true ? {} : options.master).input;

  const gated = options.gated ?? true;
  const voices: PendingVoice[] = [];
  for (let k = 0; k < cycles; k++) {
    const span = { begin: new Fraction(k), end: new Fraction(k + 1) };
    for (const voice of collectOnsets(pattern, span, 0, cycleSeconds, gated)) {
      if (options.seconds === undefined || voice.startTime < passSeconds) {
        voices.push(voice);
      }
    }
  }

  // A fresh context has decoded nothing, and a sample voice with no buffer is skipped.
  const sampleKeys = new Set<string>();
  for (const { params } of voices) {
    if (params.sampleName !== undefined) {
      const key = resolveRegisteredKey(params.sampleName, params.sampleBank);
      if (key !== undefined) {
        sampleKeys.add(key);
      }
    }
  }
  await loadSamples(ctx, [...sampleKeys]);

  // Book in time order, so cut groups choke the voice that really played before.
  voices.sort((a, b) => a.startTime + a.params.nudgeTime - (b.startTime + b.params.nudgeTime));
  for (const voice of voices) {
    playVoice(ctx, voice.params, voice.startTime, { output });
  }

  const rendered = await ctx.startRendering();
  return options.wrap && tail > 0 ? foldTail(ctx, rendered, passLength) : rendered;
}
