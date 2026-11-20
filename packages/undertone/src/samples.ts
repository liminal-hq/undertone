// The sample registry: sources kept here and decoded with the caller's context, their PCM handed to both modules
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The host decodes (D-30): this file keeps 0.3's registry of sources and its per-context decoding (`getSampleBuffer`,
// `loadSamples`), and hands the PCM of every decoded or already-decoded sample to the main module's registry, which the engine
// books from, and to the render module's once it is loaded (it is a second instance with its own registry). A url or data
// source counts as registered in both before it is decoded; its voices are skipped until its PCM arrives.
//
// A url or data sample is decoded on a context when a voice first names it there, as in 0.3: the engine skips the voice and
// says which pending sample it named (`takeRequestedSamples`), and the Web Audio backend hands those keys here. One difference
// from 0.3: the modules' registry is one per instance, not per context, so once a sample is decoded on any context every
// context plays it (without decoding it again).

import { noteToFrequency } from './helpers.js';
import type { SampleSource } from './engineTypes.js';
import type { AudioBufferLike, AudioContextLike } from './types.js';
import { setHostBuffers, setSampleRequests } from './webaudio.js';
import type { HostBuffer } from './webaudio.js';
import { glue } from './wasm.js';

type RegisteredSource = string | ArrayBuffer | AudioBufferLike | SampleSource;

/** The PCM the modules were given. */
interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
}

/** What the render module needs of the registry (its glue's exports). */
export interface SampleSink {
  registerSample(name: string, source: unknown): void;
  registerPendingSample(name: string, baseNote: unknown): void;
  loadSample(name: string, decoded: unknown): void;
  clearSamples(): void;
}

interface Entry {
  source: SampleSource;
  /** The host buffer of a `buffer` source, with the PCM read from it. */
  host?: HostBuffer;
  /** The PCM handed to the modules, once there is one. */
  pcm?: Pcm;
}

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
    // Eager validation, as 0.3 did, so a typo'd baseNote fails at registration and not inside a loop's tick.
    noteToFrequency(normalized.baseNote);
  }
  return normalized;
}

/** The PCM of a decoded buffer: one channel per `numberOfChannels` (one when the buffer does not say). */
function pcmOf(buffer: AudioBufferLike): Pcm {
  const shaped = buffer as AudioBufferLike & { numberOfChannels?: number; sampleRate?: number };
  const count = shaped.numberOfChannels ?? 1;
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < count; channel += 1)
    channels.push(buffer.getChannelData(channel));
  return { sampleRate: shaped.sampleRate ?? 44100, channels };
}

const registry = new Map<string, Entry>();
const decodedByContext = new WeakMap<AudioContextLike, Map<string, HostBuffer>>();
const pendingByContext = new WeakMap<AudioContextLike, Map<string, Promise<AudioBufferLike>>>();
const warned = new Set<string>();
let render: SampleSink | undefined;

setHostBuffers((ctx) => {
  const hosts: HostBuffer[] = [];
  for (const entry of registry.values()) if (entry.host) hosts.push(entry.host);
  const decoded = decodedByContext.get(ctx);
  if (decoded) hosts.push(...decoded.values());
  return hosts;
});

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Hands one registry entry to a module's registry. */
function give(sink: SampleSink, name: string, entry: Entry): void {
  if (entry.pcm) {
    sink.registerSample(name, { ...entry.pcm, baseNote: entry.source.baseNote });
  } else {
    sink.registerPendingSample(name, entry.source.baseNote);
  }
}

/** Connects the render module's registry, once it is loaded, and gives it every sample registered so far. */
export function connectRenderSamples(sink: SampleSink): void {
  render = sink;
  for (const [name, entry] of registry) give(sink, name, entry);
}

/** Registers one sample under `name` — see SampleSource for the accepted forms. */
export function registerSample(name: string, source: RegisteredSource): void {
  const normalized = normalizeSource(source);
  const entry: Entry = { source: normalized };
  if (normalized.buffer) {
    const pcm = pcmOf(normalized.buffer);
    entry.pcm = pcm;
    entry.host = { buffer: normalized.buffer, channels: pcm.channels };
  }
  give(glue, name, entry);
  registry.set(name, entry);
  if (render) give(render, name, entry);
}

