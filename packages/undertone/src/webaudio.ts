// The Web Audio backend: replays the engine's recorded calls onto the caller's context, one engine per context
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The engine books on a recorder (docs/rust-migration/results/M6-BOUNDARY.md, section 12): every Web Audio call becomes a
// record of six numbers, `[op, a, b, c, d, e]`, which the `Replayer` below turns back into the one call the TypeScript engine
// made, in the same order, so the context numbers its nodes as 0.3 did. `run()` replays after every call into the engine, a
// call that throws included (the nodes a failing voice made before the failure stay on the context, and a failed play's
// rollback, D-38, is recorded too). A Web Audio call that throws does not stop its batch: the records that name what the context
// failed to make are skipped, the rest are applied, and the first error is thrown after the batch. The module has finished
// booking before the replay starts, so for a `play()` or a loop's first window (`undo`) a batch whose replay throws is also
// undone on the context: the sources it made are cut, so the call's failure leaves nothing sounding (D-38). The replayer
// forgets what the engine releases, so a long session stays bounded.
//
// A context without one of Web Audio's optional members degrades as 0.3 did, here rather than in the engine: no
// `createPeriodicWave` (a shaped wave plays as a sine, an autopan phase is dropped, each warned once), and a param without
// `cancelScheduledValues` (an early stop cuts the sources hard) or `setTargetAtTime` (the stop's fade is a linear ramp). The
// master bus's missing compressor or wave shaper is handled before booking (engine.ts). Nothing here touches a DOM global: only
// the context and the nodes it makes, so the same code can run where M7's worklet runs.

import type { AudioBufferLike, AudioContextLike, AudioNodeLike } from './types.js';
import { warnOnce } from './warn.js';
import { glue } from './wasm.js';
import type { WasmEngine } from '../wasm/undertone_wasm.js';

/** The names behind a record's numbers, as the module's `graphNames()` gives them. */
interface GraphNames {
  ops: string[];
  kinds: string[];
  params: string[];
  oscillatorTypes: string[];
  filterTypes: string[];
  oversample: string[];
  channelCountModes: string[];
  channelInterpretations: string[];
}

/** A buffer of the host's own (a registered `AudioBuffer`, or one decoded on this context) and the PCM the engine was given for it. */
export interface HostBuffer {
  buffer: AudioBufferLike;
  /** The PCM read from this very buffer. */
  channels: readonly Float32Array[];
  /** The buffer's own sample rate, when it says one: a buffer at another rate is not the buffer the records copy. */
  sampleRate?: number;
}

const WIDTH = 6;

type AnyNode = Record<string, unknown> & {
  connect(target: unknown, output?: number, input?: number): void;
  disconnect(): void;
};

type Param = {
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  exponentialRampToValueAtTime(value: number, time: number): void;
  setTargetAtTime?(value: number, time: number, timeConstant: number): void;
  cancelScheduledValues?(time: number): void;
};

let graphNames: GraphNames | undefined;
let createMethods: string[] | undefined;

/** Seconds of the stop fade per time constant of `setTargetAtTime`, as the engine books it (five time constants). */
const STOP_FADE_TIME_CONSTANTS = 5;

