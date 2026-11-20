// Tests for the opt-in pan law: the unchanged default, the side gains, pan paths, stops and precedence (ported from src/panLaw.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Fraction, note, resolveParams, score } from '@liminal-hq/undertone';
import type { ControlPatch } from '@liminal-hq/undertone';
import { playVoice } from '@liminal-hq/undertone/testing';
import { FakeAudioContext, recordedGraph } from '../../../src/test-utils/fakeAudioContext';

/** The graph one voice builds on a fresh fake context. */
function graphOf(patch: ControlPatch, start = 0) {
  const ctx = new FakeAudioContext();
  const handle = playVoice(ctx, resolveParams(patch), start);
  return { ctx, handle, graph: recordedGraph(ctx) };
}

const values = (param: { calls: unknown[] }) =>
  (param.calls as { value: number }[]).map((call) => call.value);

describe('panLaw', () => {
  it('leaves the stereo panner graph unchanged when unset or -3', () => {
    const plain = { pitch: 'a4', pan: 0.3, delayLevel: 0.2 } as const;
    expect(graphOf({ ...plain, panLaw: -3 }).graph).toEqual(graphOf(plain).graph);
    const path = {
      pitch: 'a4',
      panPath: [
        { time: 0, pan: -1 },
        { time: 1, pan: 1 }
      ]
    };
    expect(graphOf({ ...path, panLaw: -3 }).graph).toEqual(graphOf(path).graph);
    // A law that is not a number is no law.
    expect(graphOf({ ...plain, panLaw: Number.NaN }).graph).toEqual(graphOf(plain).graph);
  });

  it('changes nothing for a voice with no pan', () => {
    expect(graphOf({ pitch: 'a4', panLaw: 0 }).graph).toEqual(graphOf({ pitch: 'a4' }).graph);
  });

  it('places a panned voice with one gain per side into a two-input merger', () => {
    const { ctx } = graphOf({ pitch: 'a4', pan: -0.5, panLaw: -4.5, roomLevel: 0.3 }, 1);

    expect(ctx.panners).toHaveLength(0);
    const [merger] = ctx.mergers;
    expect(merger.numberOfInputs).toBe(2);
    const envelope = ctx.gains[0];
    const [left, right] = ctx.gains.slice(1, 3);
    expect(envelope.connectedTo).toEqual([left, right]);
    expect(left.connections).toEqual([{ node: merger, output: 0, input: 0 }]);
    expect(right.connections).toEqual([{ node: merger, output: 0, input: 1 }]);
    expect(merger.connectedTo[0]).toBe(ctx.destination);
    // The room send is taken after the placement, so the wet signal is placed too.
    const send = merger.connectedTo[1] as (typeof ctx.gains)[number];
    expect(ctx.gains).toContain(send);
    expect(values(send.gain)).toEqual([0.3]);
    const expected = { left: 0.7782700963138817, right: 0.32237002908262474 }; // the -4.5 dB law at pan -0.5
    expect(left.gain.calls).toEqual([{ method: 'setValueAtTime', value: expected.left, time: 1 }]);
    expect(right.gain.calls).toEqual([
      { method: 'setValueAtTime', value: expected.right, time: 1 }
    ]);
  });

  it('clamps a law outside -6..0 in plain voice data', () => {
    const { ctx } = graphOf({ pitch: 'a4', pan: 0, panLaw: -12 });
    expect(values(ctx.gains[1].gain)[0]).toBeCloseTo(10 ** (-6 / 20), 12);
    const loud = graphOf({ pitch: 'a4', pan: 0, panLaw: 3 });
    expect(values(loud.ctx.gains[1].gain)[0]).toBe(1);
  });

  it('books a pan path as side gain ramps that follow the law', () => {
    const { ctx } = graphOf(
      {
        pitch: 'a4',
        panLaw: 0,
        panPath: [
          { time: 0, pan: -1 },
          { time: 1, pan: 1 },
          { time: 1, pan: 0 }
        ]
      },
      2
    );
    const [left, right] = ctx.gains.slice(1, 3);
    for (const side of [left, right]) {
      const calls = side.gain.calls as { method: string; value: number; time: number }[];
      expect(calls[0].method).toBe('setValueAtTime');
      expect(calls[0].time).toBe(2);
      // A full sweep is 64 ramps of 1/32 of a pan, two more breaks at the knees, then the jump to the centre.
      expect(calls.filter((call) => call.method === 'linearRampToValueAtTime')).toHaveLength(66);
      expect(calls.at(-2)?.time).toBe(3);
      expect(calls.at(-1)).toMatchObject({ method: 'setValueAtTime', time: 3 });
    }
    expect(values(left.gain)[0]).toBe(1);
    expect(values(left.gain).at(-2)).toBeCloseTo(0, 12);
    expect(values(left.gain).at(-1)).toBe(1); // 0 dB law: the centre is full on both sides
    expect(values(right.gain).at(-1)).toBe(1);
  });

  it('holds both side gains where the path had got to when the voice stops early', () => {
    const { ctx, handle } = graphOf(
      {
        pitch: 'a4',
        sustain: 1,
        duration: 2,
        panLaw: -6,
        panPath: [
          { time: 0, pan: -1 },
          { time: 2, pan: 1 }
        ]
      },
      0
    );
    handle.stop(1);
    const [left, right] = ctx.gains.slice(1, 3);
    for (const [side, key] of [
      [left, 'left'],
      [right, 'right']
    ] as const) {
      const calls = side.gain.calls as { method: string; value?: number; time: number }[];
      const cancel = calls.findIndex((call) => call.method === 'cancelScheduledValues');
      expect(calls[cancel]).toEqual({ method: 'cancelScheduledValues', time: 1 });
      expect(calls[cancel + 1]).toMatchObject({ method: 'linearRampToValueAtTime', time: 1 });
      expect(calls[cancel + 1].value).toBeCloseTo(
        { left: 0.5011872336272722, right: 0.5011872336272722 }[key],
        4
      );
      expect(calls).toHaveLength(cancel + 2);
    }
  });

  it('lets channelGains take precedence over the law', () => {
    const plain = { pitch: 'a4', pan: 0.5, channelGains: [0.2, 0.9] };
    expect(graphOf({ ...plain, panLaw: 0 }).graph).toEqual(graphOf(plain).graph);
    const withPath = {
      ...plain,
      panPath: [
        { time: 0, pan: -1 },
        { time: 1, pan: 1 }
      ]
    };
    expect(graphOf({ ...withPath, panLaw: -6 }).graph).toEqual(graphOf(withPath).graph);
    expect(graphOf({ ...withPath, panLaw: -6 }).ctx.mergers[0].numberOfInputs).toBe(2);
    expect(graphOf({ ...withPath, panLaw: -6 }).ctx.gains[1].gain.calls).toEqual([
      { method: 'setValueAtTime', value: 0.2, time: 0 }
    ]);
  });

  it('is set by panlaw() on a pattern, which checks its range', () => {
    const ctx = new FakeAudioContext();
    note('a4').pan(1).panlaw(-6).play({ ctx, when: 0 });
    expect(ctx.mergers).toHaveLength(1);
    expect(values(ctx.gains[2].gain)).toEqual([0.7087857830839414]); // the -6 dB law's right gain at pan 1;
    expect(() => note('a4').panlaw(1)).toThrow('panlaw() must be between -6 and 0 dB, got 1');
    expect(() => note('a4').panlaw(Number.NaN)).toThrow('panlaw()');
  });

  it('is given to every score event by the definition, unless the event sets its own', () => {
    const cue = score({
      ticksPerSecond: 100,
      lengthTicks: 100,
      panLaw: 0,
      events: [
        { tick: 0, note: 'c4', pan: 0 },
        { tick: 50, note: 'e4', pan: 0, voice: { panLaw: -6 } }
      ]
    });
    const laws = cue.pattern
      .query({ begin: new Fraction(0), end: new Fraction(1) })
      .map((hap) => hap.value.panLaw);
    expect(laws).toEqual([0, -6]);
    expect(() => score({ ticksPerSecond: 100, lengthTicks: 100, panLaw: -7, events: [] })).toThrow(
      'score() panLaw must be between -6 and 0 dB, got -7'
    );
  });
});
