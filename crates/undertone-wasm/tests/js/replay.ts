// A test replayer: turns the engine's recorded Web Audio calls back into AudioContextLike calls, as RF-26's will
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// This is NOT the bridge's Web Audio backend (RF-26 writes packages/undertone/src/webaudio.ts). It is the smallest replayer that
// proves the record format (docs/rust-migration/results/M6-BOUNDARY.md, section 12): every record of `[op, a, b, c, d, e]` becomes
// the one call the TypeScript engine makes, in the same order, on any AudioContextLike (here the repository's fake context, which
// conformance/recorder/graph.ts describes). The names behind the numbers come from the module (`graphNames()`), not from a table here.

/** The names behind a record's numbers, as `graphNames()` gives them. */
export interface GraphNames {
  ops: string[];
  kinds: string[];
  params: string[];
  oscillatorTypes: string[];
  filterTypes: string[];
  oversample: string[];
  channelCountModes: string[];
  channelInterpretations: string[];
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
  setTargetAtTime(value: number, time: number, timeConstant: number): void;
  cancelScheduledValues(time: number): void;
};

/** Replays records on one context; keeps the nodes, buffers, and waves the records name. */
export class Replayer {
  readonly nodes = new Map<number, AnyNode>();
  private readonly buffers = new Map<number, unknown>();
  private readonly waves = new Map<number, unknown>();
  /** How many records were replayed, for the tests that count them. */
  records = 0;

  /** How many nodes and buffers the replayer still holds (a long session must keep these bounded). */
  get held(): number {
    return this.nodes.size + this.buffers.size;
  }

  constructor(
    private readonly ctx: Record<string, unknown> & { destination: unknown },
    private readonly names: GraphNames,
    /** A negative control: every `setValueAtTime` value moved by a relative 1e-9, so a comparison must fail. */
    private readonly perturb = false
  ) {
    this.nodes.set(0, ctx.destination as AnyNode);
  }

  /** Maps a number the engine gave with `adopt()` to a node of the host's own. */
  adopt(id: number, node: unknown): void {
    this.nodes.set(id, node as AnyNode);
  }

  private node(id: number): AnyNode {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`replay: no node ${id}`);
    return node;
  }

  private param(id: number, code: number): Param {
    return this.node(id)[this.names.params[code]] as Param;
  }

  /** Replays `[records, data]`, as `engine.take()` returns them. */
  replay([ops, data]: [Float64Array, Float32Array]): void {
    const { names, ctx } = this;
    const create = ctx as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (let at = 0; at < ops.length; at += WIDTH) {
      const [op, a, b, c, d, e] = ops.subarray(at, at + WIDTH);
      this.records += 1;
      switch (names.ops[op]) {
        case 'create': {
          const kind = names.kinds[b];
          // Only a merger and a delay take an argument, as the TypeScript engine calls them.
          const node =
            kind === 'ChannelMerger' || kind === 'Delay'
              ? create[`create${kind}`].call(ctx, c)
              : create[`create${kind}`].call(ctx);
          this.nodes.set(a, node as AnyNode);
          break;
        }
        case 'set':
          this.param(a, b).setValueAtTime(this.perturb ? c * (1 + 1e-9) + 1e-9 : c, d);
          break;
        case 'linear':
          this.param(a, b).linearRampToValueAtTime(c, d);
          break;
        case 'exponential':
          this.param(a, b).exponentialRampToValueAtTime(c, d);
          break;
        case 'target':
          this.param(a, b).setTargetAtTime(c, d, e);
          break;
        case 'cancel':
          this.param(a, b).cancelScheduledValues(c);
          break;
        case 'oscillatorType':
          this.node(a).type = names.oscillatorTypes[b];
          break;
        case 'periodicWave':
          (this.node(a).setPeriodicWave as (wave: unknown) => void)(this.waves.get(b));
          break;
        case 'filterType':
          this.node(a).type = names.filterTypes[b];
          break;
        case 'buffer':
          this.node(a).buffer = b < 0 ? null : this.buffers.get(b);
          break;
        case 'loop':
          this.node(a).loop = b !== 0;
          break;
        case 'curve':
          this.node(a).curve = b < 0 ? null : this.buffers.get(b);
          break;
        case 'oversample':
          this.node(a).oversample = names.oversample[b];
          break;
        case 'channelCount':
          this.node(a).channelCount = b;
          break;
        case 'channelCountMode':
          this.node(a).channelCountMode = names.channelCountModes[b];
          break;
        case 'channelInterpretation':
          this.node(a).channelInterpretation = names.channelInterpretations[b];
          break;
        case 'connect': {
          const target = c < 0 ? this.node(b) : this.param(b, c);
          if (d === 0 && e === 0) this.node(a).connect(target);
          else this.node(a).connect(target, d, e);
          break;
        }
        case 'disconnect':
          this.node(a).disconnect();
          break;
        case 'start':
          (this.node(a).start as (when: number) => void)(b);
          break;
        case 'stop':
          (this.node(a).stop as (when: number) => void)(b);
          break;
        case 'createBuffer': {
          const buffer = create.createBuffer.call(ctx, b, c, d) as {
            getChannelData(channel: number): Float32Array;
          };
          for (let channel = 0; channel < b; channel += 1) {
            buffer
              .getChannelData(channel)
              .set(data.subarray(e + channel * c, e + (channel + 1) * c));
          }
          this.buffers.set(a, buffer);
          break;
        }
        case 'createCurve':
          this.buffers.set(a, data.slice(c, c + b));
          break;
        case 'createWave': {
          const real = data.slice(c, c + b);
          const imag = data.slice(c + b, c + 2 * b);
          // The TypeScript engine passes no constraints unless normalisation is off.
          const wave =
            d === 0
              ? create.createPeriodicWave.call(ctx, real, imag)
              : create.createPeriodicWave.call(ctx, real, imag, { disableNormalization: true });
          this.waves.set(a, wave);
          break;
        }
        case 'release':
          this.nodes.delete(a);
          break;
        case 'releaseBuffer':
          this.buffers.delete(a);
          break;
        default:
          throw new Error(`replay: unknown op ${op}`);
      }
    }
  }
}