/** Replays records on one context; holds the nodes, buffers, and waves the records name until the engine releases them. */
export class Replayer {
  readonly #ctx: AudioContextLike;
  readonly #names: GraphNames;
  readonly #methods: string[];
  readonly #nodes = new Map<number, AnyNode>();
  readonly #ids = new WeakMap<object, number>();
  readonly #buffers = new Map<number, unknown>();
  readonly #waves = new Map<number, unknown>();
  /** Waves the context could not make: whether each was an autopan LFO's (else a shaped wave's), and its real part. */
  readonly #missingWaves = new Map<number, { autopan: boolean; real: Float32Array }>();
  /**
   * The waves one voice made for itself (an autopan LFO's phase), not the shaped waves the engine keeps and shares: released
   * with the node that uses them. A wave of the engine's own cache must stay, since a later voice names it again.
   */
  readonly #owned = new Set<number>();
  /** How many live nodes use each owned wave, and which wave each such node uses. */
  readonly #waveUsers = new Map<number, number>();
  readonly #nodeWave = new Map<number, number>();
  /**
   * What the context failed to make (a `create` call that threw): the records that name it are skipped, since there is nothing
   * to apply them to, until the engine's own release record for it arrives.
   */
  readonly #deadNodes = new Set<number>();
  readonly #deadBuffers = new Set<number>();
  /** A wave the context failed to make keeps its coefficients: the engine caches shaped waves, so a later voice names it again. */
  readonly #deadWaves = new Map<number, { real: Float32Array; imag: Float32Array; raw: boolean }>();
  readonly #hostBuffers: () => readonly HostBuffer[];
  /** The host buffers standing in for a buffer of the records, so two samples with the same PCM keep a buffer each. */
  readonly #claimed = new Set<AudioBufferLike>();
  /** A stop on a param that cannot cancel automation: the param and the stop time, until the stop's records end. */
  #hardStop: { param: Param; at: number } | undefined;

  constructor(ctx: AudioContextLike, hostBuffers: () => readonly HostBuffer[] = () => []) {
    this.#ctx = ctx;
    this.#names = graphNames ??= glue.graphNames() as GraphNames;
    this.#methods = createMethods ??= this.#names.kinds.map((kind) => `create${kind}`);
    this.#hostBuffers = hostBuffers;
    this.#nodes.set(0, ctx.destination as unknown as AnyNode);
    this.#ids.set(ctx.destination, 0);
  }

  /** How many nodes and buffers the replayer still holds (a long session keeps this bounded). */
  get held(): number {
    return this.#nodes.size + this.#buffers.size;
  }

  /** How many periodic waves the replayer still holds, those the context could not make included. */
  get waves(): number {
    return this.#waves.size + this.#missingWaves.size;
  }

  /** The node behind a number. */
  node<N = AudioNodeLike>(id: number): N {
    const node = this.#nodes.get(id);
    if (node === undefined) throw new Error(`replay: no node ${id}`);
    return node as unknown as N;
  }

  /** The buffer behind a number. */
  buffer(id: number): unknown {
    return this.#buffers.get(id);
  }

  /** The number of a node the records made (or one adopted), or `undefined`. */
  idOf(node: object): number | undefined {
    return this.#ids.get(node);
  }

  /** Maps a number the engine gave with `adopt()` to a node of the host's own. */
  adopt(id: number, node: object): void {
    this.#nodes.set(id, node as AnyNode);
    this.#ids.set(node, id);
  }

  #param(id: number, code: number): Param {
    return this.node<AnyNode>(id)[this.#names.params[code]] as Param;
  }

