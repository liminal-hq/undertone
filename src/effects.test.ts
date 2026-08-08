// Unit tests for the per-orbit reverb/delay buses and the impulse-response generator
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildImpulseResponse, getOrbitBus } from './effects';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

function averageAbs(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    sum += Math.abs(data[i]);
  }
  return sum / (to - from);
}

describe('buildImpulseResponse', () => {
  it('sizes the buffer to seconds * sampleRate', () => {
    const ctx = new FakeAudioContext();
    const buffer = buildImpulseResponse(ctx, 0.5);
    expect(buffer.getChannelData(0).length).toBe(0.5 * ctx.sampleRate);
  });

  it('is a two-channel buffer with decorrelated (independently-random) content', () => {
    const ctx = new FakeAudioContext();
    const buffer = buildImpulseResponse(ctx, 0.1);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    expect(left).not.toEqual(right);
  });

  it('decays: later samples average a much smaller magnitude than earlier ones', () => {
    const ctx = new FakeAudioContext();
    const data = buildImpulseResponse(ctx, 1).getChannelData(0);
    const length = data.length;
    const startAvg = averageAbs(data, 0, Math.floor(length * 0.05));
    const endAvg = averageAbs(data, Math.floor(length * 0.8), length);
    expect(endAvg).toBeLessThan(startAvg * 0.2);
  });

  it('never exceeds full scale', () => {
    const ctx = new FakeAudioContext();
    const data = buildImpulseResponse(ctx, 0.2).getChannelData(0);
    for (const sample of data) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(1);
    }
  });
});

describe('getOrbitBus', () => {
  it('lazily creates a convolver and delay line, wired to the destination', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    expect(ctx.convolvers).toHaveLength(1);
    expect(ctx.delays).toHaveLength(1);
    expect(bus.reverbInput.connectedTo).toEqual([ctx.convolvers[0]]);
    expect(ctx.convolvers[0].connectedTo).toEqual([ctx.destination]);
  });

  it('wires the delay line with a feedback loop back into itself', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);
    const delay = ctx.delays[0];

    expect(bus.delayInput.connectedTo).toEqual([delay]);
    // delay -> output gain -> destination, and delay -> feedback gain -> delay
    expect(delay.connectedTo).toHaveLength(2);
    const [toOutput, toFeedback] = delay.connectedTo;
    expect((toOutput as { connectedTo: unknown[] }).connectedTo).toEqual([ctx.destination]);
    expect((toFeedback as { connectedTo: unknown[] }).connectedTo).toEqual([delay]);
  });

  it('returns the same bus for the same (ctx, orbit) pair, without rebuilding nodes', () => {
    const ctx = new FakeAudioContext();
    const first = getOrbitBus(ctx, 2);
    const second = getOrbitBus(ctx, 2);

    expect(second).toBe(first);
    expect(ctx.convolvers).toHaveLength(1);
  });

  it('gives distinct orbit numbers on the same context their own buses', () => {
    const ctx = new FakeAudioContext();
    const busA = getOrbitBus(ctx, 0);
    const busB = getOrbitBus(ctx, 1);

    expect(busA).not.toBe(busB);
    expect(ctx.convolvers).toHaveLength(2);
  });

  it('keeps buses isolated per context', () => {
    const ctxA = new FakeAudioContext();
    const ctxB = new FakeAudioContext();

    getOrbitBus(ctxA, 0);
    getOrbitBus(ctxB, 0);

    expect(ctxA.convolvers).toHaveLength(1);
    expect(ctxB.convolvers).toHaveLength(1);
    expect(ctxA.convolvers[0]).not.toBe(ctxB.convolvers[0]);
  });
});

describe('OrbitBus.setRoomSize', () => {
  it('assigns an impulse response to the convolver on first use', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    bus.setRoomSize(3);

    expect(ctx.convolvers[0].buffer).not.toBeNull();
  });

  it('skips regenerating the impulse response when the size is unchanged (last-writer-wins per orbit)', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    bus.setRoomSize(3);
    const firstBuffer = ctx.convolvers[0].buffer;
    bus.setRoomSize(3);

    expect(ctx.convolvers[0].buffer).toBe(firstBuffer);
  });

  it('regenerates when a later voice on the same orbit sets a different size', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    bus.setRoomSize(3);
    const firstBuffer = ctx.convolvers[0].buffer;
    bus.setRoomSize(8);

    expect(ctx.convolvers[0].buffer).not.toBe(firstBuffer);
  });

  it('floors the impulse response length instead of going degenerate for a tiny or non-positive size', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    for (const size of [0.1, 0, -5]) {
      bus.setRoomSize(size);
      const length = ctx.convolvers[0].buffer!.getChannelData(0).length;
      // The documented range floors at ~0.3s — well above a degenerate 1-sample buffer.
      expect(length).toBeGreaterThan(0.1 * ctx.sampleRate);
    }
  });
});

describe('OrbitBus.setDelay', () => {
  it('sets delayTime and feedback gain on first use', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    bus.setDelay(0.3, 0.35);

    const delay = ctx.delays[0];
    expect(delay.delayTime.calls).toEqual([{ method: 'setValueAtTime', value: 0.3, time: 0 }]);
    // gains[0..2] are reverbInput/delayInput/delayOutput; gains[3] is the feedback loop's gain.
    expect(ctx.gains[3].gain.calls).toEqual([{ method: 'setValueAtTime', value: 0.35, time: 0 }]);
  });

  it('skips redundant automation calls when time and feedback are unchanged', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    bus.setDelay(0.3, 0.35);
    bus.setDelay(0.3, 0.35);

    expect(ctx.delays[0].delayTime.calls).toHaveLength(1);
  });

  it('re-applies only the value that actually changed', () => {
    const ctx = new FakeAudioContext();
    const bus = getOrbitBus(ctx, 0);

    bus.setDelay(0.3, 0.35);
    bus.setDelay(0.5, 0.35);

    expect(ctx.delays[0].delayTime.calls).toHaveLength(2);
  });
});
