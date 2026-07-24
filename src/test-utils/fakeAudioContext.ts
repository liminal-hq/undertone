// Hand-written fake Web Audio nodes/context used by the test suite
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
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

  connect(destination: AudioNodeLike): AudioNodeLike {
    this.connectedTo.push(destination);
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
  destination: AudioNodeLike = new FakeNode();

  readonly oscillators: FakeOscillatorNode[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly filters: FakeBiquadFilterNode[] = [];
  readonly panners: FakeStereoPannerNode[] = [];
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

  createBufferSource(): FakeAudioBufferSourceNode {
    const node = new FakeAudioBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }

  createBuffer(_numChannels: number, length: number): AudioBufferLike {
    return new FakeAudioBuffer(length);
  }
}
