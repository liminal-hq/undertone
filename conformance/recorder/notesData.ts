// Layer 1 `scales`, `chords`, and `drift` groups as data: scale tables, chord qualities and voicing, seeded drift
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { caseMaker } from './caseMaker';
import type { Step } from './interpret';
import type { ProgramCase, SpanText } from './programs';

/** Two spans: two whole cycles, and a span that starts inside a cycle. */
const TWO_SPANS: readonly SpanText[] = [
  ['0', '2'],
  ['1/3', '7/4']
];

/** Drift is keyed by the pass, so it is queried over four cycles and a span that starts inside a cycle. */
const DRIFT_SPANS: readonly SpanText[] = [
  ['0', '4'],
  ['1/3', '7/4']
];

const G = (family: string) => `generated: ${family}`;
const CT = 'src/control.test.ts';

/** The scale names of `SCALES` in `src/scale.ts`, in table order. */
const SCALE_NAMES = [
  'major',
  'ionian',
  'minor',
  'aeolian',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'locrian',
  'harmonicminor',
  'melodicminor',
  'majorpentatonic',
  'minorpentatonic',
  'chromatic'
];

/** Degrees that cross zero and several octaves of every scale length (5, 7, and 12). */
const RANGE_DEGREES = '-15 -13 -12 -8 -7 -6 -5 -1 0 1 2 3 4 5 6 7 8 9 12 13 14 15 20 25';

const degrees = (source: string, spec: string): Step[] => [
  ['n', source],
  ['scale', spec]
];

/**
 * `n(degrees).scale(spec)`: each of the 14 scale names over a wide degree range, the root and name
 * spellings, and the errors. The pitch is a Hz float, so these are layer 1 float comparisons.
 */
