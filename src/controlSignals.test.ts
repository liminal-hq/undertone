// Tests for patternable controls: a number, a string or a pattern (a signal) gives every control its value
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { note } from './control';
import { Fraction } from './fraction';
import { Pattern, arrange, cat, hasOnset, pure, seq, stack, timecat } from './pattern';
import { mini } from './mini';
import { loopPattern } from './scheduler';
import type { TimerLike } from './scheduler';
import { saw, saw2, signal, sine, sine2 } from './signal';
import { FakeAudioContext, recordedGraph } from './test-utils/fakeAudioContext';
import type { ControlPatch } from './types';
import { resetWarnings } from './warn';

type Control = (
  pat: Pattern<ControlPatch>,
  input: number | string | Pattern<number>
) => Pattern<ControlPatch>;

/** Every control that takes a number, a string or a pattern, with a value each accepts. */
const PATTERNABLE: [string, Control, number][] = [
  ['attack', (p, x) => p.attack(x), 0.01],
  ['decay', (p, x) => p.decay(x), 0.2],
  ['sustain', (p, x) => p.sustain(x), 0.5],
  ['release', (p, x) => p.release(x), 0.3],
  ['gain', (p, x) => p.gain(x), 0.4],
  ['lpf', (p, x) => p.lpf(x), 900],
  ['lpenv', (p, x) => p.lpenv(x), 2000],
  ['lpa', (p, x) => p.lpa(x), 0.01],
  ['lpd', (p, x) => p.lpd(x), 0.2],
  ['lps', (p, x) => p.lps(x), 0.3],
  ['lpr', (p, x) => p.lpr(x), 0.2],
  ['hpf', (p, x) => p.hpf(x), 300],
  ['phaser', (p, x) => p.phaser(x), 1.5],
  ['room', (p, x) => p.room(x), 0.3],
  ['roomsize', (p, x) => p.roomsize(x), 4],
  ['delay', (p, x) => p.delay(x), 0.25],
  ['delaytime', (p, x) => p.delaytime(x), 0.3],
  ['delayfeedback', (p, x) => p.delayfeedback(x), 0.4],
  ['slide', (p, x) => p.slide(x), 0.1],
  ['fm', (p, x) => p.fm(x), 2],
  ['fmi', (p, x) => p.fmi(x), 2],
  ['fmh', (p, x) => p.fmh(x), 3.5],
  ['fmattack', (p, x) => p.fmattack(x), 0.02],
  ['fmdecay', (p, x) => p.fmdecay(x), 0.2],
  ['fmsustain', (p, x) => p.fmsustain(x), 0.4],
  ['fmrelease', (p, x) => p.fmrelease(x), 0.2],
  ['penv', (p, x) => p.penv(x), 7],
  ['pattack', (p, x) => p.pattack(x), 0.01],
  ['pdecay', (p, x) => p.pdecay(x), 0.2],
  ['nudge', (p, x) => p.nudge(x), 0.02],
  ['late', (p, x) => p.late(x), 0.02],
  ['early', (p, x) => p.early(x), 0.02],
  ['duration', (p, x) => p.duration(x), 0.1],
  ['legato', (p, x) => p.legato(x), 0.5],
  ['velocity', (p, x) => p.velocity(x), 0.6],
  ['pan', (p, x) => p.pan(x), -0.5],
  ['panslide', (p, x) => p.panslide(x), 0.5],
  ['autopan', (p, x) => p.autopan(x), 2],
  ['autopandepth', (p, x) => p.autopandepth(x), 0.5],
  ['autopanphase', (p, x) => p.autopanphase(x), 0.25]
];

const sin2 = (t: number) => Math.sin(2 * Math.PI * t);

/** A control's values at the onsets of the first cycle, in time order. */
function onsets(pat: Pattern<ControlPatch>, cycle = 0): ControlPatch[] {
  return pat
    .query({ begin: new Fraction(cycle), end: new Fraction(cycle + 1) })
    .filter(hasOnset)
    .sort((a, b) => a.part.begin.cmp(b.part.begin))
    .map((hap) => hap.value);
}

