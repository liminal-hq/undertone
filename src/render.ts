// Offline rendering: books a whole pattern on an OfflineAudioContext, up front or in windows, and returns the audio
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { isVoiceSkipped, playVoice } from './engine.js';
import { Fraction } from './fraction.js';
import { ceilingTop, createMasterBus } from './masterBus.js';
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
import { warnOnce } from './warn.js';

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

const DEFAULT_SAMPLE_RATE = 48000;
/** Frames in one Web Audio render quantum, the unit `suspend()` times are quantized to. */
const RENDER_QUANTUM_FRAMES = 128;
/** The orbit a voice without one sends to, as in the engine. */
const DEFAULT_ORBIT = 0;
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
 * Clamps every sample of a folded buffer to the master ceiling. The bus clips
 * the tail and the start separately, so once they are added the sum can pass
 * the ceiling; this holds the returned buffer to it.
 */
function clampToCeiling(rendered: RenderedAudioBufferLike, ceilingDb: number): void {
  const top = ceilingTop(10 ** (ceilingDb / 20));
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    const data = rendered.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.max(-top, Math.min(top, data[i]));
    }
  }
}

/** The voices to book at one pause of the render, and when that pause is. */
interface BookingWindow {
  /** Seconds on the render's clock; 0 means before the render starts. */
  suspendAt: number;
  voices: PendingVoice[];
}

/**
 * Gives every reverb voice on an orbit the room size the orbit's last booked
 * voice has, counting only voices the engine will really book (`isVoiceSkipped`
 * leaves out a sample with no buffer). Booked up front, the last size booked on an orbit replaces the
 * impulse response for the whole render; booked in windows, a later size would
 * only replace it part way through. With this the windowed render builds the
 * same impulse response, from the same seeded key, once.
 */
function lastRoomSizes(ctx: AudioContextLike, voices: readonly PendingVoice[]): PendingVoice[] {
  const sendsRoom = ({ params }: PendingVoice) =>
    params.roomLevel !== undefined && params.roomLevel > 0;
  const last = new Map<number, number>();
  for (const voice of voices) {
    // A voice the engine skips (a sample with no buffer) never reaches the bus, so it sets no size.
    if (sendsRoom(voice) && !isVoiceSkipped(ctx, voice.params)) {
      last.set(voice.params.orbit ?? DEFAULT_ORBIT, voice.params.roomSize);
    }
  }
  return voices.map((voice) => {
    const size = last.get(voice.params.orbit ?? DEFAULT_ORBIT);
    return !sendsRoom(voice) || size === undefined || size === voice.params.roomSize
      ? voice
      : { ...voice, params: { ...voice.params, roomSize: size } };
  });
}

/**
 * Splits voices, already in booking order, into windows of `seconds` by their
 * onset (nudge included). The voices of window k are booked at a pause at the
 * start of window k - 1, a whole window ahead, so a pause quantized up to the
 * next render quantum still comes before any of them sound. Windows 0 and 1
 * are booked before the render starts. A pause never falls within two render
 * quanta of the end (`lastPause`, in seconds), where a context would refuse
 * it: voices nudged that late are booked at the last pause before it.
 */
function bookingWindows(
  voices: readonly PendingVoice[],
  seconds: number,
  lastPause: number
): BookingWindow[] {
  const lastIndex = Math.max(Math.floor(lastPause / seconds), 0);
  const windows: BookingWindow[] = [];
  for (const voice of voices) {
    const onset = Math.max(voice.startTime + voice.params.nudgeTime, 0);
    const index = Math.min(Math.max(Math.floor(onset / seconds) - 1, 0), lastIndex);
    const suspendAt = index * seconds;
    const current = windows.at(-1);
    if (current && current.suspendAt === suspendAt) {
      current.voices.push(voice);
    } else {
      windows.push({ suspendAt, voices: [voice] });
    }
  }
  return windows;
}

/** Renders with each window's voices booked at a pause of the render, then resumes it. */
async function renderInWindows(
  ctx: OfflineAudioContextLike & Required<Pick<OfflineAudioContextLike, 'suspend' | 'resume'>>,
  windows: readonly BookingWindow[],
  book: (voice: PendingVoice) => void
): Promise<RenderedAudioBufferLike> {
  let failure: { error: unknown } | undefined;
  const pauses: Promise<void>[] = [];
  for (const window of windows) {
    if (window.suspendAt === 0) {
      window.voices.forEach(book);
      continue;
    }
    pauses.push(
      ctx.suspend(window.suspendAt).then(
        () => {
          try {
            window.voices.forEach(book);
          } catch (error) {
            failure ??= { error };
          }
          return ctx.resume();
        },
        (error: unknown) => {
          failure ??= { error };
        }
      )
    );
  }
  const rendered = await ctx.startRendering();
  await Promise.all(pauses);
  if (failure) {
    throw failure.error;
  }
  return rendered;
}

/** Whether a context can pause and resume a render, which booking in windows needs. */
function canSuspend(
  ctx: OfflineAudioContextLike
): ctx is OfflineAudioContextLike & Required<Pick<OfflineAudioContextLike, 'suspend' | 'resume'>> {
  return typeof ctx.suspend === 'function' && typeof ctx.resume === 'function';
}

/**
 * Renders a pattern to an audio buffer with no real-time clock: every event is
 * booked on an offline context, up front by default or in windows with
 * `bookingWindow`, so the same pattern, tempo and `seed` give the same samples
 * on the same engine. Pass the result to `encodeWav` to write a file.
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
  const bookingWindow = options.bookingWindow;
  if (bookingWindow !== undefined) {
    requirePositive('bookingWindow', bookingWindow);
    if (bookingWindow * sampleRate < 2 * RENDER_QUANTUM_FRAMES) {
      throw new Error(
        `bookingWindow must cover at least ${2 * RENDER_QUANTUM_FRAMES} frames (${(2 * RENDER_QUANTUM_FRAMES) / sampleRate} s at ${sampleRate} Hz), got ${bookingWindow}`
      );
    }
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
  const book = (voice: PendingVoice) => playVoice(ctx, voice.params, voice.startTime, { output });

  let rendered: RenderedAudioBufferLike;
  if (bookingWindow !== undefined && canSuspend(ctx)) {
    rendered = await renderInWindows(
      ctx,
      bookingWindows(
        lastRoomSizes(ctx, voices),
        bookingWindow,
        (length - 2 * RENDER_QUANTUM_FRAMES) / sampleRate
      ),
      book
    );
  } else {
    if (bookingWindow !== undefined) {
      warnOnce(
        'render-no-suspend',
        'undertone: this offline context has no suspend() and resume(), so bookingWindow is ignored and every voice is booked up front.'
      );
    }
    voices.forEach(book);
    rendered = await ctx.startRendering();
  }
  if (!options.wrap || tail <= 0) {
    return rendered;
  }
  const folded = foldTail(ctx, rendered, passLength);
  const ceiling = typeof options.master === 'object' ? options.master.ceiling : undefined;
  if (ceiling !== undefined) {
    clampToCeiling(folded, ceiling);
  }
  return folded;
}