export function scaleCases(): ProgramCase[] {
  const make = caseMaker('scales', TWO_SPANS);
  const out: ProgramCase[] = [];
  for (const name of SCALE_NAMES) {
    out.push(
      make(
        'name',
        G(`every named scale (${name}) over degrees -15 to 25`),
        degrees(RANGE_DEGREES, `c4:${name}`)
      )
    );
  }
  for (const name of SCALE_NAMES) {
    out.push(
      make(
        'name-d',
        G(`every named scale (${name}) rooted at d#2, one octave up and down`),
        degrees('-7 -6 -5 -4 -3 -2 -1 0 1 2 3 4 5 6 7', `d#2:${name}`)
      )
    );
  }
  // generated: roots with sharps, flats, upper and lower case, and octaves from -1 to 10 (major and minor).
  const roots = [
    'C4',
    'c4',
    'd#3',
    'Db3',
    'a-1',
    'g9',
    'Bb2',
    'f#0',
    'e10',
    'cb4',
    'e#4',
    'b#3',
    'C-1',
    'g10',
    'A4',
    'a0'
  ];
  for (const root of roots) {
    out.push(
      make('root', G(`root ${root} in major and minor`), [
        ['n', '-8 -1 0 2 4 7 9'],
        ['scale', `${root}:major`]
      ])
    );
    out.push(
      make('root', G(`root ${root} in minor`), [
        ['n', '-8 -1 0 2 4 7 9'],
        ['scale', `${root}:minor`]
      ])
    );
  }
  // generated: the spellings the reference's normaliser accepts (case, spaces, hyphens, underscores).
  const spellings = [
    'Major',
    'MAJOR',
    'Harmonic Minor',
    'harmonic_minor',
    'harmonic-minor',
    'HarmonicMinor',
    'harmonicMinor',
    'melodic minor',
    'Major Pentatonic',
    'majorPentatonic',
    'minor_pentatonic',
    'Minor-Pentatonic',
    'DORIAN',
    'h-a-r-m-o-n-i-c-m-i-n-o-r',
    'ma jor',
    'major ',
    ' major',
    '\tmajor'
  ];
  for (const name of spellings) {
    out.push(
      make(
        'spelling',
        G(`scale name spelling ${JSON.stringify(name)}`),
        degrees('0 1 2 3 4 5 6 7', `c4:${name}`)
      )
    );
  }
  out.push(
    make(
      'spec',
      G('surrounding whitespace in the whole spec is trimmed'),
      degrees('0 2 4', '  C4:major  ')
    )
  );
  out.push(
    make('spec', G('a newline around the spec is trimmed'), degrees('0 2 4', '\nC4:minor\n'))
  );
  out.push(
    make(
      'spec',
      G('degrees from alternations and groups'),
      degrees('<0 2> [4 7]*2 ~ -3', 'D5:minor')
    )
  );
  out.push(
    make('spec', `${CT}: leaves already-pitched events (from note()) untouched`, [
      ['note', 'c3 e3'],
      ['scale', 'C4:major']
    ])
  );
  out.push(
    make('spec', G('scale applied twice: the second finds no degree'), [
      ['n', '0 1 2'],
      ['scale', 'c4:major'],
      ['scale', 'd4:minor']
    ])
  );
  out.push(
    make('spec', G('scale over sound(): events without a degree pass through'), [
      ['sound', 'white pink'],
      ['scale', 'c4:major']
    ])
  );
  out.push(
    make('spec', G('a stack of degrees makes a chord'), degrees('[0,2,4] [1,3,5]', 'c4:major'))
  );
  out.push(
    make('spec', G('n over a signal with events'), [
      ['n', [['sine'], ['segment', 8], ['range', 0, 7]]],
      ['scale', 'D4:major']
    ])
  );
  out.push(
    make('spec', G('n over a signal with fractional degrees floors them'), [
      ['n', [['saw'], ['segment', 4], ['range', -2, 9]]],
      ['scale', 'c4:minorpentatonic']
    ])
  );
  out.push(
    make('spec', G('scale then gain: other controls survive'), [
      ['n', '0 2 4'],
      ['scale', 'e3:dorian'],
      ['gain', 0.5]
    ])
  );
  // generated: degrees at the extremes of what the reference accepts (huge degrees give Infinity or 0 Hz).
  out.push(
    make('extreme', G('degrees of a million, either way'), degrees('1000000 -1000000', 'c4:major'))
  );
  out.push(
    make(
      'extreme',
      G('degrees of a hundred million: the pitch is Infinity or 0'),
      degrees('100000000 -100000000', 'c4:major')
    )
  );
  out.push(make('extreme', G('negative zero as a degree'), degrees('-0 0', 'c4:major')));
  out.push(
    make('extreme', G('very high roots with high degrees'), degrees('0 50 100', 'g10:chromatic'))
  );
  out.push(
    make('extreme', G('the lowest root with low degrees'), degrees('0 -12 -24 -50', 'c-1:major'))
  );
  out.push(make('extreme', G('zero padded degrees'), degrees('007 -007 00', 'c4:major')));
  // errors
  const bad: [string, string, string][] = [
    ['unknown-name', 'C4:bogus', `${CT}: rejects an invalid scale spec eagerly, at build time`],
    ['unknown-name', 'c4:blues', G('a scale the reference does not have')],
    ['unknown-name', 'c4:Major Scale', G('a name with a stray word')],
    ['unknown-name', 'c4:major:extra', G('a second colon stays in the name')],
    [
      'unknown-name',
      'c4: major',
      G(
        'a space after the colon survives into the name check (it is stripped by the normaliser, so this is valid)'
      )
    ],
    ['unknown-name', 'c4:   ', G('only spaces after the colon')],
    ['unknown-name', 'c4:_', G('a name that normalises to nothing')],
    ['unknown-name', 'c4:é', G('a non-ASCII name')],
    ['unknown-name', 'c4:😀', G('an emoji name: the message quotes it')],
    ['unknown-name', 'c4:wholetone', G('a well-known scale the reference lacks')],
    ['bad-spec', 'h4:major', G('a root letter past g')],
    ['bad-spec', 'c:major', G('a root without an octave')],
    ['bad-spec', 'cc4:major', G('a doubled letter')],
    ['bad-spec', 'c##4:major', G('a double sharp')],
    ['bad-spec', 'c#b4:major', G('a sharp and a flat')],
    ['bad-spec', '4:major', G('no root letter')],
    ['bad-spec', ':major', G('no root')],
    ['bad-spec', 'major', G('no root and no colon')],
    ['bad-spec', '', G('an empty spec')],
    ['bad-spec', '   ', G('a blank spec')],
    ['bad-spec', 'c4', G('a root with no colon')],
    ['bad-spec', 'c4:', G('a colon with no name')],
    ['bad-spec', 'c4 major', G('a space instead of a colon')],
    ['bad-spec', 'c4 :major', G('a space before the colon')],
    ['bad-spec', 'c4.5:major', G('a decimal octave')],
    ['bad-spec', 'c+4:major', G('a plus in the root')],
    ['bad-spec', 'c--1:major', G('a double hyphen in the octave')],
    ['bad-spec', 'C4:major\nx', G('a newline inside the spec: `.` does not match it')],
    ['bad-spec', ' c4:major', G('a no-break space is trimmed by trim(), so this is valid')],
    ['bad-spec', 'c4:ma\njor', G('a newline inside the name')]
  ];
  for (const [stem, spec, from] of bad) {
    out.push(make(`err-${stem}`, from, degrees('0 2 4', spec)));
  }
  out.push(
    make('err-degree', `${CT}: rejects non-integer input eagerly, at build time`, [
      ['n', '0 1.5'],
      ['scale', 'c4:major']
    ])
  );
  out.push(
    make('err-degree', G('a word as a degree'), [
      ['n', '0 x'],
      ['scale', 'c4:major']
    ])
  );
  out.push(
    make('err-degree', G('a signed degree with a plus'), [
      ['n', '+1'],
      ['scale', 'c4:major']
    ])
  );
  out.push(
    make('err-degree', G('an exponent degree'), [
      ['n', '1e2'],
      ['scale', 'c4:major']
    ])
  );
  out.push(
    make('err-degree', G('a bad degree and a bad scale: the degree error comes first'), [
      ['n', '1.5'],
      ['scale', 'zz']
    ])
  );
  out.push(
    make('err-degree', `${CT}: rejects non-integer input eagerly, at build time`, [
      ['n', 1.5],
      ['scale', 'c4:major']
    ])
  );
  return out;
}