/** Registers many samples at once: `{ bd: url, sd: url, ... }`. */
export function registerSamples(map: Record<string, RegisteredSource>): void {
  for (const [name, source] of Object.entries(map)) {
    registerSample(name, source);
  }
}

/** `.bank(name)` is a lookup convention, not a loader: prefer `${bank}_${name}`, fall back to `name`. */
export function resolveRegisteredKey(name: string, bank?: string): string | undefined {
  if (bank !== undefined) {
    const banked = `${bank}_${name}`;
    if (registry.has(banked)) return banked;
  }
  return registry.has(name) ? name : undefined;
}

async function decodeEntry(
  ctx: AudioContextLike,
  key: string,
  entry: SampleSource
): Promise<AudioBufferLike> {
  if (entry.buffer) return entry.buffer;
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

function mapOf<V>(
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

/** Keeps a buffer decoded on `ctx`, and hands its PCM to the modules the first time the sample has one. */
function decoded(ctx: AudioContextLike, key: string, buffer: AudioBufferLike): void {
  const entry = registry.get(key);
  const pcm = entry?.pcm ?? pcmOf(buffer);
  mapOf(decodedByContext, ctx).set(key, { buffer, channels: pcm.channels });
  if (entry && !entry.pcm) {
    entry.pcm = pcm;
    glue.loadSample(key, pcm);
    render?.loadSample(key, pcm);
  }
}

function ensureDecoded(ctx: AudioContextLike, key: string): Promise<AudioBufferLike> {
  const pendingForContext = mapOf(pendingByContext, ctx);
  const existing = pendingForContext.get(key);
  if (existing) return existing;

  const entry = registry.get(key);
  if (!entry) {
    return Promise.reject(
      new Error(`Sample "${key}" is not registered. Call registerSample() first.`)
    );
  }

  const promise = decodeEntry(ctx, key, entry.source).then(
    (buffer) => {
      // A sample registered again while this decode was in flight keeps its new source.
      if (registry.get(key) === entry) decoded(ctx, key, buffer);
      return buffer;
    },
    (error: unknown) => {
      // A failure is not cached, so a later call retries (after a network blip, or a new registration).
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

/** Starts (or joins) decoding, on `ctx`, the pending samples a booking's voices named, as 0.3's lookup did for each. */
function decodeRequested(ctx: AudioContextLike, keys: string[]): void {
  for (const key of keys) {
    ensureDecoded(ctx, key).catch(() => {
      warnOnce(key, `undertone: sample "${key}" failed to load — voice skipped.`);
    });
  }
}

setSampleRequests(decodeRequested);

/** The registered keys whose PCM no module has yet and which the strings of a render name (the render decodes them first). */
export function pendingKeysIn(strings: readonly string[]): string[] {
  const named = new Set(strings);
  const keys: string[] = [];
  for (const [key, entry] of registry) {
    if (entry.pcm) continue;
    const cut = key.indexOf('_');
    if (
      named.has(key) ||
      (cut > 0 && named.has(key.slice(0, cut)) && named.has(key.slice(cut + 1)))
    ) {
      keys.push(key);
    }
  }
  return keys;
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
  if (cached) return cached.buffer;

  const entry = registry.get(key);
  if (!entry) {
    warnOnce(
      key,
      `undertone: sample "${key}" is not registered — voice skipped. Call registerSample() first.`
    );
    return undefined;
  }
  if (entry.host) {
    mapOf(decodedByContext, ctx).set(key, entry.host);
    return entry.host.buffer;
  }
  ensureDecoded(ctx, key).catch(() => {
    warnOnce(key, `undertone: sample "${key}" failed to load — voice skipped.`);
  });
  return undefined;
}

/** The registered base note for a sample (see SampleSource.baseNote), or undefined if unregistered. */
export function getSampleBaseNote(name: string, bank?: string): string | number | undefined {
  const key = resolveRegisteredKey(name, bank) ?? name;
  return registry.get(key)?.source.baseNote;
}

/** Whether a sample name (optionally with a .bank() prefix) is currently registered. */
export function isSampleRegistered(name: string, bank?: string): boolean {
  return resolveRegisteredKey(name, bank) !== undefined;
}

/** Clears the registry and warning state — test hygiene, not needed in normal use. */
export function clearSamples(): void {
  registry.clear();
  warned.clear();
  glue.clearSamples();
  render?.clearSamples();
}
