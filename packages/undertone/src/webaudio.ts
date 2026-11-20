// The Web Audio backend: replays the engine's recorded calls onto the caller's context, one engine per context
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The engine books on a recorder (docs/rust-migration/results/M6-BOUNDARY.md, section 12): every Web Audio call becomes a
// record of six numbers, `[op, a, b, c, d, e]`, which the `Replayer` below turns back into the one call the TypeScript engine
// made, in the same order, so the context numbers its nodes as 0.3 did. `run()` replays after every call into the engine, a
// call that throws included (the nodes a failing voice made before the failure stay on the context, and a failed play's
// rollback, D-38, is recorded too). The replayer forgets what the engine releases, so a long session stays bounded.
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
  channels: readonly Float32Array[];
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

  /** Replays `[records, data]`, as `take()` returns them. */
  replay(taken: unknown[]): void {
    const ops = taken[0] as Float64Array;
    const data = taken[1] as Float32Array;
    const names = this.#names;
    const ctx = this.#ctx as unknown as Record<string, (...args: unknown[]) => unknown>;
    let previous = '';
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
          const missing = this.#missingWaves.get(b);
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
          break;
        case 'stop':
          (this.node<AnyNode>(a).stop as (when: number) => void)(hard ? Math.min(b, hard.at) : b);
          break;
        case 'createBuffer':
          this.#buffers.set(
            a,
            this.#hostBuffer(b, c, data, e) ?? this.#newBuffer(b, c, d, data, e)
          );
          break;
        case 'createCurve':
          this.#buffers.set(a, data.slice(c, c + b));
          break;
        case 'createWave': {
          const real = data.slice(c, c + b);
          if (typeof ctx.createPeriodicWave !== 'function') {
            // An autopan LFO is given its oscillator type just before its wave; a shaped wave is not.
            this.#missingWaves.set(a, { autopan: previous === 'oscillatorType', real });
            break;
          }
          const imag = data.slice(c + b, c + 2 * b);
          // The TypeScript engine passes no constraints unless normalisation is off.
          this.#waves.set(
            a,
            d === 0
              ? ctx.createPeriodicWave.call(ctx, real, imag)
              : ctx.createPeriodicWave.call(ctx, real, imag, { disableNormalization: true })
          );
          break;
        }
        case 'release': {
          const node = this.#nodes.get(a);
          if (node !== undefined) this.#ids.delete(node);
          this.#nodes.delete(a);
          break;
        }
        case 'releaseBuffer':
          this.#claimed.delete(this.#buffers.get(a) as AudioBufferLike);
          this.#buffers.delete(a);
          break;
        default:
          throw new Error(`replay: unknown op ${op}`);
      }
      previous = name;
    }
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
    data: Float32Array,
    offset: number
  ): AudioBufferLike | undefined {
    for (const host of this.#hostBuffers()) {
      if (this.#claimed.has(host.buffer)) continue;
      if (host.channels.length !== channels || host.channels[0].length !== length) continue;
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

/** The shaped waves' real parts, read once from a throwaway engine, to name the wave a context could not make. */
let shapes: { type: string; real: Float32Array }[] | undefined;

function shapeOf(real: Float32Array): string {
  shapes ??= (glue.shapedWaveTypes() as string[]).map((type) => {
    const engine = new glue.WasmEngine(44100, 2, 2);
    try {
      engine.playVoice({ soundType: type }, 0, undefined).free();
      const [ops, data] = engine.take() as [Float64Array, Float32Array];
      const createWave = (graphNames as GraphNames).ops.indexOf('createWave');
      for (let at = 0; at < ops.length; at += WIDTH) {
        if (ops[at] === createWave) {
          return { type, real: data.slice(ops[at + 3], ops[at + 3] + ops[at + 2]) };
        }
      }
      return { type, real: new Float32Array() };
    } finally {
      engine.free();
    }
  });
  const found = shapes.find(
    (shape) => shape.real.length === real.length && shape.real.every((x, i) => x === real[i])
  );
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
 * throws (a context refusing a time, say) wins over the engine's own error, since 0.3 failed at that call first.
 */
export function run<T>(backend: Backend, call: (engine: WasmEngine) => T): T {
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
    backend.replayer.replay(engine.take());
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
