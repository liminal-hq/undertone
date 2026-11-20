// Tests for patternable controls: a number, a string or a pattern (a signal) gives every control its value (ported from src/controlSignals.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  note,
  Fraction,
  Pattern,
  arrange,
  cat,
  hasOnset,
  pure,
  seq,
  stack,
  timecat,
  mini,
  rand,
  saw,
  saw2,
  signal,
  sine,
  sine2,
  type ControlPatch
} from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';

type Control = (
  pat: Pattern<ControlPatch>,
  input: number | string | Pattern<number>
) => Pattern<ControlPatch>;

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

function onsets(pat: Pattern<ControlPatch>, cycle = 0): ControlPatch[] {
  return pat
    .query({ begin: new Fraction(cycle), end: new Fraction(cycle + 1) })
    .filter(hasOnset)
    .sort((a, b) => a.part.begin.cmp(b.part.begin))
    .map((hap) => hap.value);
}

beforeEach(() => {
  resetWarnings();
});

describe('every patternable control', () => {
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
  it('keeps nudge, late and early signed: they move an event by design', () => {
    expect(onsets(note('c4').nudge(bad(-0.05)))[0].nudgeTime).toBe(-0.05);
    expect(onsets(note('c4').late(bad(-0.05)))[0].nudgeTime).toBe(-0.05);
    expect(onsets(note('c4').early(bad(-0.05)))[0].nudgeTime).toBe(0.05);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a random signal across cycles', () => {
  const velocities = (pat: Pattern<ControlPatch>, cycle: number) =>
    onsets(pat, cycle).map((v) => v.velocity);
  it('gives the same sequence every time it is played, but each cycle reads its own times', () => {
    const make = () => note('c4*8').velocity(rand.seed(7).range(0.3, 1));

    expect(velocities(make(), 0)).toEqual(velocities(make(), 0));
    expect(velocities(make(), 1)).toEqual(velocities(make(), 1));
    expect(velocities(make(), 1)).not.toEqual(velocities(make(), 0));
  });
  it('arrange([1, signal]) repeats the first cycle on every cycle', () => {
    const repeated = note('c4*8').velocity(arrange([1, rand.seed(7).range(0.3, 1)]));
    const first = velocities(note('c4*8').velocity(rand.seed(7).range(0.3, 1)), 0);

    for (const cycle of [0, 1, 2, 5]) {
      expect(velocities(repeated, cycle)).toEqual(first);
    }
  });
});

describe('carrying an autopan phase from note to note', () => {
  it('saw.fast(hz * secondsPerCycle) is the phase of an LFO running under the whole loop', () => {
    const bpm = 80;
    const hz = 0.5;
    const secondsPerCycle = 240 / bpm;
    const phases = [0, 1, 2, 3, 4].map(
      (cycle) =>
        onsets(
          note('c4')
            .autopan(hz)
            .autopanphase(saw.fast(hz * secondsPerCycle)),
          cycle
        )[0].autopanPhase as number
    );

    // An LFO started at time 0 has turned hz x seconds when cycle c begins.
    const running = [0, 1, 2, 3, 4].map((cycle) => (hz * secondsPerCycle * cycle) % 1);
    expect(phases).toEqual(running);
    expect(phases).toEqual([0, 0.5, 0, 0.5, 0]);
  });
  it('saw.slow(4) does not: it steps a quarter turn a cycle whatever the LFO rate', () => {
    const phases = [0, 1, 2, 3].map(
      (cycle) =>
        onsets(note('c4').autopan(0.5).autopanphase(saw.slow(4)), cycle)[0].autopanPhase as number
    );
    expect(phases).toEqual([0, 0.25, 0.5, 0.75]);
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