function graphOf(pat: Pattern<ControlPatch>) {
  const ctx = new FakeAudioContext();
  pat.play({ ctx, when: 0, bpm: 240 });
  const graph = recordedGraph(ctx);
  // A reverb's impulse response is fresh noise for every context, so it is not compared.
  graph.convolver = graph.convolver.map((node) => ({ ...(node as object), buffers: [] }));
  return graph;
}

class FakeTimer implements TimerLike {
  callback: (() => void) | undefined;
  setInterval(callback: () => void): unknown {
    this.callback = callback;
    return 'handle';
  }
  clearInterval(): void {}
}

beforeEach(() => {
  resetWarnings();
});

describe('every patternable control', () => {
  it.each(PATTERNABLE)(
    '%s: a number, its string and pure(number) give the same events and the same graph',
    (_name, apply, x) => {
      const base = note('c4*4 e4');
      const fromNumber = apply(base, x);
      const fromString = apply(base, String(x));
      const fromPure = apply(base, pure(x));
      const query = { begin: new Fraction(0), end: new Fraction(2) };

      expect(fromPure.query(query)).toEqual(fromNumber.query(query));
      expect(fromString.query(query)).toEqual(fromNumber.query(query));
      expect(graphOf(fromPure)).toEqual(graphOf(fromNumber));
      expect(graphOf(fromString)).toEqual(graphOf(fromNumber));
    }
  );

  it.each(PATTERNABLE)('%s: a signal sets the control on every event', (_name, apply, x) => {
    const events = onsets(
      apply(
        note('c4*4'),
        signal(() => x)
      )
    );
    const reference = onsets(apply(note('c4*4'), x));

    expect(events).toEqual(reference);
  });
});

describe('a signal as a control value', () => {
  it('books the sine at each onset on the panner', () => {
    const ctx = new FakeAudioContext();

    note('c4*4').pan(sine2).play({ ctx, when: 0, bpm: 240 });

    const calls = ctx.panners.map((panner) => panner.pan.calls);
    expect(calls).toHaveLength(4);
    const expected = [0, 1, 0, -1];
    calls.forEach((list, index) => {
      expect(list).toHaveLength(1);
      expect(list[0].method).toBe('setValueAtTime');
      expect(list[0].value).toBeCloseTo(expected[index], 9);
    });
  });

  it('reads the whole of a signal at an onset, not the part of a fragment of it', () => {
    const query = { begin: new Fraction(1, 8), end: new Fraction(3, 8) };

    const values = note('c4*4')
      .pan(sine2)
      .query(query)
      .map((hap) => hap.value.pan);

    expect(values[0]).toBeCloseTo(0, 9); // the event begun at 0, cut by the query
    expect(values[1]).toBeCloseTo(1, 9); // the event begun at ¼
  });

  it('never changes the structure: the events are the left side’s', () => {
    const plain = note('c4(3,8)').query({ begin: new Fraction(0), end: new Fraction(2) });
    const panned = note('c4(3,8)')
      .pan(sine2)
      .query({ begin: new Fraction(0), end: new Fraction(2) });

    expect(panned.map(({ whole, part }) => ({ whole, part }))).toEqual(
      plain.map(({ whole, part }) => ({ whole, part }))
    );
  });

  it('books identical pans however the loop cuts time into windows', () => {
    const run = (stepSeconds: number) => {
      const ctx = new FakeAudioContext();
      const timer = new FakeTimer();
      loopPattern(note('c4*8').pan(sine2.slow(3)).lpf(saw.range(200, 2000)), {
        ctx,
        timer,
        bpm: 240
      });
      for (let i = 0; i < 80; i += 1) {
        ctx.currentTime += stepSeconds;
        timer.callback?.();
      }
      return ctx.oscillators.map((osc, index) => ({
        start: osc.started[0],
        pan: ctx.panners[index].pan.calls,
        cutoff: ctx.filters[index].frequency.calls
      }));
    };

    const fine = run(0.05);
    const coarse = run(0.31);
    const shared = Math.min(fine.length, coarse.length);

    expect(shared).toBeGreaterThan(8);
    expect(fine.slice(0, shared)).toEqual(coarse.slice(0, shared));
  });
});

