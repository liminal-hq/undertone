// Tests for pan automation inside a note: the booked pan calls, an early stop, and pan paths in scores
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { getOrbitBus } from './effects';
import { playParams, playVoice, resolveParams } from './engine';
import { Fraction } from './fraction';
import { score } from './score';
import { FakeAudioContext } from './test-utils/fakeAudioContext';

describe('panPath', () => {
  it('books the first point at the onset, ramps to each later point and steps on a shared time', () => {
    const ctx = new FakeAudioContext();

    playVoice(
      ctx,
      resolveParams({
        pitch: 'a4',
        pan: 0.5,
        panPath: [
          { time: 0, pan: -1 },
          { time: 0.5, pan: 1 },
          { time: 0.5, pan: -0.25 },
          { time: 0.75, pan: 0 }
        ]
      }),
      2
    );

    expect(ctx.panners).toHaveLength(1);
    expect(ctx.panners[0].pan.calls).toEqual([
      { method: 'setValueAtTime', value: -1, time: 2 },
      { method: 'linearRampToValueAtTime', value: 1, time: 2.5 },
      { method: 'setValueAtTime', value: -0.25, time: 2.5 },
      { method: 'linearRampToValueAtTime', value: 0, time: 2.75 }
    ]);
  });

  it('creates the panner without pan, and connects it as the plain pan does', () => {
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ pitch: 'a4', panPath: [{ time: 0, pan: 0.3 }] }), 0);

    const panner = ctx.panners[0];
    expect(ctx.gains[0].connectedTo).toEqual([panner]);
    expect(panner.connectedTo).toEqual([ctx.destination]);
    expect(panner.pan.calls).toEqual([{ method: 'setValueAtTime', value: 0.3, time: 0 }]);
  });

  it('holds a later first point from the onset, clamps pans and keeps times running forwards', () => {
    const ctx = new FakeAudioContext();

    playVoice(
      ctx,
      resolveParams({
        pitch: 'a4',
        nudgeTime: 0.1,
        panPath: [
          { time: 0.2, pan: -3 },
          { time: 0.1, pan: 2 },
          { time: 0.4, pan: 0.5 }
        ]
      }),
      1
    );

    expect(ctx.panners[0].pan.calls).toEqual([
      { method: 'setValueAtTime', value: -1, time: 1.1 },
      { method: 'setValueAtTime', value: -1, time: expect.closeTo(1.3, 10) },
      // Earlier than the point before it, so it is a step at that point's time.
      { method: 'setValueAtTime', value: 1, time: expect.closeTo(1.3, 10) },
      { method: 'linearRampToValueAtTime', value: 0.5, time: expect.closeTo(1.5, 10) }
    ]);
  });

  it('leaves the plain pan alone without a path, and treats an empty path as none', () => {
    const ctx = new FakeAudioContext();

    playVoice(ctx, resolveParams({ pitch: 'a4', pan: -0.4, panPath: [] }), 1);
    playVoice(ctx, resolveParams({ pitch: 'a4', panPath: [] }), 1);

    expect(ctx.panners).toHaveLength(1);
    expect(ctx.panners[0].pan.calls).toEqual([{ method: 'setValueAtTime', value: -0.4, time: 1 }]);
  });

  it('is ignored when channelGains is set', () => {
    const ctx = new FakeAudioContext();

    playVoice(
      ctx,
      resolveParams({ pitch: 'a4', channelGains: [1, 0], panPath: [{ time: 0, pan: 1 }] }),
      0
    );

    expect(ctx.panners).toHaveLength(0);
    expect(ctx.mergers).toHaveLength(1);
  });

  it('sends the room and delay from the moving panner', () => {
    const ctx = new FakeAudioContext();

    playVoice(
      ctx,
      resolveParams({
        pitch: 'a4',
        roomLevel: 0.4,
        delayLevel: 0.2,
        panPath: [
          { time: 0, pan: -1 },
          { time: 0.1, pan: 1 }
        ]
      }),
      0
    );

    const bus = getOrbitBus(ctx, 0);
    const panner = ctx.panners[0];
    const sends = panner.connectedTo.slice(1) as typeof ctx.gains;
    expect(panner.connectedTo[0]).toBe(ctx.destination);
    expect(sends.map((send) => send.connectedTo)).toEqual([[bus.reverbInput], [bus.delayInput]]);
  });

  it('holds the value reached mid-ramp when the voice is stopped early', () => {
    const ctx = new FakeAudioContext();
    const handle = playVoice(
      ctx,
      resolveParams({
        pitch: 'a4',
        sustain: 1,
        duration: 2,
        panPath: [
          { time: 0, pan: -1 },
          { time: 1, pan: 1 },
          { time: 1.5, pan: 0 }
        ]
      }),
      0
    );

    handle.stop(0.25);

    expect(ctx.panners[0].pan.calls.slice(3)).toEqual([
      { method: 'cancelScheduledValues', time: 0.25 },
      { method: 'linearRampToValueAtTime', value: -0.5, time: 0.25 }
    ]);
  });

  it('holds the value before a step when the voice is stopped on it', () => {
    const ctx = new FakeAudioContext();
    const handle = playVoice(
      ctx,
      resolveParams({
        pitch: 'a4',
        sustain: 1,
        duration: 2,
        panPath: [
          { time: 0, pan: -1 },
          { time: 0.5, pan: -1 },
          { time: 0.5, pan: 1 }
        ]
      }),
      0
    );

    handle.stop(0.5);

    expect(ctx.panners[0].pan.calls.slice(3)).toEqual([
      { method: 'cancelScheduledValues', time: 0.5 },
      { method: 'linearRampToValueAtTime', value: -1, time: 0.5 }
    ]);
  });

  it('holds a step value when stopped between two steps', () => {
    const ctx = new FakeAudioContext();
    const handle = playVoice(
      ctx,
      resolveParams({
        pitch: 'a4',
        sustain: 1,
        duration: 2,
        panPath: [
          { time: 0, pan: -1 },
          { time: 0, pan: 0.5 },
          { time: 1, pan: 0.5 },
          { time: 1, pan: -0.5 }
        ]
      }),
      0
    );

    handle.stop(0.6);

    expect(ctx.panners[0].pan.calls.slice(4)).toEqual([
      { method: 'cancelScheduledValues', time: 0.6 },
      { method: 'linearRampToValueAtTime', value: 0.5, time: 0.6 }
    ]);
  });

  it('leaves a finished path, an unstarted voice and a plain pan alone on stop', () => {
    const ctx = new FakeAudioContext();
    const path = [
      { time: 0, pan: -1 },
      { time: 0.1, pan: 1 }
    ];
    const finished = playVoice(
      ctx,
      resolveParams({ pitch: 'a4', sustain: 1, duration: 1, panPath: path }),
      0
    );
    const later = playVoice(ctx, resolveParams({ pitch: 'a4', panPath: path }), 5);
    const plain = playVoice(ctx, resolveParams({ pitch: 'a4', pan: 0.2 }), 0);

    finished.stop(0.5);
    later.stop(1);
    plain.stop(0.05);

    expect(ctx.panners.map((panner) => panner.pan.calls.length)).toEqual([2, 2, 1]);
  });

  it('plays from plain data through playParams', () => {
    const ctx = new FakeAudioContext();

    playParams(
      ctx,
      [
        {
          pitch: 'a4',
          panPath: [
            { time: 0, pan: 1 },
            { time: 0.2, pan: -1 }
          ]
        }
      ],
      {
        when: 3
      }
    );

    expect(ctx.panners[0].pan.calls).toEqual([
      { method: 'setValueAtTime', value: 1, time: 3 },
      { method: 'linearRampToValueAtTime', value: -1, time: 3.2 }
    ]);
  });
});