/** The 22 chord qualities of `CHORD_QUALITIES` in `src/chord.ts`, in table order (the empty string is major). */
const QUALITIES = [
  '',
  'm',
  '6',
  'm6',
  '7',
  'maj7',
  'M7',
  'm7',
  '9',
  'maj9',
  'M9',
  'm9',
  'add9',
  'madd9',
  'sus2',
  'sus4',
  '7sus',
  '7sus4',
  'dim',
  'dim7',
  'aug',
  'm7b5'
];

const voiced = (source: string, options?: Record<string, unknown>): Step[] => [
  ['chord', source],
  options === undefined ? ['voicing'] : ['voicing', options]
];

/**
 * `chord(symbols).voicing(options)`: every quality over several roots, every root spelling, the
 * `anchor` option (a MIDI number or a note name), and the errors. Chords are layer 1 and, derived
 * from them, layer 2 (the resolved voices).
 */
export function chordCases(): ProgramCase[] {
  const make = caseMaker('chords', TWO_SPANS);
  const out: ProgramCase[] = [];
  for (const quality of QUALITIES) {
    const label = quality === '' ? '(major)' : quality;
    out.push(
      make(
        'quality',
        G(`quality ${label} over four roots`),
        voiced(['C', 'Eb', 'F#', 'a'].map((root) => `${root}${quality}`).join(' '))
      )
    );
  }
  for (const quality of QUALITIES) {
    out.push(
      make('quality-bare', G(`quality ${quality === '' ? '(major)' : quality} without voicing`), [
        ['chord', `D${quality} B${quality}`]
      ])
    );
  }
  // generated: all 21 root spellings (seven letters, natural, sharp, flat) in chunks of seven, major and minor 7th.
  const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  for (const accidental of ['', '#', 'b']) {
    out.push(
      make(
        'root',
        G(`roots with accidental ${accidental === '' ? 'none' : accidental}, major`),
        voiced(letters.map((l) => `${l}${accidental}`).join(' '))
      )
    );
    out.push(
      make(
        'root',
        G(`roots with accidental ${accidental === '' ? 'none' : accidental}, minor seventh`),
        voiced(letters.map((l) => `${l}${accidental}m7`).join(' '))
      )
    );
  }
  out.push(make('root', G('lowercase roots'), voiced('c d e f g a b cm em7 bb f#')));
  out.push(
    make(
      'root',
      G('flat on the letter b is a root, not a quality: Bb, bb, Bbm'),
      voiced('Bb bb Bbm bbm7 bm')
    )
  );
  out.push(make('root', G('enharmonic edges: Cb, B#, E#, Fb'), voiced('Cb B# E# Fb')));
  out.push(
    make(
      'root',
      `${CT}: builds a one-event-per-cycle pattern from a single chord symbol`,
      voiced('<Dm9 BbM7 Gm9 A7sus>')
    )
  );
  // generated: the anchor option, which centres the root within a half octave of it.
  const anchors: unknown[] = [
    60,
    48,
    72,
    36,
    84,
    0,
    127,
    -5,
    60.5,
    59.999,
    'c4',
    'c3',
    'c5',
    'f#2',
    'Bb4',
    'e4',
    'a#4',
    'C-1',
    'g9',
    ' c4 '
  ];
  for (const anchor of anchors) {
    out.push(
      make(
        'anchor',
        G(`anchor ${JSON.stringify(anchor)} over a progression`),
        voiced('C Dm7 F#M9 Bbm7b5 G7sus4 Aadd9', { anchor })
      )
    );
  }
  out.push(
    make(
      'anchor',
      G('anchor undefined (an empty options object) is the default'),
      voiced('C Dm7 G7', {})
    )
  );
  out.push(make('anchor', G('no options argument is the default'), voiced('C Dm7 G7')));
  out.push(
    make(
      'anchor',
      G('every root pitch class at anchor c4: nearest octave'),
      voiced('C C# D Eb E F F# G Ab A Bb B', { anchor: 'c4' })
    )
  );
  out.push(
    make(
      'anchor',
      G('every root pitch class at anchor 61'),
      voiced('C C# D Eb E F F# G Ab A Bb B', { anchor: 61 })
    )
  );
  out.push(
    make(
      'anchor',
      G('every root pitch class at anchor f#3'),
      voiced('Cm7 C#m7 Dm7 Ebm7 Em7 Fm7 F#m7 Gm7 Abm7 Am7 Bbm7 Bm7', { anchor: 'f#3' })
    )
  );
  out.push(
    make(
      'anchor',
      G('an anchor that is a string bad at query time: the error comes from the query'),
      voiced('C G', { anchor: 'zz' })
    )
  );
  out.push(
    make(
      'anchor',
      G('an anchor that is the wrong shape: a bare number name'),
      voiced('C G', { anchor: '60' })
    )
  );
  // generated: mini-notation around chords.
  out.push(make('mini', G('chords with modifiers'), voiced('C*2 Dm@3 G!2 ~')));
  out.push(make('mini', G('euclid on a chord'), voiced('<C Am>(3,8)')));
  out.push(make('mini', G('a stack of chord symbols'), voiced('[C,Em7]')));
  out.push(make('mini', G('nested groups of chords'), voiced('C [Dm7 G7] <C6 Am7>')));
  out.push(make('mini', G('chords sped up and slowed down'), voiced('[C F]*2 G/2')));
  out.push(make('mini', G('chord() without voicing keeps the symbol'), [['chord', 'C [Dm7 G7]']]));
  out.push(
    make('mini', G('voicing twice: the second pass finds no chord'), [
      ['chord', 'C Am'],
      ['voicing'],
      ['voicing', { anchor: 48 }]
    ])
  );
  out.push(
    make('mini', G('voicing over note(): pitched events pass through'), [
      ['note', 'c3 e3'],
      ['voicing']
    ])
  );
  out.push(
    make('mini', G('voicing then gain and lpf: controls apply to every note of the chord'), [
      ['chord', 'Cmaj7 Am9'],
      ['voicing'],
      ['gain', 0.5],
      ['lpf', 2000]
    ])
  );
  out.push(
    make('mini', G('a chord pattern given a sound'), [
      ['chord', 'Dm7 G7'],
      ['voicing'],
      ['sound', 'sawtooth']
    ])
  );
  // errors
  const bad: [string, string, string][] = [
    ['quality', 'Cmin', G('a quality the reference does not have (min)')],
    ['quality', 'Cmaj', G('maj alone is not a quality')],
    ['quality', 'CM', G('a bare M is not a quality')],
    ['quality', 'Csus', G('sus alone is not a quality')],
    ['quality', 'C7#9', G('an altered extension')],
    ['quality', 'Cm7#5', G('an altered fifth')],
    ['quality', 'C13', G('a thirteenth')],
    ['quality', 'C11', G('an eleventh')],
    ['quality', 'Cmaj13', G('a major thirteenth')],
    ['quality', 'Bbb', G('Bbb is B flat followed by the unknown quality b')],
    ['quality', 'Cdim9', G('a diminished ninth')],
    ['quality', 'CMAJ7', G('quality case matters: MAJ7')],
    ['quality', 'Cm7B5', G('quality case matters: B5')],
    ['quality', 'C-', G('a minus sign is not a word char problem but not a quality')],
    ['quality', 'C+', G('a plus sign is a token error before any chord error')],
    ['quality', 'Cmaj7.', G('a trailing dot')],
    ['quality', 'C_', G('an underscore quality')],
    ['quality', 'c#', G('a lowercase sharp root is valid, here for contrast with C##')],
    ['quality', 'C##', G('a double sharp root')],
    ['root', 'H7', G('a root letter past g')],
    ['root', 'X', G('an unrelated letter')],
    ['root', '7', G('a digit first')],
    ['root', 'hm', G('a lowercase letter past g')],
    ['root', '-', G('a lone hyphen')],
    ['root', '.', G('a lone dot')],
    ['root', '_C', G('an underscore first')],
    ['root', 'C/E', G('a slash chord is a slowdown in mini-notation: the number is missing')],
    ['root', 'C/2', G('a slash with a number is a slowdown of C, which is valid')],
    ['root', 'C D7 Eh', G('a later bad symbol: the position is the word')],
    ['root', '[C F#m7 Zm7]', G('a bad symbol inside a group')],
    ['root', 'Cé', G('a non-ASCII letter is a token error')],
    ['root', ' C 🎵', G('a note emoji after a no-break space: position 3')]
  ];
  for (const [stem, source, from] of bad) {
    out.push(make(`err-${stem}`, from, voiced(source)));
  }
  return out;
}