describe('signals as control values under the combinators', () => {
  it('fast and slow move the signal in time', () => {
    const slowed = onsets(note('c4*4').pan(sine2.slow(4)));
    const fasted = onsets(note('c4*4').pan(sine2.fast(2)));

    slowed.forEach((value, i) => expect(value.pan).toBeCloseTo(sin2(i / 4 / 4), 9));
    fasted.forEach((value, i) => expect(value.pan).toBeCloseTo(sin2((i / 4) * 2), 9));
  });

  it('rev mirrors each cycle', () => {
    const pans = onsets(note('c4*4').pan(sine2.rev())).map((value) => value.pan);

    [1, 0.75, 0.5, 0.25].forEach((t, i) => expect(pans[i]).toBeCloseTo(sin2(t), 9));
  });

  it('every picks the transformed signal on cycle 0 and the plain one after', () => {
    const pat = note('c4*4').pan(sine2.every(2, (p) => p.mul(0)));

    expect(onsets(pat, 0).every((v) => v.pan === 0)).toBe(true); // -0 counts
    onsets(pat, 1).forEach((value, i) => expect(value.pan).toBeCloseTo(sin2(i / 4), 9));
  });

  it('cat plays one signal per cycle, each in its own cycles', () => {
    const pat = note('c4*4').pan(cat(sine2, saw2));

    onsets(pat, 0).forEach((value, i) => expect(value.pan).toBeCloseTo(sin2(i / 4), 9));
    expect(onsets(pat, 1).map((v) => v.pan)).toEqual([-1, -0.5, 0, 0.5]);
  });

  it('seq squeezes each signal into its half of the cycle', () => {
    const pans = onsets(note('c4*4').pan(seq(saw2, sine2))).map((v) => v.pan);

    expect(pans[0]).toBeCloseTo(-1, 9);
    expect(pans[1]).toBeCloseTo(0, 9); // the saw half way through its half
    expect(pans[2]).toBeCloseTo(sin2(0), 9);
    expect(pans[3]).toBeCloseTo(sin2(0.5), 9);
  });

  it('euclid on a signal is a structure: only the pulses get a value', () => {
    const events = onsets(note('c4*8').pan(sine2.euclid(3, 8)));

    const set = events.map((v) => v.pan !== undefined);
    expect(set).toEqual([true, false, false, true, false, false, true, false]);
    expect(events[3].pan).toBeCloseTo(sin2(3 / 8), 9);
    expect(events[6].pan).toBeCloseTo(sin2(6 / 8), 9);
  });

  it('jux gives the transformed side a signal-driven filter', () => {
    const haps = note('c4*4')
      .jux((p) => p.lpf(sine.range(200, 2000)))
      .query({ begin: new Fraction(0), end: new Fraction(1) });

    const left = haps.filter((h) => h.value.pan === -1);
    const right = haps.filter((h) => h.value.pan === 1);
    expect(left.every((h) => h.value.filterCutoff === undefined)).toBe(true);
    const cutoffs = right
      .sort((a, b) => a.part.begin.cmp(b.part.begin))
      .map((h) => h.value.filterCutoff);
    expect(cutoffs[0]).toBeCloseTo(1100, 6);
    expect(cutoffs[1]).toBeCloseTo(2000, 6);
    expect(cutoffs[2]).toBeCloseTo(1100, 6);
    expect(cutoffs[3]).toBeCloseTo(200, 6);
  });
});

