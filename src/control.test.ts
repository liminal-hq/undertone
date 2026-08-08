// Unit tests for the note()/sound() pattern constructors and chainable controls
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { n, note, sound } from './control';
import { Fraction } from './fraction';
import { hasOnset, rev, type Pattern } from './pattern';
import { noteToFrequency } from './pitch';
import type { ControlPatch } from './types';

function onsets(pat: Pattern<ControlPatch>, cycle = 0): ControlPatch[] {
  return pat
    .query({ begin: new Fraction(cycle), end: new Fraction(cycle + 1) })
    .filter(hasOnset)
    .sort((a, b) => a.part.begin.cmp(b.part.begin))
    .map((hap) => hap.value);
}

describe('note', () => {
  it('builds a one-event-per-cycle pattern from a single note name', () => {
    expect(onsets(note('c2'))).toEqual([{ pitch: 'c2' }]);
  });

  it('passes raw Hz numbers through', () => {
    expect(onsets(note(440))).toEqual([{ pitch: 440 }]);
    expect(onsets(note('440 220'))).toEqual([{ pitch: 440 }, { pitch: 220 }]);
  });

  it('parses mini-notation into multiple pitched events', () => {
    expect(onsets(note('c3 [e3 g3]'))).toEqual([{ pitch: 'c3' }, { pitch: 'e3' }, { pitch: 'g3' }]);
  });

  it('rejects invalid notes eagerly, at build time', () => {
    expect(() => note('c3 h9')).toThrow(/Invalid note name/);
    expect(() => note(-1)).toThrow(/Invalid frequency/);
    expect(() => note('c3 0 e3')).toThrow(/Invalid frequency/);
  });
});

describe('sound', () => {
  it('builds an unpitched pattern from a sound type', () => {
    expect(onsets(sound('white'))).toEqual([{ soundType: 'white' }]);
  });

  it('parses mini-notation of sound types', () => {
    expect(onsets(sound('white ~ pink'))).toEqual([{ soundType: 'white' }, { soundType: 'pink' }]);
  });

  it('rejects unknown sound types eagerly', () => {
    expect(() => sound('velvet')).toThrow(/Invalid sound type/);
  });
});

describe('n', () => {
  it('builds a one-event-per-cycle pattern from a single degree', () => {
    expect(onsets(n(2))).toEqual([{ degree: 2 }]);
  });

  it('parses mini-notation into multiple degree events, negatives included', () => {
    expect(onsets(n('0 2 -1'))).toEqual([{ degree: 0 }, { degree: 2 }, { degree: -1 }]);
  });

  it('rejects non-integer input eagerly, at build time', () => {
    expect(() => n(1.5)).toThrow(/Invalid scale degree/);
    expect(() => n('1.5')).toThrow(/Invalid scale degree/);
    expect(() => n('abc')).toThrow(/Invalid scale degree/);
  });
});

describe('scale', () => {
  it("resolves n()'s degree into pitch via a scale spec", () => {
    const pat = n('0 2 4').scale('c4:major');
    expect(onsets(pat)).toEqual([
      { pitch: noteToFrequency('c4') },
      { pitch: noteToFrequency('e4') },
      { pitch: noteToFrequency('g4') }
    ]);
  });

  it('leaves already-pitched events (from note()) untouched', () => {
    expect(onsets(note('c3').scale('c4:major'))).toEqual([{ pitch: 'c3' }]);
  });

  it('rejects an invalid scale spec eagerly, at build time', () => {
    expect(() => n('0').scale('nonsense')).toThrow(/Invalid scale spec/);
  });

  it('composes with other chain methods after resolution', () => {
    const pat = n('0 2').scale('D5:minor').sound('triangle').gain(0.5);
    expect(onsets(pat)).toEqual([
      { pitch: noteToFrequency('d5'), soundType: 'triangle', gainLevel: 0.5 },
      { pitch: noteToFrequency('f5'), soundType: 'triangle', gainLevel: 0.5 }
    ]);
  });
});

