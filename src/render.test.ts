// Tests for offline rendering: sizing, booking order, seeding, samples and tail wrapping
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import { note, s, sound } from './control';
import { stack } from './pattern';
import { renderToBuffer } from './render';
import { clearSamples, registerSample } from './samples';
import { resetTempo } from './scheduler';
import { FakeOfflineAudioContext, fakeOfflineFactory } from './test-utils/fakeAudioContext';

afterEach(() => {
  clearSamples();
  resetTempo();
});

describe('renderToBuffer', () => {
  it('sizes the context from cycles, tempo, tail and sample rate', async () => {
    const context = fakeOfflineFactory();
    const buffer = await renderToBuffer(note('c3 e3'), {
      cycles: 2,
      cps: 1,
      tail: 0.5,
      sampleRate: 1000,
      context
    });
    expect(context.contexts[0].length).toBe(2500);
    expect(buffer.length).toBe(2500);
    expect(buffer.sampleRate).toBe(1000);
    expect(buffer.numberOfChannels).toBe(2);
  });

  it('renders seconds by dropping onsets at or after the end', async () => {
    const context = fakeOfflineFactory();
    await renderToBuffer(note('c3 e3 g3 b3'), { seconds: 0.5, cps: 1, sampleRate: 1000, context });
    const ctx = context.contexts[0];
    expect(ctx.length).toBe(500);
    expect(ctx.oscillators.map((o) => o.started[0])).toEqual([0, 0.25]);
  });

  it('rejects conflicting or invalid options', async () => {
    const context = fakeOfflineFactory();
    await expect(renderToBuffer(note('c3'), { cycles: 1, seconds: 1, context })).rejects.toThrow(
      'either cycles or seconds'
    );
    await expect(renderToBuffer(note('c3'), { bpm: 120, cps: 1, context })).rejects.toThrow(
      'either bpm or cps'
    );
    await expect(renderToBuffer(note('c3'), { cycles: 1.5, context })).rejects.toThrow('whole');
    await expect(
      renderToBuffer(note('c3'), { channels: 3 as unknown as 2, context })
    ).rejects.toThrow('channels must be');
  });

  it('rejects with a helpful error when there is no OfflineAudioContext', async () => {
    await expect(renderToBuffer(note('c3'))).rejects.toThrow('pass a `context` factory');
  });

  it('books every node before rendering starts, with the first onset at zero', async () => {
    const context = fakeOfflineFactory();
    await renderToBuffer(note('c3 e3'), { cps: 1, context });
    const ctx = context.contexts[0];
    expect(ctx.rendered).toBe(true);
    expect(ctx.nodeCountAtRender).toBeGreaterThan(0);
    expect(ctx.oscillators.map((o) => o.started[0])).toEqual([0, 0.5]);
  });

  it('routes through the master bus by default and skips it with master: false', async () => {
    const withMaster = fakeOfflineFactory();
    await renderToBuffer(note('c3'), { context: withMaster });
    expect(withMaster.contexts[0].compressors).toHaveLength(1);

    const raw = fakeOfflineFactory();
    await renderToBuffer(note('c3'), { master: false, context: raw });
    expect(raw.contexts[0].compressors).toHaveLength(0);
  });

  it('switches to discrete multichannel output and skips the limiter above stereo', async () => {
    const context = fakeOfflineFactory();
    await renderToBuffer(note('c3'), { channels: 6, context });
    const ctx = context.contexts[0];
    expect(ctx.destination.channelCount).toBe(6);
    expect(ctx.destination.channelInterpretation).toBe('discrete');
    expect(ctx.compressors).toHaveLength(0);
  });

  it('books in time order so cut groups choke across stacked layers', async () => {
    const context = fakeOfflineFactory();
    await renderToBuffer(
      stack(
        note('~ ~ c3 ~').release(2).cut(1),
        note('e3 ~ ~ ~').release(2).cut(1),
        note('~ g3 ~ ~').release(2).cut(1)
      ),
      { cps: 1, master: false, context }
    );
    const [first, second, third] = context.contexts[0].oscillators;
    expect(first.started[0]).toBe(0);
    expect(first.stopped.at(-1)).toBeCloseTo(0.255);
    expect(second.stopped.at(-1)).toBeCloseTo(0.505);
    expect(third.stopped).toHaveLength(1);
  });

  it('decodes registered samples on the offline context before booking', async () => {
    registerSample('kick', new ArrayBuffer(8));
    const context = fakeOfflineFactory();
    await renderToBuffer(s('kick'), { master: false, context });
    expect(context.contexts[0].bufferSources).toHaveLength(1);
    expect(context.contexts[0].bufferSources[0].started).toEqual([0]);
  });

  it('gives identical noise for the same seed and different noise for another', async () => {
    const noiseOf = async (seed: number) => {
      const context = fakeOfflineFactory();
      await renderToBuffer(sound('white'), { seed, master: false, context });
      const buffer = context.contexts[0].bufferSources[0].buffer;
      return Array.from(buffer!.getChannelData(0).slice(0, 16));
    };
    const a = await noiseOf(1);
    expect(await noiseOf(1)).toEqual(a);
    expect(await noiseOf(2)).not.toEqual(a);
  });

  it('folds the tail onto the start when wrap is set', async () => {
    const buffer = await renderToBuffer(note('c3'), {
      cps: 1,
      tail: 0.5,
      wrap: true,
      sampleRate: 100,
      master: false,
      context: (init) =>
        new FakeOfflineAudioContext({ ...init, fill: (_channel, data) => data.fill(1) })
    });
    const data = buffer.getChannelData(0);
    expect(buffer.length).toBe(100);
    expect(data[0]).toBe(2);
    expect(data[49]).toBe(2);
    expect(data[50]).toBe(1);
  });

  it('leaves the tail on the end when wrap is not set', async () => {
    const buffer = await renderToBuffer(note('c3'), {
      cps: 1,
      tail: 0.5,
      sampleRate: 100,
      master: false,
      context: (init) =>
        new FakeOfflineAudioContext({ ...init, fill: (_channel, data) => data.fill(1) })
    });
    expect(buffer.length).toBe(150);
    expect(buffer.getChannelData(0)[0]).toBe(1);
  });
});