describe('mixed continuous and discrete compositions', () => {
  const half = (): Pattern<number> => mini<number>('0 0.5', Number);
  const mixed: [string, () => Pattern<number>][] = [
    ['cat(saw2, pure)', () => cat(saw2, pure(0))],
    ['cat(pure, saw2)', () => cat(pure(0.2), saw2)],
    ['cat(saw2, mini)', () => cat(saw2, half())],
    ['seq(saw2, pure, isaw)', () => seq(saw2, pure(0.5), saw2.rev())],
    [
      'timecat(saw2, pure)',
      () =>
        timecat([
          [1, saw2],
          [2, pure(0.25)]
        ])
    ],
    ['stack(pure, saw2)', () => stack(pure(0.3), saw2)],
    ['stack(rest, saw2)', () => stack(mini<number>('~', Number), saw2)],
    ['arrange(saw2, pure)', () => arrange([1, saw2], [2, pure(0)])],
    ['every(discrete)', () => saw2.every(2, () => pure(0))],
    ['every(from discrete)', () => pure(0.4).every(2, () => saw2)],
    [
      'nested',
      () =>
        seq(cat(saw2, pure(0)), sine2)
          .fast(2)
          .rev()
    ]
  ];
  const quarterNote = () => note('c4*8');

  /** The pan at every onset in cycles 0-3, read through the given query windows. */
  const read = (pat: Pattern<number>, windows: number): (number | undefined)[] => {
    const control = quarterNote().pan(pat);
    const values: [number, number | undefined][] = [];
    const step = new Fraction(1, windows);
    for (let k = 0; k < 4 * windows; k++) {
      const begin = step.mul(new Fraction(k));
      for (const hap of control.query({ begin, end: begin.add(step) }).filter(hasOnset)) {
        values.push([hap.part.begin.toNumber(), hap.value.pan]);
      }
    }
    return values.sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  };

  it.each(mixed)('%s: one window and many small windows give the same values', (_n, make) => {
    const whole = read(make(), 1);
    expect(whole).toHaveLength(32);
    for (const windows of [2, 3, 8, 16]) {
      expect(read(make(), windows)).toEqual(whole);
    }
  });

  it('cat(saw2, pure) keeps the saw moving through its cycle', () => {
    expect(onsets(note('c4*4').pan(cat(saw2, pure(0)))).map((v) => v.pan)).toEqual([
      -1, -0.5, 0, 0.5
    ]);
  });

  it('a rest in a discrete child leaves the key unset', () => {
    const pans = onsets(note('c4*4').pan(cat(mini<number>('~ 0.5', Number), saw2)), 0);
    expect(pans.map((v) => v.pan)).toEqual([undefined, undefined, 0.5, 0.5]);
  });
});