  /**
   * Replays `[records, data]`, as `take()` returns them. The engine counts a batch as applied once it is taken, so a call that
   * throws does not stop the batch: the records that name something the context failed to make are skipped, the rest are
   * applied (the starts, stops, releases, and a failed play's rollback among them, so nothing is left sounding or held), and the
   * first error is thrown once the batch has been replayed.
   */
  replay(taken: unknown[], options: { undo?: boolean } = {}): void {
    const ops = taken[0] as Float64Array;
    const data = taken[1] as Float32Array;
    const names = this.#names;
    const ctx = this.#ctx as unknown as Record<string, (...args: unknown[]) => unknown>;
    let previous = '';
    let failure: { error: unknown } | undefined;
    const fresh: number[] = [];
    // The sources this batch made, and which of them it started: what an undone batch has to cut.
    const sources: number[] = [];
    const started = new Set<number>();
    for (let at = 0; at < ops.length; at += WIDTH) {
      const op = ops[at];
      const a = ops[at + 1];
      const b = ops[at + 2];
      const c = ops[at + 3];
      const d = ops[at + 4];
      const e = ops[at + 5];
      const name = names.ops[op];
      const hard = this.#hardStop;
      if (
        hard &&
        name !== 'set' &&
        name !== 'linear' &&
        name !== 'exponential' &&
        name !== 'target' &&
        name !== 'cancel' &&
        name !== 'stop'
      ) {
        this.#hardStop = undefined;
      }
      if (this.#skips(name, a, b)) {
        previous = name;
        continue;
      }
      try {
        switch (name) {
          case 'create': {
            const kind = names.kinds[b];
            // Only a merger and a delay take an argument, as the TypeScript engine calls them.
            const node = (
              kind === 'ChannelMerger' || kind === 'Delay'
                ? ctx[this.#methods[b]].call(ctx, c)
                : ctx[this.#methods[b]].call(ctx)
            ) as AnyNode;
            this.#nodes.set(a, node);
            this.#ids.set(node, a);
            if (typeof node.start === 'function') sources.push(a);
            break;
          }
          case 'set':
          case 'linear':
          case 'exponential':
          case 'target': {
            const param = this.#param(a, b);
            if (hard && hard.param === param) break; // a hard stop books nothing on the gain
            if (name === 'set') param.setValueAtTime(c, d);
            else if (name === 'linear') param.linearRampToValueAtTime(c, d);
            else if (name === 'exponential') param.exponentialRampToValueAtTime(c, d);
            else if (param.setTargetAtTime) param.setTargetAtTime(c, d, e);
            // No setTargetAtTime: the stop's fade becomes a straight ramp to the same end, as 0.3 booked it.
            else param.linearRampToValueAtTime(c, d + e * STOP_FADE_TIME_CONSTANTS);
            break;
          }
          case 'cancel': {
            const param = this.#param(a, b);
            if (param.cancelScheduledValues) param.cancelScheduledValues(c);
            // A param that cannot cancel: 0.3 left its automation alone and stopped the sources at the stop itself.
            else this.#hardStop = { param, at: c };
            break;
          }
          case 'oscillatorType':
            this.node<AnyNode>(a).type = names.oscillatorTypes[b];
            break;
          case 'periodicWave': {
            const node = this.node<AnyNode>(a);
            if (this.#owned.has(b) && !this.#nodeWave.has(a)) {
              this.#nodeWave.set(a, b);
              this.#waveUsers.set(b, (this.#waveUsers.get(b) ?? 0) + 1);
            }
            const missing = this.#missingWaves.get(b);
            const dead = this.#deadWaves.get(b);
            if (dead !== undefined) {
              // A transient failure must not cost every later voice its wave: the next use makes it again.
              this.#waves.set(b, this.#makeWave(dead.real, dead.imag, dead.raw));
              this.#deadWaves.delete(b);
            }
            if (missing === undefined) {
              (node.setPeriodicWave as (wave: unknown) => void)(this.#waves.get(b));
            } else if (missing.autopan) {
              warnOnce(
                'autopan-no-periodic-wave',
                'undertone: this audio context has no createPeriodicWave(), so autopan phases are ignored.'
              );
            } else {
              node.type = 'sine';
              warnOnce(
                'no-periodic-wave',
                `undertone: this audio context has no createPeriodicWave(), so "${shapeOf(missing.real)}" falls back to a sine.`
              );
            }
            break;
          }
          case 'filterType':
            this.node<AnyNode>(a).type = names.filterTypes[b];
            break;
          case 'buffer':
            this.node<AnyNode>(a).buffer = b < 0 ? null : this.#buffers.get(b);
            break;
          case 'loop':
            this.node<AnyNode>(a).loop = b !== 0;
            break;
          case 'curve':
            this.node<AnyNode>(a).curve = b < 0 ? null : this.#buffers.get(b);
            break;
          case 'oversample':
            this.node<AnyNode>(a).oversample = names.oversample[b];
            break;
          case 'channelCount':
            this.node<AnyNode>(a).channelCount = b;
            break;
          case 'channelCountMode':
            this.node<AnyNode>(a).channelCountMode = names.channelCountModes[b];
            break;
          case 'channelInterpretation':
            this.node<AnyNode>(a).channelInterpretation = names.channelInterpretations[b];
            break;
          case 'connect': {
            const target = c < 0 ? this.node(b) : this.#param(b, c);
            if (d === 0 && e === 0) this.node<AnyNode>(a).connect(target);
            else this.node<AnyNode>(a).connect(target, d, e);
            break;
          }
          case 'disconnect':
            this.node<AnyNode>(a).disconnect();
            break;
          case 'start':
            (this.node<AnyNode>(a).start as (when: number) => void)(b);
            started.add(a);
            break;
          case 'stop':
            (this.node<AnyNode>(a).stop as (when: number) => void)(hard ? Math.min(b, hard.at) : b);
            break;
          case 'createBuffer':
            this.#buffers.set(
              a,
              this.#hostBuffer(b, c, d, data, e) ?? this.#newBuffer(b, c, d, data, e)
            );
            break;
          case 'createCurve':
            this.#buffers.set(a, data.slice(c, c + b));
            break;
          case 'createWave': {
            const real = data.slice(c, c + b);
            if (!isSharedWave(real, data.subarray(c + b, c + 2 * b))) {
              this.#owned.add(a);
              fresh.push(a);
            }
            if (typeof ctx.createPeriodicWave !== 'function') {
              // An autopan LFO is given its oscillator type just before its wave; a shaped wave is not.
              this.#missingWaves.set(a, { autopan: previous === 'oscillatorType', real });
              break;
            }
            const imag = data.slice(c + b, c + 2 * b);
            try {
              this.#waves.set(a, this.#makeWave(real, imag, d !== 0));
            } catch (error) {
              this.#deadWaves.set(a, { real, imag, raw: d !== 0 });
              throw error;
            }
            break;
          }
          case 'release': {
            const node = this.#nodes.get(a);
            if (node !== undefined) this.#ids.delete(node);
            this.#nodes.delete(a);
            this.#deadNodes.delete(a);
            this.#releaseWaveOf(a);
            break;
          }
          case 'releaseBuffer':
            this.#claimed.delete(this.#buffers.get(a) as AudioBufferLike);
            this.#buffers.delete(a);
            this.#deadBuffers.delete(a);
            break;
          default:
            throw new Error(`replay: unknown op ${op}`);
        }
      } catch (error) {
        failure ??= { error };
        if (name === 'create') this.#deadNodes.add(a);
        else if (name === 'createBuffer' || name === 'createCurve') this.#deadBuffers.add(a);
      }
      previous = name;
    }
    // A wave of a voice's own that no node took (the voice's records ended before it was set) has no one to release it.
    for (const wave of fresh) if (!this.#waveUsers.has(wave)) this.#dropWave(wave);
    if (failure) {
      if (options.undo) this.#undo(sources, started);
      throw failure.error;
    }
  }

  /**
   * Cuts what a failed batch left sounding (a failed `play()` or first loop window, D-38 at the wrapper): every source the batch
   * made is stopped at once when it was started (a source not started yet cannot be stopped), and disconnected from its chain,
   * which silences the voice and cancels a start still ahead. The engine still counts the voices, so each source is remembered
   * as dead, skipping the records that name it until the engine's own release for it arrives. Shared nodes (a bus, the master)
   * stay: later voices use them.
   */
  #undo(sources: number[], started: Set<number>): void {
    for (const id of sources) {
      const node = this.#nodes.get(id);
      if (node === undefined) continue; // released within the batch already
      if (started.has(id)) {
        try {
          (node.stop as (when: number) => void)(0);
        } catch {
          // A source that cannot be stopped is still cut off below.
        }
      }
      try {
        node.disconnect();
      } catch {
        // Nothing more to cut.
      }
      this.#ids.delete(node);
      this.#nodes.delete(id);
      this.#deadNodes.add(id);
      this.#releaseWaveOf(id);
    }
  }

  /** A periodic wave on the context; the TypeScript engine passes no constraints unless normalisation is off. */
  #makeWave(real: Float32Array, imag: Float32Array, raw: boolean): unknown {
    const ctx = this.#ctx as unknown as Record<string, (...args: unknown[]) => unknown>;
    return raw
      ? ctx.createPeriodicWave.call(ctx, real, imag, { disableNormalization: true })
      : ctx.createPeriodicWave.call(ctx, real, imag);
  }

  /** Whether a record names something the context failed to make. */
  #skips(name: string, a: number, b: number): boolean {
    switch (name) {
      case 'create':
      case 'createBuffer':
      case 'createCurve':
      case 'createWave':
      case 'release':
      case 'releaseBuffer':
        return false;
      case 'connect':
        return this.#deadNodes.has(a) || this.#deadNodes.has(b);
      case 'periodicWave':
        return this.#deadNodes.has(a);
      case 'buffer':
      case 'curve':
        return this.#deadNodes.has(a) || (b >= 0 && this.#deadBuffers.has(b));
      default:
        return this.#deadNodes.has(a);
    }
  }

