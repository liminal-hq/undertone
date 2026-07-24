// Unit tests for the note()/sound() pattern constructors and chainable controls
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, sound } from './control';
import { Fraction } from './fraction';
import { hasOnset, type Pattern } from './pattern';
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

  it('composes with pattern combinators', () => {
    const pat = note('c3 e3')
      .sound('square')
      .every(2, (p) => p.rev());
    expect(onsets(pat, 0).map((v) => v.pitch)).toEqual(['e3', 'c3']);
    expect(onsets(pat, 1).map((v) => v.pitch)).toEqual(['c3', 'e3']);
  });
});
