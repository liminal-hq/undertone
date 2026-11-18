// Hand-written fake Web Audio nodes/context used by the test suite
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type {
  AudioBufferLike,
  AudioContextLike,
  AudioDestinationNodeLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  ChannelMergerNodeLike,
  ConvolverNodeLike,
  DelayNodeLike,
  DynamicsCompressorNodeLike,
  GainNodeLike,
  OfflineAudioContextLike,
  OscillatorNodeLike,
  PeriodicWaveLike,
  RenderedAudioBufferLike,
  StereoPannerNodeLike,
  AudioBufferSourceNodeLike
} from '../types';

export type AutomationCall =
  | { method: 'setValueAtTime'; value: number; time: number }
  | { method: 'linearRampToValueAtTime'; value: number; time: number }
  | { method: 'exponentialRampToValueAtTime'; value: number; time: number }
  | { method: 'cancelScheduledValues'; time: number }
  | { method: 'setTargetAtTime'; value: number; time: number; timeConstant: number };

/** A fake AudioParam that records every automation call for test assertions. */
export class FakeAudioParam implements AudioParamLike {
  value = 0;
  readonly calls: AutomationCall[] = [];

  setValueAtTime(value: number, time: number): this {
    this.value = value;
    this.calls.push({ method: 'setValueAtTime', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.calls.push({ method: 'linearRampToValueAtTime', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.calls.push({ method: 'exponentialRampToValueAtTime', value, time });
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.calls.push({ method: 'cancelScheduledValues', time });
    return this;
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    this.value = value;
    this.calls.push({ method: 'setTargetAtTime', value, time, timeConstant });
    return this;
  }
}

class FakeNode implements AudioNodeLike {
  connectedTo: (AudioNodeLike | AudioParamLike)[] = [];
  /** Full connect() records, including merger input indices. Destination may be a node or a param (e.g. the phaser LFO -> a filter's frequency). */
  connections: { node: AudioNodeLike | AudioParamLike; output: number; input: number }[] = [];

  disconnectCount = 0;

  connect(destination: AudioNodeLike | AudioParamLike, output = 0, input = 0): void {
    this.connectedTo.push(destination);
    this.connections.push({ node: destination, output, input });
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

export class FakeOscillatorNode extends FakeNode implements OscillatorNodeLike {
  type: OscillatorNodeLike['type'] = 'sine';
  frequency = new FakeAudioParam();
  /** The wave last passed to setPeriodicWave(), if any. A real node's `type` becomes "custom" then. */
  periodicWave: PeriodicWaveLike | undefined;
  started: number[] = [];
  stopped: number[] = [];

  setPeriodicWave(wave: PeriodicWaveLike): void {
    this.periodicWave = wave;
    this.type = 'custom';
  }

  start(when = 0): void {
    this.started.push(when);
  }

  stop(when = 0): void {
    this.stopped.push(when);
  }
}

export class FakeGainNode extends FakeNode implements GainNodeLike {
  gain = new FakeAudioParam();
}

export class FakeBiquadFilterNode extends FakeNode implements BiquadFilterNodeLike {
  type = 'lowpass';
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
}

export class FakeStereoPannerNode extends FakeNode implements StereoPannerNodeLike {
  pan = new FakeAudioParam();
}

export class FakeChannelMergerNode extends FakeNode implements ChannelMergerNodeLike {
  constructor(readonly numberOfInputs: number) {
    super();
  }
}

export class FakeConvolverNode extends FakeNode implements ConvolverNodeLike {
  private current: AudioBufferLike | null = null;
  /** Each impulse response the convolver was given, with the context's time when it was. */
  readonly bufferHistory: { time: number; buffer: AudioBufferLike | null }[] = [];

  constructor(private readonly clock: () => number = () => 0) {
    super();
  }

  get buffer(): AudioBufferLike | null {
    return this.current;
  }

  set buffer(buffer: AudioBufferLike | null) {
    this.current = buffer;
    this.bufferHistory.push({ time: this.clock(), buffer });
  }
}

export class FakeDelayNode extends FakeNode implements DelayNodeLike {
  delayTime = new FakeAudioParam();
}

/** A recorded createPeriodicWave() result. */
export class FakePeriodicWave {
  constructor(
    readonly real: Float32Array,
    readonly imag: Float32Array,
    readonly constraints: { disableNormalization?: boolean } | undefined
  ) {}
}

export class FakeDynamicsCompressorNode extends FakeNode implements DynamicsCompressorNodeLike {
  threshold = new FakeAudioParam();
  knee = new FakeAudioParam();
  ratio = new FakeAudioParam();
  attack = new FakeAudioParam();
  release = new FakeAudioParam();
}

export class FakeAudioDestinationNode extends FakeNode implements AudioDestinationNodeLike {
  maxChannelCount = 2;
  channelCount = 2;
  channelInterpretation = 'speakers';
}

export class FakeAudioBufferSourceNode extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  playbackRate = new FakeAudioParam();
  started: number[] = [];
  stopped: number[] = [];

  start(when = 0): void {
    this.started.push(when);
  }

  stop(when = 0): void {
    this.stopped.push(when);
  }
}

class FakeAudioBuffer implements RenderedAudioBufferLike {
  /** One independent array per channel — a per-channel reverb IR needs its channels to actually differ. */
  private readonly channels: Float32Array[];
  readonly numberOfChannels: number;

  constructor(
    numChannels: number,
    readonly length: number,
    readonly sampleRate = 44100
  ) {
    this.numberOfChannels = Math.max(numChannels, 1);
    this.channels = Array.from({ length: this.numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

/** A minimal fake AudioContext, structurally compatible with AudioContextLike, that
 * records every node it creates so engine.test.ts can assert on the resulting graph. */
export class FakeAudioContext implements AudioContextLike {
  /**
   * `bareParams` mimics a hand-written wrapper context (such as a game's
   * "route everything into my own bus" proxy) around params that predate the
   * optional cancelScheduledValues/setTargetAtTime — used to prove the engine
   * still works, falling back gracefully, on such contexts.
   */
  constructor(
    private readonly options: {
      bareParams?: boolean;
      noPeriodicWave?: boolean;
      noCompressor?: boolean;
    } = {}
  ) {
    if (options.noCompressor) {
      (this as { createDynamicsCompressor?: unknown }).createDynamicsCompressor = undefined;
    }
    if (options.noPeriodicWave) {
      // A wrapper context from before shaped waveforms: the method simply is not there.
      (this as { createPeriodicWave?: unknown }).createPeriodicWave = undefined;
    }
  }

  private bare<T extends { gain?: FakeAudioParam; frequency?: FakeAudioParam }>(
    node: T,
    key: 'gain' | 'frequency'
  ): T {
    const param = node[key] as unknown as Record<string, unknown> | undefined;
    if (this.options.bareParams && param) {
      param.cancelScheduledValues = undefined;
      param.setTargetAtTime = undefined;
    }
    return node;
  }

  currentTime = 0;
  sampleRate = 44100;
  destination = new FakeAudioDestinationNode();

  readonly oscillators: FakeOscillatorNode[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly filters: FakeBiquadFilterNode[] = [];
  readonly panners: FakeStereoPannerNode[] = [];
  readonly mergers: FakeChannelMergerNode[] = [];
  readonly bufferSources: FakeAudioBufferSourceNode[] = [];
  readonly convolvers: FakeConvolverNode[] = [];
  readonly delays: FakeDelayNode[] = [];
  readonly periodicWaves: FakePeriodicWave[] = [];
  readonly compressors: FakeDynamicsCompressorNode[] = [];

  createOscillator(): FakeOscillatorNode {
    const node = this.bare(new FakeOscillatorNode(), 'frequency');
    this.oscillators.push(node);
    return node;
  }

  createGain(): FakeGainNode {
    const node = this.bare(new FakeGainNode(), 'gain');
    this.gains.push(node);
    return node;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    const node = new FakeBiquadFilterNode();
    this.filters.push(node);
    return node;
  }

  createStereoPanner(): FakeStereoPannerNode {
    const node = new FakeStereoPannerNode();
    this.panners.push(node);
    return node;
  }

  createChannelMerger(numberOfInputs: number): FakeChannelMergerNode {
    const node = new FakeChannelMergerNode(numberOfInputs);
    this.mergers.push(node);
    return node;
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    const node = new FakeAudioBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }

  createConvolver(): FakeConvolverNode {
    const node = new FakeConvolverNode(() => this.currentTime);
    this.convolvers.push(node);
    return node;
  }

  createDelay(): FakeDelayNode {
    const node = new FakeDelayNode();
    this.delays.push(node);
    return node;
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    const node = new FakeDynamicsCompressorNode();
    this.compressors.push(node);
    return node;
  }

  createPeriodicWave(
    real: Float32Array,
    imag: Float32Array,
    constraints?: { disableNormalization?: boolean }
  ): FakePeriodicWave {
    const wave = new FakePeriodicWave(real, imag, constraints);
    this.periodicWaves.push(wave);
    return wave;
  }

  createBuffer(numChannels: number, length: number, sampleRate?: number): AudioBufferLike {
    return new FakeAudioBuffer(numChannels, length, sampleRate);
  }

  /** Decodes to a silent mono buffer sized from the input — tests assert on registration/routing, not on decoded audio content. */
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    return Promise.resolve(new FakeAudioBuffer(1, Math.max(data.byteLength, 1)));
  }
}

export interface FakeOfflineOptions {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  /** Fills each rendered channel; the default leaves silence. */
  fill?: (channel: number, data: Float32Array) => void;
  /** Leaves out `suspend()` and `resume()`, like an offline context that cannot pause a render. */
  noSuspend?: boolean;
}

/** Frames in a render quantum: `suspend()` times are rounded down to a multiple of this. */
const RENDER_QUANTUM_FRAMES = 128;

/** What the fake saw at one pause of its render. */
export interface FakeSuspension {
  /** The pause's time on the context's clock, after quantizing. */
  time: number;
  /** Nodes created before the pause, so before anything booked at it. */
  nodeCount: number;
  /** The start time of every oscillator and buffer source created before the pause. */
  startsBooked: number[];
}

/**
 * A fake OfflineAudioContext: records nodes like FakeAudioContext, then "renders" a buffer on demand.
 * Its `suspend()` pauses the render at a quantum boundary, sets `currentTime` there, records what had
 * been booked in `suspensions`, and waits for `resume()`, as a real offline context does.
 */
export class FakeOfflineAudioContext extends FakeAudioContext implements OfflineAudioContextLike {
  readonly length: number;
  readonly numberOfChannels: number;
  /** Total nodes created before startRendering() was called. */
  nodeCountAtRender = -1;
  rendered = false;
  /** Every pause the render made, in time order. */
  readonly suspensions: FakeSuspension[] = [];
  private readonly pauses: { frame: number; resolve: () => void }[] = [];
  private renderedFrame = -1;
  private resumeRender: (() => void) | undefined;

  constructor(private readonly offline: FakeOfflineOptions) {
    super();
    this.sampleRate = offline.sampleRate;
    this.length = offline.length;
    this.numberOfChannels = offline.numberOfChannels;
    this.destination.channelCount = offline.numberOfChannels;
    this.destination.maxChannelCount = offline.numberOfChannels;
    if (offline.noSuspend) {
      (this as { suspend?: unknown }).suspend = undefined;
      (this as { resume?: unknown }).resume = undefined;
    }
  }

  suspend(suspendTime: number): Promise<void> {
    const frame =
      Math.floor((suspendTime * this.sampleRate) / RENDER_QUANTUM_FRAMES) * RENDER_QUANTUM_FRAMES;
    if (!(suspendTime >= 0) || frame >= this.length) {
      return Promise.reject(new Error(`cannot suspend at ${suspendTime}: outside the render`));
    }
    if (frame <= this.renderedFrame || this.pauses.some((pause) => pause.frame === frame)) {
      return Promise.reject(new Error(`cannot suspend at ${suspendTime}: frame ${frame} is taken`));
    }
    return new Promise((resolve) => this.pauses.push({ frame, resolve }));
  }

  resume(): Promise<void> {
    const resumeRender = this.resumeRender;
    this.resumeRender = undefined;
    resumeRender?.();
    return Promise.resolve();
  }

  nodeCount(): number {
    return (
      this.oscillators.length +
      this.gains.length +
      this.filters.length +
      this.panners.length +
      this.mergers.length +
      this.bufferSources.length +
      this.convolvers.length +
      this.delays.length +
      this.compressors.length
    );
  }

  async startRendering(): Promise<RenderedAudioBufferLike> {
    this.nodeCountAtRender = this.nodeCount();
    this.pauses.sort((a, b) => a.frame - b.frame);
    for (let pause = this.pauses.shift(); pause; pause = this.pauses.shift()) {
      this.renderedFrame = pause.frame;
      this.currentTime = pause.frame / this.sampleRate;
      this.suspensions.push({
        time: this.currentTime,
        nodeCount: this.nodeCount(),
        startsBooked: [...this.oscillators, ...this.bufferSources].map((node) => node.started[0])
      });
      const resumed = new Promise<void>((resolve) => (this.resumeRender = resolve));
      pause.resolve();
      await resumed;
    }
    this.rendered = true;
    const buffer = new FakeAudioBuffer(this.numberOfChannels, this.length, this.sampleRate);
    for (let c = 0; c < this.numberOfChannels; c++) {
      this.offline.fill?.(c, buffer.getChannelData(c));
    }
    return buffer;
  }
}

/** A factory producing FakeOfflineAudioContexts, collecting each one created in `contexts`. */
export function fakeOfflineFactory(spy?: (ctx: FakeOfflineAudioContext) => void): {
  (opts: FakeOfflineOptions): FakeOfflineAudioContext;
  contexts: FakeOfflineAudioContext[];
} {
  const contexts: FakeOfflineAudioContext[] = [];
  const factory = (opts: FakeOfflineOptions): FakeOfflineAudioContext => {
    const ctx = new FakeOfflineAudioContext(opts);
    contexts.push(ctx);
    spy?.(ctx);
    return ctx;
  };
  factory.contexts = contexts;
  return factory;
}

/**
 * Every node a fake context made, as plain data a test can compare with `toEqual`: per kind in
 * creation order, each node's settings, automation calls, starts and stops, buffers, and
 * connections (named `<kind><index>`, `destination`, or `<node>.<param>` for a param).
 */
export function recordedGraph(ctx: FakeAudioContext): Record<string, unknown[]> {
  const kinds = {
    oscillator: ctx.oscillators,
    gain: ctx.gains,
    filter: ctx.filters,
    panner: ctx.panners,
    merger: ctx.mergers,
    bufferSource: ctx.bufferSources,
    convolver: ctx.convolvers,
    delay: ctx.delays,
    compressor: ctx.compressors
  } as const;
  const names = new Map<unknown, string>([[ctx.destination, 'destination']]);
  for (const [kind, nodes] of Object.entries(kinds)) {
    (nodes as readonly object[]).forEach((node, index) => {
      names.set(node, `${kind}${index}`);
      for (const [key, value] of Object.entries(node)) {
        if (value instanceof FakeAudioParam) {
          names.set(value, `${kind}${index}.${key}`);
        }
      }
    });
  }
  const plain = (value: unknown): unknown => {
    if (value instanceof FakeAudioParam) {
      return value.calls;
    }
    if (value instanceof FakeAudioBuffer) {
      return Array.from({ length: value.numberOfChannels }, (_, c) =>
        Array.from(value.getChannelData(c))
      );
    }
    if (value instanceof FakePeriodicWave) {
      return [Array.from(value.real), Array.from(value.imag), value.constraints];
    }
    return value;
  };
  const graph: Record<string, unknown[]> = {};
  for (const [kind, nodes] of Object.entries(kinds)) {
    graph[kind] = (nodes as readonly FakeNode[]).map((node) => {
      const record: Record<string, unknown> = {};
      if (node instanceof FakeConvolverNode) {
        // What is heard from each time on: the last impulse response given at that time. The
        // first is heard from whenever the convolver was made, before which nothing reaches it.
        const heard = new Map<number | 'first', unknown>();
        const first = node.bufferHistory[0]?.time;
        for (const { time, buffer } of node.bufferHistory) {
          heard.set(time === first ? 'first' : time, plain(buffer));
        }
        record.buffers = [...heard];
      }
      for (const [key, value] of Object.entries(node)) {
        if (
          key === 'connectedTo' ||
          key === 'current' ||
          key === 'bufferHistory' ||
          typeof value === 'function'
        ) {
          continue;
        }
        record[key] =
          key === 'connections'
            ? (value as FakeNode['connections']).map((c) => ({ ...c, node: names.get(c.node) }))
            : plain(value);
      }
      return record;
    });
  }
  return graph;
}