describe('score panPath', () => {
  const FIRST_CYCLE = { begin: new Fraction(0), end: new Fraction(1) };

  it('carries a pan path in ticks from the onset into seconds, replacing the plain pan', () => {
    const ctx = new FakeAudioContext();
    const cue = score({
      ticksPerSecond: 100,
      lengthTicks: 400,
      events: [
        {
          tick: 100,
          note: 'a4',
          gate: 200,
          pan: 0.9,
          panPath: [
            { tick: 0, pan: -1 },
            { tick: 50, pan: 1 },
            { tick: 50, pan: -2 }
          ],
          voice: { sustain: 1 }
        }
      ]
    });

    const [hap] = cue.pattern.query(FIRST_CYCLE);
    expect(hap.value.panPath).toEqual([
      { time: 0, pan: -1 },
      { time: 0.5, pan: 1 },
      { time: 0.5, pan: -1 }
    ]);

    cue.play({ ctx, when: 0 });

    expect(ctx.panners[0].pan.calls).toEqual([
      { method: 'setValueAtTime', value: -1, time: 1 },
      { method: 'linearRampToValueAtTime', value: 1, time: 1.5 },
      { method: 'setValueAtTime', value: -1, time: 1.5 }
    ]);
  });

  it('leaves events without a path as they were', () => {
    const [hap] = score({
      ticksPerSecond: 100,
      lengthTicks: 100,
      events: [{ tick: 0, note: 'a4', pan: 0.2, panPath: [] }]
    }).pattern.query(FIRST_CYCLE);

    expect(hap.value.panPath).toBeUndefined();
    expect(hap.value.pan).toBe(0.2);
  });

  it('rejects fractional, negative or backwards ticks and pans that are not numbers', () => {
    const at = (panPath: { tick: number; pan: number }[]) => () =>
      score({ ticksPerSecond: 100, lengthTicks: 100, events: [{ tick: 0, note: 'a4', panPath }] });

    expect(at([{ tick: 0.5, pan: 0 }])).toThrow(/panPath tick must be an integer/);
    expect(at([{ tick: -1, pan: 0 }])).toThrow(/panPath tick must be an integer/);
    expect(
      at([
        { tick: 10, pan: 0 },
        { tick: 5, pan: 0 }
      ])
    ).toThrow(/must not go backwards/);
    expect(at([{ tick: 0, pan: Number.NaN }])).toThrow(/pan must be a number/);
  });
});