/** The seeds, and the notes they are applied to, for the `drift` group. */
type DriftOptions = Record<string, unknown>;

const driftOn = (base: Step, options: DriftOptions, ...more: Step[]): Step[] => [
  base,
  ...more,
  ['drift', options]
];

/**
 * `drift(pattern, options)`: seeded humanisation keyed `seed|pass|n/d|pitch`. The pitch in the key is
 * printed the JavaScript way, so a Hz float from `n().scale()` or `voicing()` puts a 16 or 17 digit
 * number in the key, and a note name puts the name. Layer 1 records the patched values (the `nudgeTime`,
 * `velocity`, `pitch`, and `pan` of each hap); layer 2, derived, records the resolved voices.
 */
export function driftCases(): ProgramCase[] {
  const make = caseMaker('drift', DRIFT_SPANS);
  const out: ProgramCase[] = [];
  const base: Step = ['note', 'c3 e3 g3 e3'];
  const D = 'src/drift.test.ts';
  // generated: each option alone, with a seed per number and string form.
  const alone: [string, DriftOptions][] = [
    ['timing', { timing: 0.01 }],
    ['level', { level: 0.2 }],
    ['cents', { cents: 15 }],
    ['pan', { pan: 0.3 }],
    ['push', { push: 0.02 }],
    ['push', { push: -0.03 }]
  ];
  for (const seed of [1, 'song']) {
    for (const [stem, options] of alone) {
      out.push(
        make(
          stem,
          G(`${stem} alone with seed ${JSON.stringify(seed)}`),
          driftOn(base, { seed, ...options })
        )
      );
    }
  }
  out.push(
    make(
      'all',
      `${D}: every option together`,
      driftOn(base, { seed: 7, timing: 0.012, level: 0.15, cents: 10, pan: 0.4, push: 0.005 })
    )
  );
  out.push(
    make(
      'all',
      G('every option together, different seed'),
      driftOn(base, { seed: 8, timing: 0.012, level: 0.15, cents: 10, pan: 0.4, push: 0.005 })
    )
  );
  out.push(make('off', G('nothing set: off unless a range is set'), driftOn(base, { seed: 1 })));
  out.push(
    make(
      'off',
      G('every range zero'),
      driftOn(base, { seed: 1, timing: 0, level: 0, cents: 0, pan: 0, push: 0 })
    )
  );
  // generated: seed forms, which the key prints with JavaScript's number and string conversion.
  const seeds: unknown[] = [
    0,
    1,
    2,
    42,
    -1,
    -42,
    1.5,
    0.1,
    1e-7,
    1e21,
    123456789012,
    4294967296,
    4294967297,
    -2147483648,
    9007199254740991,
    0.30000000000000004,
    '',
    '0',
    '1',
    'a|b',
    'drift|0',
    'é',
    '😀',
    '\ud800',
    'seed with spaces',
    'x'.repeat(200)
  ];
  for (const seed of seeds) {
    out.push(
      make(
        'seed',
        G(`seed ${JSON.stringify(seed)}: the key is built with JavaScript conversion`),
        driftOn(base, { seed, timing: 0.02, level: 0.1, cents: 20, pan: 0.2 })
      )
    );
  }
  out.push(
    make(
      'seed',
      G('no seed at all: the key starts with the word undefined'),
      driftOn(base, { timing: 0.02 })
    )
  );
  // generated: passes. The seed advances every pass; a pass is cyclesPerPass cycles.
  for (const cyclesPerPass of [1, 2, 3, 4, 5, 8, 16, 100]) {
    out.push(
      make(
        'pass',
        G(`cyclesPerPass ${cyclesPerPass}`),
        driftOn(['note', 'c3 <e3 g3> [c4 e4]*2'], {
          seed: 3,
          timing: 0.01,
          level: 0.1,
          cyclesPerPass
        })
      )
    );
  }
  out.push(
    make(
      'pass',
      G('a long slow pattern: positions inside a pass are fractions of a cycle'),
      driftOn(['note', 'c3/3 e3/2'], { seed: 3, timing: 0.01, cyclesPerPass: 2 })
    )
  );
  // generated: positions inside a cycle give the n/d of the key.
  const positions: [string, string][] = [
    ['c3*3', 'thirds'],
    ['c3*7', 'sevenths'],
    ['c3(3,8)', 'euclid eighths'],
    ['c3(5,12,2)', 'euclid twelfths'],
    ['c3*16', 'sixteenths'],
    ['[c3 e3]*3 g3', 'nested speeds'],
    ['c3@3 e3', 'weights'],
    ['c3 ~ e3 ~', 'rests: no hap, no key'],
    ['c3*0.5', 'a note every two cycles'],
    ['c3 [e3 g3 b3 d4 f4]', 'a group of five']
  ];
  for (const [source, what] of positions) {
    out.push(
      make(
        'position',
        G(`positions: ${what}`),
        driftOn(['note', source], { seed: 5, timing: 0.01, level: 0.1, cents: 12, pan: 0.2 })
      )
    );
  }
  // generated: pitches in the key (a name, Hz numbers, derived floats, chord notes, no pitch).
  out.push(
    make(
      'pitch',
      G('note names'),
      driftOn(['note', 'c3 f#3 Bb3 c-1'], { seed: 9, timing: 0.01, cents: 10 })
    )
  );
  out.push(
    make(
      'pitch',
      G('Hz numbers: 440, 220.5, and 1e21 as the key prints them'),
      driftOn(['note', '440 220.5'], { seed: 9, timing: 0.01, cents: 10 })
    )
  );
  out.push(
    make(
      'pitch',
      G('a pitch of a hundred digits: Hz from a long decimal'),
      driftOn(['note', '261.6255653005986'], { seed: 9, timing: 0.01, cents: 10 })
    )
  );
  out.push(
    make(
      'pitch',
      G('scale degrees give Hz floats with 16 digits in the key'),
      driftOn(['n', '0 2 4 7'], { seed: 9, timing: 0.01, cents: 10 }, ['scale', 'c4:major'])
    )
  );
  out.push(
    make(
      'pitch',
      G('negative and large degrees in the key'),
      driftOn(['n', '-3 0 12 30'], { seed: 9, timing: 0.01, cents: 10 }, ['scale', 'a2:dorian'])
    )
  );
  out.push(
    make(
      'pitch',
      G('a chord voiced into several notes at one onset: each key has its own pitch'),
      driftOn(['chord', 'Cmaj7 Am9'], { seed: 9, timing: 0.01, level: 0.1, cents: 10, pan: 0.2 }, [
        'voicing'
      ])
    )
  );
  out.push(
    make(
      'pitch',
      G('unpitched sounds: the key ends with a bar and nothing'),
      driftOn(['sound', 'white*4'], { seed: 9, timing: 0.01, level: 0.1, cents: 10, pan: 0.2 })
    )
  );
  out.push(
    make(
      'pitch',
      G('sample names: cents do not apply'),
      driftOn(['s', 'bd sd hh sd'], { seed: 9, timing: 0.01, level: 0.1, cents: 10, pan: 0.2 })
    )
  );
  // generated: the patch already holds values the drift adds to.
  out.push(
    make(
      'patch',
      G('an earlier nudge adds to the drift'),
      driftOn(base, { seed: 2, timing: 0.01 }, ['nudge', 0.05])
    )
  );
  out.push(
    make(
      'patch',
      G('an earlier velocity scales'),
      driftOn(base, { seed: 2, level: 0.3 }, ['velocity', 0.5])
    )
  );
  out.push(
    make(
      'patch',
      G('an earlier pan adds and clamps'),
      driftOn(base, { seed: 2, pan: 0.8 }, ['pan', 0.9])
    )
  );
  out.push(
    make(
      'patch',
      G('a pan beyond range is clamped by the control before drift'),
      driftOn(base, { seed: 2, pan: 2 }, ['pan', -0.9])
    )
  );
  out.push(
    make(
      'patch',
      G('a large pan range clamps the result to -1..1'),
      driftOn(base, { seed: 2, pan: 5 })
    )
  );
  out.push(
    make(
      'patch',
      G('a large level goes below zero or above two'),
      driftOn(base, { seed: 2, level: 3 })
    )
  );
  out.push(
    make(
      'patch',
      G('push alone does not use the random source'),
      driftOn(base, { seed: 2, push: 0.1 }, ['nudge', 0.05])
    )
  );
  out.push(
    make(
      'patch',
      G('push added to an earlier negative nudge'),
      driftOn(base, { seed: 2, push: 0.1 }, ['nudge', -0.1])
    )
  );
  out.push(
    make('patch', G('drift then more controls'), [
      ...driftOn(base, { seed: 2, timing: 0.01, cents: 5 }),
      ['gain', 0.5],
      ['lpf', 1500]
    ])
  );
  out.push(
    make('patch', G("drift twice: the second drift keys on the first drift's pitch"), [
      base,
      ['drift', { seed: 1, cents: 10 }],
      ['drift', { seed: 1, cents: 10, timing: 0.01 }]
    ])
  );
  out.push(
    make('patch', G('drift under every, rev, fast, and jux'), [
      base,
      ['drift', { seed: 4, timing: 0.01, level: 0.1 }],
      ['every', 2, [['rev']]],
      ['fast', 2]
    ])
  );
  out.push(
    make('patch', G('drift over a stack'), [
      ['stack', [['note', 'c3 e3']], [['note', 'g4*3']]],
      ['drift', { seed: 4, timing: 0.01, level: 0.1, cents: 7, pan: 0.2 }]
    ])
  );
  out.push(
    make('patch', G('a signal-driven control leaves the haps with a whole'), [
      base,
      ['pan', [['sine']]],
      ['drift', { seed: 4, pan: 0.2 }]
    ])
  );
  // errors
  const errors: [string, DriftOptions, string][] = [
    ['cycles', { seed: 1, cyclesPerPass: 0 }, G('cyclesPerPass zero')],
    ['cycles', { seed: 1, cyclesPerPass: -1 }, G('cyclesPerPass negative')],
    ['cycles', { seed: 1, cyclesPerPass: 1.5 }, G('cyclesPerPass fractional')],
    ['cycles', { seed: 1, cyclesPerPass: '2' }, G('cyclesPerPass as a string')],
    ['cycles', { seed: 1, cyclesPerPass: null }, G('cyclesPerPass null: not an integer')],
    ['negative', { seed: 1, timing: -0.01 }, G('timing negative')],
    ['negative', { seed: 1, level: -0.1 }, G('level negative')],
    ['negative', { seed: 1, cents: -1 }, G('cents negative')],
    ['negative', { seed: 1, pan: -0.5 }, G('pan negative')],
    [
      'negative',
      { seed: 1, timing: 0.01, level: -1, pan: -1 },
      G('the first negative option is the one reported')
    ],
    ['negative', { seed: 1, timing: 'x' }, G('a word for timing is not >= 0')],
    [
      'negative',
      { seed: 1, timing: null },
      G('null timing is destructured as null, which is >= 0 and drifts nothing')
    ]
  ];
  for (const [stem, options, from] of errors) {
    out.push(make(`err-${stem}`, from, driftOn(base, options)));
  }
  // generated: queries over negative cycles (the pass is a floor) and a query that starts mid-cycle.
  out.push(
    make(
      'window',
      G('negative cycles: the pass number is negative'),
      driftOn(base, { seed: 6, timing: 0.01, level: 0.1, cyclesPerPass: 2 }),
      [
        ['-4', '0'],
        ['-3/2', '-1/2'],
        ['-1', '0'],
        ['0', '4'],
        ['7/3', '11/3']
      ]
    )
  );
  out.push(
    make(
      'window',
      G('the same drift over a window that starts inside a note'),
      driftOn(base, { seed: 6, timing: 0.01, level: 0.1, cyclesPerPass: 2 }),
      [
        ['1/8', '5/8'],
        ['5/8', '9/8'],
        ['0', '2']
      ]
    )
  );
  return out;
}