describe('chainable controls', () => {
  it('merges parameter patches across all events', () => {
    const pat = note('c3 e3').sound('triangle').attack(0.001).gain(0.5).lpf(800);
    expect(onsets(pat)).toEqual([
      { pitch: 'c3', soundType: 'triangle', attack: 0.001, gainLevel: 0.5, filterCutoff: 800 },
      { pitch: 'e3', soundType: 'triangle', attack: 0.001, gainLevel: 0.5, filterCutoff: 800 }
    ]);
  });

  it('covers the full envelope/filter/slide/nudge vocabulary', () => {
    const pat = note('c3')
      .attack(0.01)
      .decay(0.2)
      .sustain(0.5)
      .release(0.1)
      .lpenv(50)
      .lpa(0.02)
      .lpd(0.03)
      .lps(0.25)
      .lpr(0.04)
      .slide(0.07)
      .nudge(0.02);
    expect(onsets(pat)[0]).toEqual({
      pitch: 'c3',
      attack: 0.01,
      decay: 0.2,
      sustain: 0.5,
      release: 0.1,
      filterEnvAmount: 50,
      filterAttack: 0.02,
      filterDecay: 0.03,
      filterSustain: 0.25,
      filterRelease: 0.04,
      slideTime: 0.07,
      nudgeTime: 0.02
    });
  });

  it('is immutable — branching a base pattern leaves it untouched', () => {
    const base = note('c3');
    const branched = base.gain(0.1);
    expect(onsets(base)).toEqual([{ pitch: 'c3' }]);
    expect(onsets(branched)).toEqual([{ pitch: 'c3', gainLevel: 0.1 }]);
  });

  it('later calls override earlier ones', () => {
    expect(onsets(note('c3').gain(0.1).gain(0.9))).toEqual([{ pitch: 'c3', gainLevel: 0.9 }]);
  });

  it('late() and early() set nudgeTime with opposite sign', () => {
    expect(onsets(note('c3').late(0.03))).toEqual([{ pitch: 'c3', nudgeTime: 0.03 }]);
    expect(onsets(note('c3').early(0.03))).toEqual([{ pitch: 'c3', nudgeTime: -0.03 }]);
  });

  it('pans and validates the range', () => {
    expect(onsets(note('c3').pan(0.5))).toEqual([{ pitch: 'c3', pan: 0.5 }]);
    expect(() => note('c3').pan(2)).toThrow(/between -1 and 1/);
  });

  it('places voices on the 7.1 ring via channels() and surround()', () => {
    expect(onsets(note('c3').channels([0, 0, 0, 0.8]))[0]).toEqual({
      pitch: 'c3',
      channelGains: [0, 0, 0, 0.8]
    });
    expect(onsets(note('c3').surround(-90))[0].channelGains?.[4]).toBe(1);
    expect(() => note('c3').channels([])).toThrow(/1-8 gains/);
    expect(() => note('c3').channels([1, -0.5])).toThrow(/finite and >= 0/);
  });

  it('jux plays the original hard left and the transformed copy hard right', () => {
    const pat = note('c3 e3').jux(rev);
    const events = onsets(pat).map((v) => ({ pitch: v.pitch, pan: v.pan }));
    expect(events).toContainEqual({ pitch: 'c3', pan: -1 });
    expect(events).toContainEqual({ pitch: 'e3', pan: -1 });
    expect(events).toContainEqual({ pitch: 'e3', pan: 1 });
    expect(events).toContainEqual({ pitch: 'c3', pan: 1 });

    const left = onsets(pat).filter((v) => v.pan === -1);
    const right = onsets(pat).filter((v) => v.pan === 1);
    expect(left.map((v) => v.pitch)).toEqual(['c3', 'e3']);
    expect(right.map((v) => v.pitch)).toEqual(['e3', 'c3']);
  });

  it('composes with pattern combinators', () => {
    const pat = note('c3 e3')
      .sound('square')
      .every(2, (p) => p.rev());
    expect(onsets(pat, 0).map((v) => v.pitch)).toEqual(['e3', 'c3']);
    expect(onsets(pat, 1).map((v) => v.pitch)).toEqual(['c3', 'e3']);
  });
});

describe('patterned parameters', () => {
  it('assigns one control step per event when the step counts match', () => {
    const pat = note('c3 e3 g3 b3').gain('.1 .2 .3 .4');
    expect(onsets(pat).map((v) => v.gainLevel)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('samples the control at each event onset time, not by event index', () => {
    // Two control steps over four equal events: the control step covering
    // each onset supplies the value, so the first half of the cycle shares
    // one gain and the second half shares the other.
    const pat = note('c3 e3 g3 b3').gain('.1 .2');
    expect(onsets(pat).map((v) => v.gainLevel)).toEqual([0.1, 0.1, 0.2, 0.2]);
  });

  it('alternates per cycle through <...> the same way mini-notation always does', () => {
    const pat = note('c3').pan('<.25 .75>');
    expect(onsets(pat, 0)[0].pan).toBe(0.25);
    expect(onsets(pat, 1)[0].pan).toBe(0.75);
  });

  it('leaves the key unset where the control has a rest', () => {
    const pat = note('c3 e3').gain('.5 ~');
    expect(onsets(pat).map((v) => v.gainLevel)).toEqual([0.5, undefined]);
  });

  it('rejects an invalid literal in a control string, at build time', () => {
    expect(() => note('c3').gain('abc')).toThrow(/Invalid number/);
  });

  it('validates every literal in a patterned pan(), not just scalars', () => {
    expect(() => note('c3').pan('2')).toThrow(/between -1 and 1/);
    expect(() => note('c3').pan('<.5 2>')).toThrow(/between -1 and 1/);
  });

  it('early() negates a patterned value the same way it negates a scalar', () => {
    const pat = note('c3 e3').early('.01 .02');
    expect(onsets(pat).map((v) => v.nudgeTime)).toEqual([-0.01, -0.02]);
  });

  it('still accepts a plain scalar everywhere a string is accepted', () => {
    expect(onsets(note('c3 e3').gain(0.4)).map((v) => v.gainLevel)).toEqual([0.4, 0.4]);
  });
});
