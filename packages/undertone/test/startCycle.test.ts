// Tests for the internal `startCycle` option of the render's voice collection: a pass that starts at a later cycle of the pattern
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// `startCycle` is not part of the package's public `RenderOptions` type: the worklet's loop passes it so that it goes on from cycle
// to cycle as `loop()` does. These tests send it through `renderToBuffer` the way a JavaScript caller (or that loop) would, to
// hold the main module's reading of it, with exact results: the offline render of cycle N of an alternating pattern is the
// render of the note that cycle plays.

import { describe, expect, it } from 'vitest';
import { note, renderToBuffer } from '@liminal-hq/undertone';
import type { RenderOptions } from '@liminal-hq/undertone';

const base = { sampleRate: 8000, bpm: 240, seed: 'start' };
const from = (startCycle: number, extra: object = {}) =>
  ({ ...base, startCycle, ...extra }) as RenderOptions;

async function channel(pattern: ReturnType<typeof note>, options: RenderOptions) {
  return (await renderToBuffer(pattern, options)).getChannelData(0);
}

describe('startCycle', () => {
  const alternating = () => note('<c3 e3 g3>').sound('triangle').decay(0.05);

  it('renders the cycles from that cycle on: cycle 1 of an alternation is what that cycle plays, bit for bit', async () => {
    const first = await channel(alternating(), from(0));
    const second = await channel(alternating(), from(1));
    expect(first.some((sample) => Math.abs(sample) > 0.01)).toBe(true);
    expect(second).not.toEqual(first);
    expect(second).toEqual(await channel(note('e3').sound('triangle').decay(0.05), from(0)));
    expect(await channel(alternating(), from(2))).toEqual(
      await channel(note('g3').sound('triangle').decay(0.05), from(0))
    );
    // The alternation comes round: cycle 3 is cycle 0, and so is cycle 3,000,000.
    expect(await channel(alternating(), from(3))).toEqual(first);
    expect(await channel(alternating(), from(3_000_000))).toEqual(first);
  });

  it('holds several cycles from the start cycle, with times counted from the first of them', async () => {
    const two = from(1, { cycles: 2 });
    const rendered = await channel(alternating(), two);
    const e3g3 = await channel(note('e3 g3').sound('triangle').decay(0.05), {
      ...base,
      bpm: 120
    });
    // Two cycles of "<c3 e3 g3>" from cycle 1 are e3 then g3: the onsets of "e3 g3" over one cycle of half the tempo.
    expect(rendered).toHaveLength(16000);
    expect(rendered).toEqual(e3g3);
  });

  it('is nothing at 0 or when it is left out', async () => {
    const plain = await channel(alternating(), { ...base } as RenderOptions);
    expect(await channel(alternating(), from(0))).toEqual(plain);
  });

  it('refuses a start cycle that is not a whole number from 0', async () => {
    await expect(renderToBuffer(alternating(), from(1.5))).rejects.toThrow(
      /startCycle must be a whole number from 0 to 9007199254740992, got 1\.5/
    );
    await expect(renderToBuffer(alternating(), from(-1))).rejects.toThrow(
      /startCycle must be a whole number/
    );
  });
});