describe('a bad time from a signal', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const bad = (value: number) => signal(() => value);

  beforeEach(() => {
    warn.mockClear();
  });

  /** Every duration control, set on a voice that uses its envelope (the filter and FM ones need a filter or FM to book anything). */
  const TIMES: [
    string,
    string,
    (p: Pattern<ControlPatch>, x: Pattern<number>) => Pattern<ControlPatch>
  ][] = [
    ['attack', 'attack', (p, x) => p.attack(x)],
    ['decay', 'decay', (p, x) => p.decay(x)],
    ['release', 'release', (p, x) => p.release(x)],
    ['lpa', 'lpa', (p, x) => p.lpf(500).lpenv(2000).lpa(x)],
    ['lpd', 'lpd', (p, x) => p.lpf(500).lpenv(2000).lpd(x)],
    ['lpr', 'lpr', (p, x) => p.lpf(500).lpenv(2000).lpr(x)],
    ['slide', 'slide', (p, x) => p.slide(x)],
    ['fmattack', 'fmattack', (p, x) => p.fm(2).fmattack(x)],
    ['fmdecay', 'fmdecay', (p, x) => p.fm(2).fmdecay(x)],
    ['fmrelease', 'fmrelease', (p, x) => p.fm(2).fmrelease(x)],
    ['pattack', 'pattack', (p, x) => p.penv(7).pattack(x)],
    ['pdecay', 'pdecay', (p, x) => p.penv(7).pdecay(x)],
    ['delaytime', 'delaytime', (p, x) => p.delay(0.3).delaytime(x)]
  ];

  const run = (pat: Pattern<ControlPatch>) => {
    const ctx = new FakeAudioContext({ strictTimes: true });
    const timer = new FakeTimer();
    loopPattern(pat, { ctx, timer, bpm: 120 });
    for (let i = 0; i < 12; i += 1) {
      ctx.currentTime += 0.1;
      timer.callback?.();
    }
    return ctx;
  };

  it('the strict fake rejects a negative automation time, as Web Audio does', () => {
    const ctx = new FakeAudioContext({ strictTimes: true });
    expect(() => ctx.createGain().gain.setValueAtTime(1, -0.9)).toThrow(RangeError);
    expect(() => ctx.createOscillator().start(-1)).toThrow(RangeError);
    expect(() => new FakeAudioContext().createGain().gain.setValueAtTime(1, -0.9)).not.toThrow();
  });

  it.each(TIMES)(
    '%s: a negative value leaves it unset, warns once and books the voice',
    (_n, name, apply) => {
      const ctx = run(apply(note('c4*2'), bad(-1)));

      expect(ctx.oscillators.length).toBeGreaterThanOrEqual(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        `undertone: ${name}() got -1 from a pattern; it needs 0 or more, so it is left unset.`
      );
    }
  );

  it.each(TIMES)('%s: zero is a valid time and warns of nothing', (_n, _name, apply) => {
    const ctx = run(apply(note('c4*2'), bad(0)));

    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a loop tick with a bad signal still books the other events', () => {
    const ctx = run(stack(note('c4*2').attack(bad(-1)).decay(bad(-2)), note('e4*2').pan(0.5)));

    // Two bad-signal notes and two good ones every cycle; the cycle is 2 s at 120 BPM.
    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(4);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('leaves a very large time alone: it is a long envelope, and nothing throws', () => {
    const ctx = run(note('c4*2').attack(bad(1e300)).decay(bad(1e300)).release(bad(1e300)));

    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps nudge, late and early signed: they move an event by design', () => {
    expect(onsets(note('c4').nudge(bad(-0.05)))[0].nudgeTime).toBe(-0.05);
    expect(onsets(note('c4').late(bad(-0.05)))[0].nudgeTime).toBe(-0.05);
    expect(onsets(note('c4').early(bad(-0.05)))[0].nudgeTime).toBe(0.05);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('what a pattern may give a control', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    warn.mockClear();
  });

  it('clamps pan to -1..1 and warns once', () => {
    const events = onsets(note('c4*4').pan(signal(() => 1.4)));

    expect(events.map((v) => v.pan)).toEqual([1, 1, 1, 1]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('undertone: pan() got 1.4 from a pattern; clamped to 1.');
  });

  it('clamps the low side, the start of panslide and autopandepth', () => {
    expect(onsets(note('c4').pan(signal(() => -3)))[0].pan).toBe(-1);
    expect(onsets(note('c4').panslide(signal(() => 2)))[0].panSlideFrom).toBe(1);
    expect(onsets(note('c4').autopandepth(signal(() => 1.5)))[0].autopanDepth).toBe(1);
    expect(onsets(note('c4').autopandepth(signal(() => -1)))[0].autopanDepth).toBe(0);
    expect(onsets(note('c4').autopanphase(signal(() => 2)))[0].autopanPhase).toBe(1);
    expect(warn).toHaveBeenCalledTimes(4); // autopandepth warns once for both sides
  });

  it('warns once per control, however many events or queries', () => {
    const pat = note('c4*8').pan(signal(() => 5));

    onsets(pat, 0);
    onsets(pat, 1);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['autopan', (x: Pattern<number>) => note('c4').autopan(x), 'autopan', 0],
    ['autopan', (x: Pattern<number>) => note('c4').autopan(x), 'autopan', -2],
    ['fmh', (x: Pattern<number>) => note('c4').fmh(x), 'fmh', 0],
    ['fm', (x: Pattern<number>) => note('c4').fm(x), 'fmIndex', -1],
    ['duration', (x: Pattern<number>) => note('c4').duration(x), 'duration', -0.5],
    ['legato', (x: Pattern<number>) => note('c4').legato(x), 'legato', -1],
    ['velocity', (x: Pattern<number>) => note('c4').velocity(x), 'velocity', -0.1]
  ])('%s leaves the key unset when the pattern gives %d', (name, build, key, value) => {
    const [event] = onsets(build(signal(() => value)));

    expect(event).not.toHaveProperty(
      key === 'autopan' || key === 'fmh' ? key.replace('fmh', 'fmHarmonicity') : key
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`undertone: ${name}() got ${value}`);
  });

  it.each([NaN, Infinity, -Infinity])('leaves the key unset for %d and warns', (value) => {
    const [event] = onsets(
      note('c4')
        .pan(signal(() => value))
        .lpf(signal(() => value))
    );

    expect(event).not.toHaveProperty('pan');
    expect(event).not.toHaveProperty('filterCutoff');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('treats undefined and a rest like a rest: unset, with no warning', () => {
    const undef = onsets(note('c4').pan(signal(() => undefined as unknown as number)))[0];
    const rest = onsets(note('c4 c4').pan(seq(pure(0.5), note('~').fmap(() => 0) as never)));

    expect(undef).not.toHaveProperty('pan');
    expect(rest[0].pan).toBe(0.5);
    expect(rest[1]).not.toHaveProperty('pan');
    expect(warn).not.toHaveBeenCalled();
  });

  it('sanitises a pattern without a sampler the same way', () => {
    const events = onsets(note('c4*2').pan(pure(3)));

    expect(events.map((v) => v.pan)).toEqual([1, 1]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the eager checks on a literal: a bad number or string still throws', () => {
    expect(() => note('c4').pan(2)).toThrow('pan() position must be between -1 and 1, got 2');
    expect(() => note('c4').pan('<-.6 1.2>')).toThrow('got 1.2');
    expect(() => note('c4').autopanphase(2)).toThrow('autopanphase() must be between 0 and 1');
  });

  it('leaves an earlier value in place where a pattern gives none', () => {
    const [event] = onsets(
      note('c4')
        .pan(0.3)
        .pan(signal(() => NaN))
    );

    expect(event.pan).toBe(0.3);
  });
});

describe('controls that stay scalar', () => {
  const pattern = sine as unknown as never;

  it.each([
    ['fmenv', (p: Pattern<ControlPatch>) => p.fmenv(pattern)],
    ['fmwave', (p: Pattern<ControlPatch>) => p.fmwave(pattern)],
    ['autopanshape', (p: Pattern<ControlPatch>) => p.autopanshape(pattern)],
    ['cut', (p: Pattern<ControlPatch>) => p.cut(pattern)],
    ['orbit', (p: Pattern<ControlPatch>) => p.orbit(pattern)],
    ['panlaw', (p: Pattern<ControlPatch>) => p.panlaw(pattern)],
    ['channels', (p: Pattern<ControlPatch>) => p.channels(pattern)],
    ['surround', (p: Pattern<ControlPatch>) => p.surround(pattern)],
    ['panpath', (p: Pattern<ControlPatch>) => p.panpath(pattern)],
    ['pitchsteps', (p: Pattern<ControlPatch>) => p.pitchsteps(pattern)],
    ['panslide', (p: Pattern<ControlPatch>) => p.panslide(0.5, pattern)]
  ])('%s throws a clear error when given a pattern', (name, call) => {
    expect(() => call(note('c4'))).toThrow(
      `${name}() takes a plain value, not a pattern; it cannot change from event to event`
    );
  });
});