  /** Lets go of the wave a released node used, once no other node uses it. */
  #releaseWaveOf(node: number): void {
    const wave = this.#nodeWave.get(node);
    if (wave === undefined) return;
    this.#nodeWave.delete(node);
    const users = (this.#waveUsers.get(wave) ?? 1) - 1;
    if (users > 0) this.#waveUsers.set(wave, users);
    else this.#dropWave(wave);
  }

  #dropWave(wave: number): void {
    this.#waves.delete(wave);
    this.#missingWaves.delete(wave);
    this.#owned.delete(wave);
    this.#waveUsers.delete(wave);
    this.#deadWaves.delete(wave);
  }

  /** A new buffer on the context, filled from the side data. */
  #newBuffer(
    channels: number,
    length: number,
    sampleRate: number,
    data: Float32Array,
    offset: number
  ): unknown {
    const buffer = this.#ctx.createBuffer(channels, length, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      buffer
        .getChannelData(channel)
        .set(data.subarray(offset + channel * length, offset + (channel + 1) * length));
    }
    return buffer;
  }

  /**
   * The host's own buffer when the records copy a sample the host gave (the engine makes a sample's buffer from the PCM it was
   * handed), so a voice plays the very `AudioBuffer` that was registered or decoded, as 0.3's did, with no second copy.
   */
  #hostBuffer(
    channels: number,
    length: number,
    sampleRate: number,
    data: Float32Array,
    offset: number
  ): AudioBufferLike | undefined {
    for (const host of this.#hostBuffers()) {
      if (this.#claimed.has(host.buffer)) continue;
      if (host.channels.length !== channels || host.channels[0].length !== length) continue;
      if (host.sampleRate !== undefined && host.sampleRate !== sampleRate) continue;
      let same = true;
      for (let channel = 0; channel < channels && same; channel += 1) {
        const pcm = host.channels[channel];
        const base = offset + channel * length;
        for (let i = 0; i < length; i += 1) {
          if (
            pcm[i] !== data[base + i] &&
            !(Number.isNaN(pcm[i]) && Number.isNaN(data[base + i]))
          ) {
            same = false;
            break;
          }
        }
      }
      if (same) {
        this.#claimed.add(host.buffer);
        return host.buffer;
      }
    }
    return undefined;
  }
}

