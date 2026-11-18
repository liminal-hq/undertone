// Tests for offline rendering: sizing, booking order, booking in windows, seeding, samples and tail wrapping
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, s, sound } from './control';
import { stack } from './pattern';
import { renderToBuffer } from './render';
import { clearSamples, registerSample } from './samples';
import { resetTempo } from './scheduler';
import { score } from './score';
import type { ScoreEvent } from './score';
import {
  FakeOfflineAudioContext,
  fakeOfflineFactory,
  recordedGraph
} from './test-utils/fakeAudioContext';
import type { FakeOfflineOptions } from './test-utils/fakeAudioContext';
import { resetWarnings } from './warn';

afterEach(() => {
  clearSamples();
  resetTempo();
  resetWarnings();
  vi.restoreAllMocks();
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

  it('keeps the folded tail under the master ceiling', async () => {
    const ceiling = -3;
    const level = 10 ** (ceiling / 20);
    const buffer = await renderToBuffer(note('c3'), {
      cps: 1,
      tail: 0.5,
      wrap: true,
      sampleRate: 100,
      master: { ceiling },
      // Each sample is under the ceiling alone; the first half of the pass has the tail folded onto it.
      context: (init) =>
        new FakeOfflineAudioContext({ ...init, fill: (_channel, data) => data.fill(0.7) })
    });
    expect(0.7).toBeLessThan(level);
    expect(buffer.length).toBe(100);
    const data = buffer.getChannelData(0);
    expect(Math.max(...Array.from(data).map(Math.abs))).toBeLessThanOrEqual(level);
    expect(data[0]).toBeGreaterThan(0.7); // clipped to the ceiling, not left at the 0.7 of the unfolded part
    expect(data[50]).toBeCloseTo(0.7, 5); // the unfolded part is untouched
  });

  it('leaves a folded tail alone when there is no ceiling', async () => {
    const buffer = await renderToBuffer(note('c3'), {
      cps: 1,
      tail: 0.5,
      wrap: true,
      sampleRate: 100,
      master: false,
      context: (init) =>
        new FakeOfflineAudioContext({ ...init, fill: (_channel, data) => data.fill(0.7) })
    });
    expect(buffer.getChannelData(0)[0]).toBeCloseTo(1.4, 5);
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

describe('render() shortcuts', () => {
  it('Pattern.render() renders the pattern', async () => {
    const context = fakeOfflineFactory();
    const buffer = await note('c3 e3').render({ cps: 1, sampleRate: 100, context });
    expect(buffer.length).toBe(100);
  });

  it('score().render() covers one pass at the score tempo', async () => {
    const context = fakeOfflineFactory();
    const cue = score({
      ticksPerSecond: 560,
      lengthTicks: 1120,
      events: [
        { tick: 0, note: 'e4', gate: 112 },
        { tick: 280, midi: 69, gate: 28 }
      ]
    });
    const buffer = await cue.render({ sampleRate: 100, master: false, context });
    expect(buffer.length).toBe(200);
    expect(context.contexts[0].oscillators.map((o) => o.started[0])).toEqual([0, 0.5]);
  });
});

/**
 * Six seconds of a busy cue at 100 ticks a second: FM notes, noise hats that choke each other,
 * room sends whose size changes on one orbit, a delay, a nudge that reorders booking, and a pan
 * path. Everything a window boundary could get wrong.
 */
function busyCue() {
  const events: ScoreEvent[] = [];
  for (let tick = 0; tick < 600; tick += 25) {
    events.push({
      tick,
      midi: 48 + ((tick / 25) % 12),
      gate: 40,
      level: 0.8,
      pan: ((tick / 25) % 5) / 2 - 1,
      voice: {
        soundType: 'sine',
        fmIndex: 2,
        sustain: 0.5,
        roomLevel: 0.3,
        roomSize: tick < 300 ? 2 : 6,
        delayLevel: tick % 100 === 0 ? 0.2 : undefined
      }
    });
    events.push({
      tick: tick + 12,
      note: 'c6',
      voice: { soundType: 'white', cutGroup: 1, release: 0.4, nudgeTime: tick === 200 ? -0.2 : 0 }
    });
  }
  events.push({
    tick: 150,
    note: 'a2',
    gate: 300,
    voice: { soundType: 'sawtooth', sustain: 0.7, roomLevel: 0.2, orbit: 1, roomSize: 4 },
    panPath: [
      { tick: 0, pan: -1 },
      { tick: 300, pan: 1 }
    ]
  });
  return score({ ticksPerSecond: 100, lengthTicks: 600, events });
}

// 1280 Hz makes a second exactly ten render quanta, so pause times stay round.
describe('booking in windows', () => {
  it('pauses a window ahead of each window and books only what is due by then', async () => {
    const context = fakeOfflineFactory();
    await busyCue().render({ sampleRate: 1280, tail: 1, bookingWindow: 1, context });
    const ctx = context.contexts[0];

    // Windows 0 and 1 are booked before the render; window k at a pause at the start of window k - 1.
    expect(ctx.suspensions.map((pause) => pause.time)).toEqual([1, 2, 3, 4]);
    for (const pause of ctx.suspensions) {
      // Everything booked by then starts before the next window ends, and nothing in it is missing.
      expect(Math.max(...pause.startsBooked)).toBeLessThan(pause.time + 1);
      const all = [...ctx.oscillators, ...ctx.bufferSources].map((node) => node.started[0]);
      expect(all.filter((start) => start < pause.time + 1)).toHaveLength(pause.startsBooked.length);
    }
    const counts = [ctx.nodeCountAtRender, ...ctx.suspensions.map((pause) => pause.nodeCount)];
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(ctx.nodeCountAtRender).toBeLessThan(ctx.nodeCount() / 2);
  });

  it('builds exactly the graph that booking up front builds', async () => {
    const upFront = fakeOfflineFactory();
    const windowed = fakeOfflineFactory();
    const cue = busyCue();

    await cue.render({ sampleRate: 1280, tail: 1, context: upFront });
    await cue.render({ sampleRate: 1280, tail: 1, bookingWindow: 0.5, context: windowed });

    expect(windowed.contexts[0].suspensions.length).toBeGreaterThan(5);
    expect(recordedGraph(windowed.contexts[0])).toEqual(recordedGraph(upFront.contexts[0]));
  });

  it("keeps each orbit's last booked room size, as booking up front does", async () => {
    const windowed = fakeOfflineFactory();
    await busyCue().render({ sampleRate: 1280, bookingWindow: 1, context: windowed });
    const upFront = fakeOfflineFactory();
    await busyCue().render({ sampleRate: 1280, context: upFront });

    // The size-6 room of the second half is the one heard throughout; the size-2 room is never built.
    const reverb = (ctx: FakeOfflineAudioContext) => ctx.convolvers[0].buffer;
    expect(reverb(windowed.contexts[0])?.length).toBe(reverb(upFront.contexts[0])?.length);
    expect(reverb(windowed.contexts[0])?.length).toBe(Math.round(1280 * (0.3 + (5 * 3.7) / 9)));
  });

  it('ignores a sample that is not available when it works out the last room size', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // An audible note sends to a size-2 room; a sample nobody registered, later on the same orbit, asks for size 8.
    const cue = () =>
      stack(note('c3 ~ ~ ~').room(0.5).roomsize(2), s('~ ~ ghost ~').room(0.5).roomsize(8));
    const upFront = fakeOfflineFactory();
    const windowed = fakeOfflineFactory();
    await renderToBuffer(cue(), { cps: 1, cycles: 4, sampleRate: 1280, context: upFront });
    await renderToBuffer(cue(), {
      cps: 1,
      cycles: 4,
      sampleRate: 1280,
      bookingWindow: 0.5,
      context: windowed
    });

    expect(windowed.contexts[0].suspensions.length).toBeGreaterThan(0);
    const reverb = (ctx: FakeOfflineAudioContext) => ctx.convolvers[0].buffer;
    expect(reverb(upFront.contexts[0])?.length).toBe(Math.round(1280 * (0.3 + (1 * 3.7) / 9)));
    expect(reverb(windowed.contexts[0])?.length).toBe(reverb(upFront.contexts[0])?.length);
    expect(recordedGraph(windowed.contexts[0])).toEqual(recordedGraph(upFront.contexts[0]));
  });

  // Each case below must give the graph that booking up front gives: the windowed path books the same effective voices.
  const equivalentCases: Record<string, { cue: () => ReturnType<typeof stack>; channels?: 4 }> = {
    'cut groups choking across windows': {
      cue: () => stack(note('c3 e3').release(2).cut(1), note('~ g3').release(2).cut(1)).slow(0.25)
    },
    'a cut group a missing sample does not claim': {
      cue: () =>
        stack(note('c3 ~ ~ ~').release(2).cut(1), s('~ ghost ~ ~').cut(1), note('~ ~ e3 ~').cut(1))
    },
    'late and early nudges that reorder voices': {
      cue: () =>
        stack(note('c3 e3 g3 b3').nudge('0 -0.6 0.9 0'), note('~ c4 ~ ~').nudge(1.4).cut(2))
    },
    'noise voices that share a start time': {
      cue: () => stack(sound('white pink'), sound('white brown').release(0.3)).slow(0.25)
    },
    'delay sends with different times on one orbit': {
      cue: () =>
        stack(
          note('c3 ~ e3 ~').delay(0.4).delaytime(0.1).delayfeedback(0.3),
          note('~ g3 ~ b3').delay(0.4).delaytime(0.25).delayfeedback(0.5)
        )
    },
    'room sends on separate orbits': {
      cue: () =>
        stack(
          note('c3 e3').room(0.4).roomsize(3).orbit(0),
          note('g3 b3').room(0.4).roomsize(7).orbit(1),
          note('c4 ~').room(0.4).roomsize(2).orbit(0)
        ).slow(0.5)
    },
    'surround placement folded to four channels': {
      channels: 4,
      cue: () => stack(note('c3 e3 g3 b3').surround(45), note('~ c4 ~ ~').channels([1, 0, 0, 1]))
    }
  };
  for (const [name, { cue, channels }] of Object.entries(equivalentCases)) {
    it(`books ${name} as booking up front does`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const upFront = fakeOfflineFactory();
      const windowed = fakeOfflineFactory();
      const options = { cps: 1, cycles: 4, sampleRate: 1280, tail: 1, channels } as const;
      await renderToBuffer(cue(), { ...options, context: upFront });
      await renderToBuffer(cue(), { ...options, bookingWindow: 0.5, context: windowed });
      expect(windowed.contexts[0].suspensions.length).toBeGreaterThan(3);
      expect(recordedGraph(windowed.contexts[0])).toEqual(recordedGraph(upFront.contexts[0]));
    });
  }

  it('books a voice nudged past the end at the last pause, which the context accepts', async () => {
    const context = fakeOfflineFactory();
    const cue = score({
      ticksPerSecond: 100,
      lengthTicks: 400,
      events: [
        { tick: 0, note: 'c3' },
        { tick: 350, note: 'e3', voice: { nudgeTime: 2 } }
      ]
    });
    await cue.render({ sampleRate: 1280, bookingWindow: 1, context });
    const ctx = context.contexts[0];
    expect(ctx.suspensions.map((pause) => pause.time)).toEqual([3]);
    expect(ctx.oscillators.map((o) => o.started[0])).toEqual([0, 5.5]);
  });

  it('books everything up front, warning once, on a context that cannot pause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plain = fakeOfflineFactory();
    const noSuspend = (init: FakeOfflineOptions) =>
      plain({ ...init, noSuspend: true }) as FakeOfflineAudioContext;
    const upFront = fakeOfflineFactory();

    await busyCue().render({ sampleRate: 1280, bookingWindow: 1, context: noSuspend });
    await busyCue().render({ sampleRate: 1280, bookingWindow: 1, context: noSuspend });
    await busyCue().render({ sampleRate: 1280, context: upFront });

    const ctx = plain.contexts[0];
    expect(ctx.suspensions).toEqual([]);
    expect(ctx.nodeCountAtRender).toBe(ctx.nodeCount());
    expect(recordedGraph(ctx)).toEqual(recordedGraph(upFront.contexts[0]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('bookingWindow is ignored');
  });

  it('rejects a window that is not positive or shorter than two render quanta', async () => {
    const context = fakeOfflineFactory();
    await expect(note('c3').render({ bookingWindow: 0, context })).rejects.toThrow(
      'bookingWindow must be positive'
    );
    await expect(note('c3').render({ bookingWindow: Number.NaN, context })).rejects.toThrow(
      'bookingWindow must be positive'
    );
    await expect(
      note('c3').render({ bookingWindow: 0.005, sampleRate: 48000, context })
    ).rejects.toThrow('at least 256 frames');
    expect(context.contexts).toHaveLength(0);
  });

  it('rejects the render when the context refuses a pause', async () => {
    class Refusing extends FakeOfflineAudioContext {
      override suspend(): Promise<void> {
        return Promise.reject(new Error('no pause for you'));
      }
    }
    await expect(
      busyCue().render({
        sampleRate: 1280,
        bookingWindow: 1,
        context: (init) => new Refusing(init)
      })
    ).rejects.toThrow('no pause for you');
  });

  it('leaves the default render booking everything up front', async () => {
    const context = fakeOfflineFactory();
    await busyCue().render({ sampleRate: 1280, context });
    const ctx = context.contexts[0];
    expect(ctx.suspensions).toEqual([]);
    expect(ctx.nodeCountAtRender).toBe(ctx.nodeCount());
  });
});
