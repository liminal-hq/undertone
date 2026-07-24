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
  GainNodeLike,
  OscillatorNodeLike,
  StereoPannerNodeLike,
  AudioBufferSourceNodeLike
} from '../types';

export type AutomationCall =
  | { method: 'setValueAtTime'; value: number; time: number }
  | { method: 'linearRampToValueAtTime'; value: number; time: number }
  | { method: 'exponentialRampToValueAtTime'; value: number; time: number };

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
}

class FakeNode implements AudioNodeLike {
  connectedTo: AudioNodeLike[] = [];
  /** Full connect() records, including merger input indices. */
  connections: { node: AudioNodeLike; output: number; input: number }[] = [];

  connect(destination: AudioNodeLike, output = 0, input = 0): AudioNodeLike {
    this.connectedTo.push(destination);
    this.connections.push({ node: destination, output, input });
    return destination;
  }
}

export class FakeOscillatorNode extends FakeNode implements OscillatorNodeLike {
  type: OscillatorNodeLike['type'] = 'sine';
  frequency = new FakeAudioParam();
  started: number[] = [];
  stopped: number[] = [];

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

export class FakeAudioDestinationNode extends FakeNode implements AudioDestinationNodeLike {
  maxChannelCount = 2;
  channelCount = 2;
  channelInterpretation = 'speakers';
}

export class FakeAudioBufferSourceNode extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  started: number[] = [];
  stopped: number[] = [];

  start(when = 0): void {
    this.started.push(when);
  }

  stop(when = 0): void {
    this.stopped.push(when);
  }
}

class FakeAudioBuffer implements AudioBufferLike {
  private readonly channel: Float32Array;

  constructor(length: number) {
    this.channel = new Float32Array(length);
  }

  getChannelData(): Float32Array {
    return this.channel;
  }
}

/** A minimal fake AudioContext, structurally compatible with AudioContextLike, that
 * records every node it creates so engine.test.ts can assert on the resulting graph. */
export class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  sampleRate = 44100;
  destination = new FakeAudioDestinationNode();

  readonly oscillators: FakeOscillatorNode[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly filters: FakeBiquadFilterNode[] = [];
  readonly panners: FakeStereoPannerNode[] = [];
  readonly mergers: FakeChannelMergerNode[] = [];
  readonly bufferSources: FakeAudioBufferSourceNode[] = [];

  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
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

  createBuffer(_numChannels: number, length: number): AudioBufferLike {
    return new FakeAudioBuffer(length);
  }
}