/** The shaped waves' coefficients, read once from a throwaway engine, to name the wave a context could not make. */
let shapes: { type: string; real: Float32Array; imag: Float32Array }[] | undefined;

/** Whether a wave's coefficients are one of the engine's shaped waves, which it makes once and shares between voices. */
function isSharedWave(real: Float32Array, imag: Float32Array): boolean {
  return loadShapes().some((shape) => same(shape.real, real) && same(shape.imag, imag));
}

function same(x: Float32Array, y: Float32Array): boolean {
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

function loadShapes(): NonNullable<typeof shapes> {
  return (shapes ??= (glue.shapedWaveTypes() as string[]).map((type) => {
    const engine = new glue.WasmEngine(44100, 2, 2);
    try {
      engine.playVoice({ soundType: type }, 0, undefined).free();
      const [ops, data] = engine.take() as [Float64Array, Float32Array];
      const createWave = (graphNames as GraphNames).ops.indexOf('createWave');
      for (let at = 0; at < ops.length; at += WIDTH) {
        if (ops[at] === createWave) {
          const start = ops[at + 3];
          const count = ops[at + 2];
          return {
            type,
            real: data.slice(start, start + count),
            imag: data.slice(start + count, start + 2 * count)
          };
        }
      }
      return { type, real: new Float32Array(), imag: new Float32Array() };
    } finally {
      engine.free();
    }
  }));
}

function shapeOf(real: Float32Array): string {
  const found = loadShapes().find((shape) => same(shape.real, real));
  return found?.type ?? 'a shaped wave';
}

// --- One engine per context ---

/** A context's engine, its replayer, and what the wrapper keeps beside them. */
export interface Backend {
  readonly ctx: AudioContextLike;
  readonly engine: WasmEngine;
  readonly replayer: Replayer;
  /** The destination channel count the engine was last told. */
  channels: number;
}

const backends = new WeakMap<object, Backend>();

/** Where the host buffers for a context come from (samples.ts sets it, so this file needs no registry). */
let hostBuffersOf: (ctx: AudioContextLike) => readonly HostBuffer[] = () => [];

/** Sets where a context's host buffers come from. */
export function setHostBuffers(source: (ctx: AudioContextLike) => readonly HostBuffer[]): void {
  hostBuffersOf = source;
}

let requestSamples: (ctx: AudioContextLike, keys: string[]) => void = () => undefined;

/** Sets what decodes the pending samples a context's voices named (samples.ts). */
export function setSampleRequests(request: (ctx: AudioContextLike, keys: string[]) => void): void {
  requestSamples = request;
}

/** A replayer for a context the engine does not own (a render's offline context), with the host's sample buffers. */
export function replayerFor(ctx: AudioContextLike): Replayer {
  return new Replayer(ctx, () => hostBuffersOf(ctx));
}

/** The engine of a context, made on first use. */
export function backendOf(ctx: AudioContextLike): Backend {
  let backend = backends.get(ctx);
  if (!backend) {
    const destination = ctx.destination;
    const channels = destination.channelCount ?? 2;
    backend = {
      ctx,
      engine: new glue.WasmEngine(
        ctx.sampleRate,
        channels,
        Math.max(destination.maxChannelCount ?? 2, channels)
      ),
      replayer: replayerFor(ctx),
      channels
    };
    backends.set(ctx, backend);
  }
  return backend;
}

/**
 * Calls into a context's engine at the context's clock and replays what it recorded, also when the call throws. A replay that
 * throws (a context refusing a time, say) wins over the engine's own error, since 0.3 failed at that call first. Then the
 * pending samples the call's voices named are decoded on the context. With `undo`, a batch whose replay throws is also undone on
 * the context (the sources it made are cut, `Replayer.replay`) before the first error is thrown: a failed `play()` or first loop
 * window leaves nothing sounding (D-38), though the module had finished booking before the replay began.
 */
export function run<T>(
  backend: Backend,
  call: (engine: WasmEngine) => T,
  options: { undo?: boolean } = {}
): T {
  const { ctx, engine } = backend;
  const channels = ctx.destination.channelCount ?? 2;
  if (channels !== backend.channels) {
    engine.setDestinationChannels(channels);
    backend.channels = channels;
  }
  engine.setTime(ctx.currentTime);
  try {
    return call(engine);
  } finally {
    try {
      backend.replayer.replay(engine.take(), options);
    } finally {
      // The pending samples the call's voices named (they were skipped) start decoding now, as 0.3's lookup did.
      const keys = engine.takeRequestedSamples();
      if (keys.length > 0) requestSamples(ctx, keys);
    }
  }
}

/** The engine's number for an output node: `undefined` for the default, a node the engine made, or the host's own (adopted). */
export function nodeId(backend: Backend, node: AudioNodeLike | undefined): number | undefined {
  if (node === undefined) return undefined;
  const known = backend.replayer.idOf(node);
  if (known !== undefined) return known;
  const id = backend.engine.adopt();
  backend.replayer.adopt(id, node);
  return id;
}
