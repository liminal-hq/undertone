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
//
// What a context decoded (a promise in flight, a finished buffer) belongs to the registration it decoded, not to the name: it
// is kept on its `Entry`, in a map keyed by the context, and counts only while the registry still holds that very entry.
// Registering a name again, or clearing the registry, drops the entry and so everything any context decoded for the old source
// at once (nothing is left to prune, and a decoded `AudioBuffer` is not retained by a context that lives on), and a decode still
// in flight for it is not kept. A finished decode is kept only as its buffer, not as its promise. A decoded buffer carries the
// PCM read from itself: another context's decode of the same source may be resampled to its own rate, so no context's PCM
// stands in for another's.

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
  /** What each context decoded for this registration. */
  readonly decodedOn: WeakMap<AudioContextLike, HostBuffer>;
  /** The decodes in flight on each context for this registration (removed when they settle). */
  readonly pendingOn: WeakMap<AudioContextLike, Promise<AudioBufferLike>>;
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

/** A host buffer with the PCM read from it (and its rate, when it says one). */
function hostOf(buffer: AudioBufferLike, pcm: Pcm): HostBuffer {
  const rate = (buffer as { sampleRate?: unknown }).sampleRate;
  return {
    buffer,
    channels: pcm.channels,
    ...(typeof rate === 'number' ? { sampleRate: rate } : {})
  };
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
const warned = new Set<string>();
let render: SampleSink | undefined;

setHostBuffers((ctx) => {
  const hosts: HostBuffer[] = [];
  for (const entry of registry.values()) {
    const host = entry.host ?? entry.decodedOn.get(ctx);
    if (host) hosts.push(host);
  }
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
  const entry: Entry = { source: normalized, decodedOn: new WeakMap(), pendingOn: new WeakMap() };
  if (normalized.buffer) {
    const pcm = pcmOf(normalized.buffer);
    entry.pcm = pcm;
    entry.host = hostOf(normalized.buffer, pcm);
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

/**
 * Keeps a buffer decoded on `ctx` for `entry`, with the PCM read from that buffer, and hands the PCM to the modules the first
 * time the sample has one (the modules keep the first decode's: one registry per instance).
 */
function decoded(ctx: AudioContextLike, key: string, entry: Entry, buffer: AudioBufferLike): void {
  const pcm = pcmOf(buffer);
  // Nothing is kept until the modules accept the PCM: a module that rejects it leaves the sample undecoded, and the next call retries.
  if (!entry.pcm) {
    glue.loadSample(key, pcm);
    render?.loadSample(key, pcm);
    entry.pcm = pcm;
  }
  entry.decodedOn.set(ctx, hostOf(buffer, pcm));
}

function ensureDecoded(ctx: AudioContextLike, key: string): Promise<AudioBufferLike> {
  const entry = registry.get(key);
  if (!entry) {
    return Promise.reject(
      new Error(`Sample "${key}" is not registered. Call registerSample() first.`)
    );
  }
  // A decode finished, or in flight, for this very registration is joined; one for an earlier registration is not (it is gone).
  const done = entry.decodedOn.get(ctx);
  if (done) return Promise.resolve(done.buffer);
  const existing = entry.pendingOn.get(ctx);
  if (existing) return existing;

  const settle = (): void => {
    if (entry.pendingOn.get(ctx) === promise) entry.pendingOn.delete(ctx);
  };
  const promise: Promise<AudioBufferLike> = decodeEntry(ctx, key, entry.source).then(
    (buffer) => {
      try {
        // A sample registered again while this decode was in flight keeps its new source.
        if (registry.get(key) === entry) decoded(ctx, key, entry, buffer);
      } finally {
        // Nothing is cached but the buffer itself: a failure reading it is a failure to decode, and the next call retries.
        settle();
      }
      return buffer;
    },
    (error: unknown) => {
      // A failure is not cached, so a later call retries (after a network blip, or a new registration).
      settle();
      throw error;
    }
  );
  entry.pendingOn.set(ctx, promise);
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
  const entry = registry.get(key);
  if (entry) {
    const cached = entry.decodedOn.get(ctx);
    if (cached) return cached.buffer;
  }
  if (!entry) {
    warnOnce(
      key,
      `undertone: sample "${key}" is not registered — voice skipped. Call registerSample() first.`
    );
    return undefined;
  }
  if (entry.host) return entry.host.buffer;
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
