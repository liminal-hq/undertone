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
  buffer: AudioBufferLike | null = null;
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
    const node = new FakeConvolverNode();
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
}

/** A fake OfflineAudioContext: records nodes like FakeAudioContext, then "renders" a buffer on demand. */
export class FakeOfflineAudioContext extends FakeAudioContext implements OfflineAudioContextLike {
  readonly length: number;
  readonly numberOfChannels: number;
  /** Total nodes created before startRendering() was called. */
  nodeCountAtRender = -1;
  rendered = false;

  constructor(private readonly offline: FakeOfflineOptions) {
    super();
    this.sampleRate = offline.sampleRate;
    this.length = offline.length;
    this.numberOfChannels = offline.numberOfChannels;
    this.destination.channelCount = offline.numberOfChannels;
    this.destination.maxChannelCount = offline.numberOfChannels;
  }

  private nodeCount(): number {
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

  startRendering(): Promise<RenderedAudioBufferLike> {
    this.nodeCountAtRender = this.nodeCount();
    this.rendered = true;
    const buffer = new FakeAudioBuffer(this.numberOfChannels, this.length, this.sampleRate);
    for (let c = 0; c < this.numberOfChannels; c++) {
      this.offline.fill?.(c, buffer.getChannelData(c));
    }
    return Promise.resolve(buffer);
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
