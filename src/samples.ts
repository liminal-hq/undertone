// Sample registry: bring-your-own-assets playback — nothing bundled, nothing fetched by default
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { noteToFrequency } from './pitch.js';
import type { AudioBufferLike, AudioContextLike } from './types.js';

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

type RegisteredSource = string | ArrayBuffer | AudioBufferLike | SampleSource;

function isAudioBufferLike(value: object): value is AudioBufferLike {
  return typeof (value as AudioBufferLike).getChannelData === 'function';
}

function normalizeSource(source: RegisteredSource): SampleSource {
  const normalized: SampleSource =
    typeof source === 'string'
      ? { url: source }
      : source instanceof ArrayBuffer
        ? { data: source }
        : isAudioBufferLike(source)
          ? { buffer: source }
          : source;
  if (normalized.baseNote !== undefined) {
    // Eager validation — same timing as note()'s pitch parsing — so a typo'd
    // baseNote fails here, at registration, instead of inside playVoice()
    // during a loop's tick: a throw there happens before scheduledUntil
    // advances, so the scheduler would re-query and re-throw on the same
    // window forever.
    noteToFrequency(normalized.baseNote);
  }
  return normalized;
}

const registry = new Map<string, SampleSource>();
const decodedByContext = new WeakMap<AudioContextLike, Map<string, AudioBufferLike>>();
const pendingByContext = new WeakMap<AudioContextLike, Map<string, Promise<AudioBufferLike>>>();
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.warn(message);
}

/** Registers one sample under `name` — see SampleSource for the accepted forms. */
export function registerSample(name: string, source: RegisteredSource): void {
  registry.set(name, normalizeSource(source));
}

/** Registers many samples at once: `{ bd: url, sd: url, ... }`. */
export function registerSamples(map: Record<string, RegisteredSource>): void {
  for (const [name, source] of Object.entries(map)) {
    registerSample(name, source);
  }
}

/** `.bank(name)` is a lookup convention, not a loader: prefer `${bank}_${name}`, fall back to `name`. */
function resolveRegisteredKey(name: string, bank?: string): string | undefined {
  if (bank !== undefined) {
    const banked = `${bank}_${name}`;
    if (registry.has(banked)) {
      return banked;
    }
  }
  return registry.has(name) ? name : undefined;
}

async function decodeEntry(
  ctx: AudioContextLike,
  key: string,
  entry: SampleSource
): Promise<AudioBufferLike> {
  if (entry.buffer) {
    return entry.buffer;
  }
  let data = entry.data;
  if (!data) {
    if (!entry.url) {
      throw new Error(`Sample "${key}" has no url, data, or buffer to decode.`);
    }
    const response = await fetch(entry.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch sample "${key}" from ${entry.url}: ${response.status}`);
    }
    data = await response.arrayBuffer();
  }
  return ctx.decodeAudioData(data);
}

function getOrCreateMap<V>(
  weakMap: WeakMap<AudioContextLike, Map<string, V>>,
  ctx: AudioContextLike
): Map<string, V> {
  let map = weakMap.get(ctx);
  if (!map) {
    map = new Map();
    weakMap.set(ctx, map);
  }
  return map;
}

function ensureDecoded(ctx: AudioContextLike, key: string): Promise<AudioBufferLike> {
  const pendingForContext = getOrCreateMap(pendingByContext, ctx);
  const existing = pendingForContext.get(key);
  if (existing) {
    return existing;
  }

  const entry = registry.get(key);
  if (!entry) {
    return Promise.reject(
      new Error(`Sample "${key}" is not registered. Call registerSample() first.`)
    );
  }

  const promise = decodeEntry(ctx, key, entry).then(
    (buffer) => {
      getOrCreateMap(decodedByContext, ctx).set(key, buffer);
      return buffer;
    },
    (error: unknown) => {
      // Don't let a transient failure (a network blip, a bad fetch) wedge
      // this key forever — a rejected promise, once cached, would resolve
      // to that same rejection on every future call. Drop it so the next
      // attempt (e.g. after registerSample() re-registers a working source)
      // retries from scratch.
      pendingByContext.get(ctx)?.delete(key);
      throw error;
    }
  );
  pendingForContext.set(key, promise);
  return promise;
}

/**
 * Explicitly preloads and decodes samples against `ctx` — call up front (e.g.
 * `await loadSamples(ctx)`) so the first play/loop isn't missing voices while
 * decoding is still in flight. Decodes every registered sample when `names`
 * is omitted.
 */
export async function loadSamples(ctx: AudioContextLike, names?: string[]): Promise<void> {
  const targets = names ?? [...registry.keys()];
  await Promise.all(targets.map((name) => ensureDecoded(ctx, name)));
}

/**
 * The engine-facing, synchronous lookup: returns the decoded buffer if it's
 * ready, otherwise kicks off (or joins an in-flight) decode and returns
 * `undefined` for this call — the voice is skipped this time, and later
 * onsets of the same sample will find it once decoding finishes. Warns once
 * per key, only for a genuinely unregistered name or a decode that ultimately
 * fails — a registered sample that just hasn't finished decoding yet is not a
 * warning, that's what loadSamples() is for.
 */
export function getSampleBuffer(
  ctx: AudioContextLike,
  name: string,
  bank?: string
): AudioBufferLike | undefined {
  const key = resolveRegisteredKey(name, bank) ?? name;

  const cached = decodedByContext.get(ctx)?.get(key);
  if (cached) {
    return cached;
  }

  const entry = registry.get(key);
  if (!entry) {
    warnOnce(
      key,
      `undertone: sample "${key}" is not registered — voice skipped. Call registerSample() first.`
    );
    return undefined;
  }

  // Already-decoded buffers need no async step at all — return synchronously
  // (and cache, so getSampleBuffer/ensureDecoded agree on where decoded
  // buffers live regardless of which path produced them).
  if (entry.buffer) {
    getOrCreateMap(decodedByContext, ctx).set(key, entry.buffer);
    return entry.buffer;
  }

  ensureDecoded(ctx, key).catch(() => {
    warnOnce(key, `undertone: sample "${key}" failed to load — voice skipped.`);
  });
  return undefined;
}

/** The registered base note for a sample (see SampleSource.baseNote), or undefined if unregistered. */
export function getSampleBaseNote(name: string, bank?: string): string | number | undefined {
  const key = resolveRegisteredKey(name, bank) ?? name;
  return registry.get(key)?.baseNote;
}

/** Clears the registry and warning state — test hygiene, not needed in normal use. */
export function clearSamples(): void {
  registry.clear();
  warned.clear();
}
