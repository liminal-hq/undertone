// The first subset's layer 1 programs as data, each naming where it came from
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { DEFAULT_SAMPLES, words } from './programs';
import type { ProgramCase, SpanText } from './programs';
import type { Program, Step } from './interpret';
import { miniCases } from './miniData';
import { chordCases, scaleCases } from './notesData';

let counter = new Map<string, number>();

/** A numbered case id inside a group (`core-fast-03`). */
function id(group: string, stem: string): string {
  const key = `${group}-${stem}`;
  const next = (counter.get(key) ?? 0) + 1;
  counter.set(key, next);
  return `${key}-${String(next).padStart(2, '0')}`;
}

function make(group: string, stem: string, from: string, program: Program): ProgramCase {
  return { id: id(group, stem), group, from, program };
}

const note = (source: string): Step => ['note', source];

// ---------------------------------------------------------------------------------------------
// core: pure, silence, stack, seq, cat, timecat, fast, slow, euclid, and the mini-notation forms
// ---------------------------------------------------------------------------------------------

function core(): ProgramCase[] {
  const out: ProgramCase[] = [];
  const t = 'src/pattern.test.ts';
  const m = 'src/mini.test.ts';
  out.push(make('core', 'pure', `${t}: repeats its value once per cycle`, [['pure', 1]]));
  out.push(make('core', 'pure', `${t}: repeats its value once per cycle`, [['pure', 'a']]));
  out.push(make('core', 'silence', `${t}: never returns events`, [['silence']]));
  const miniForms: [string, string, string][] = [
    ['seq', 'a b c', `${t}: divides the cycle equally`],
    ['rest', 'a ~ b', `${m}: treats ~ as a rest`],
    ['star', 'a*2 b', `${m}: speeds up with * and slows down with /`],
    ['slash', 'a/2 b', `${m}: speeds up with * and slows down with /`],
    ['bang', 'a!3 b', `${m}: replicates with ! and elongates with @`],
    ['at', 'a@3 b', `${t}: divides the cycle by weight`],
    ['nest', 'a [b c]', `${t}: nests, subdividing the parent slot`],
    ['alt', '<a b c>', `${t}: plays one pattern per cycle in rotation`],
    ['alt', 'a <b c>', `${t}: unfolds nested alternations one step per visit (a b a c)`],
    ['alt', '<a b>*2', `${m}: applies postfix modifiers to a whole <> group`],
    ['stack', '[a,b]', `${t}: plays all patterns at once`],
    ['stack', 'a b, c d e', `${t}: plays all patterns at once`],
    ['thirds', 'a b c', `${t}: keeps exact thirds across many cycles`]
  ];
  for (const [stem, source, from] of miniForms) {
    out.push(make('core', stem, from, [words(source)]));
  }
  out.push(
    make('core', 'stack', `${t}: plays all patterns at once`, [
      ['stack', [['pure', 1]], [words('a b')], [['pure', 'z']]]
    ])
  );
  out.push(
    make('core', 'seq', `${t}: divides the cycle equally`, [
      ['seq', [['pure', 'a']], [words('b c')], [['silence']]]
    ])
  );
  out.push(
    make('core', 'cat', `${t}: plays one pattern per cycle in rotation`, [
      ['cat', [['pure', 'a']], [words('b c')], [words('d e f')]]
    ])
  );
  out.push(
    make('core', 'cat', `${t}: unfolds nested alternations one step per visit (a b a c)`, [
      ['cat', [words('a <b c>')], [['pure', 'z']]]
    ])
  );
  out.push(
    make('core', 'timecat', `${t}: divides the cycle by weight`, [
      [
        'timecat',
        [
          [1, [['pure', 'a']]],
          [3, [words('b c')]]
        ]
      ]
    ])
  );
  out.push(
    make('core', 'timecat', `${t}: divides the cycle by weight`, [
      [
        'timecat',
        [
          [1.5, [['pure', 'a']]],
          [0.5, [['pure', 'b']]],
          [2, [words('c d')]]
        ]
      ]
    ])
  );
  out.push(
    make('core', 'timecat', `${t}: rejects non-positive weights`, [
      [
        'timecat',
        [
          [0, [['pure', 'a']]],
          [1, [['pure', 'b']]]
        ]
      ]
    ])
  );
  for (const factor of [2, 3, 0.5, 1.5, 0.75]) {
    out.push(
      make('core', 'fast', `${t}: fast(2) squeezes two cycles into one`, [
        words('a b c'),
        ['fast', factor]
      ])
    );
  }
  for (const factor of [2, 3, 0.5]) {
    out.push(
      make(
        'core',
        'slow',
        `${t}: slow(2) stretches an event across two cycles, with the onset only in the first`,
        [words('a b'), ['slow', factor]]
      )
    );
  }
  out.push(make('core', 'fast', `${t}: rejects non-positive factors`, [words('a b'), ['fast', 0]]));
  out.push(
    make('core', 'slow', `${t}: rejects non-positive factors`, [words('a b'), ['slow', -1]])
  );
  const euclids: [number, number, number | undefined][] = [
    [3, 8, undefined],
    [5, 8, undefined],
    [3, 4, undefined],
    [7, 16, undefined],
    [4, 4, undefined],
    [3, 8, 2],
    [3, 8, -1],
    [5, 12, 3]
  ];
  for (const [pulses, steps, rotation] of euclids) {
    const step: Step =
      rotation === undefined ? ['euclid', pulses, steps] : ['euclid', pulses, steps, rotation];
    out.push(
      make('core', 'euclid', `${t}: produces the canonical euclidean necklaces`, [
        ['pure', 'x'],
        step
      ])
    );
  }
  out.push(
    make('core', 'euclid', `${t}: rejects invalid arguments`, [
      ['pure', 'x'],
      ['euclid', 9, 8]
    ])
  );
  out.push(
    make('core', 'euclid', `${t}: places onsets on the euclidean slots`, [
      words('a b'),
      ['euclid', 3, 8]
    ])
  );
  out.push(
    make('core', 'euclid', `${m}: parses euclidean shorthand with optional rotation`, [
      words('a(3,8) b(5,8,2)')
    ])
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// combinators: rev, every, jux, arrange, and fmap with named maps
// ---------------------------------------------------------------------------------------------

function combinators(): ProgramCase[] {
  const out: ProgramCase[] = [];
  const t = 'src/pattern.test.ts';
  const bases: [string, Step][] = [
    ['seq', words('a b c d')],
    ['alt', words('a <b c> d')],
    ['rest', words('a ~ [b c]')],
    ['euclid', words('x(3,8)')]
  ];
  for (const [stem, base] of bases) {
    out.push(make('combinators', `rev-${stem}`, `${t}: reverses each cycle`, [base, ['rev']]));
  }
  out.push(
    make('combinators', 'rev', `${t}: is its own inverse`, [words('a b c'), ['rev'], ['rev']])
  );
  out.push(
    make('combinators', 'rev', `${t}: reverses each cycle`, [
      ['cat', [words('a b')], [words('c d e')]],
      ['rev']
    ])
  );
  out.push(
    make('combinators', 'rev', `${t}: reverses each cycle`, [words('a b c'), ['fast', 2], ['rev']])
  );
  const transforms: [string, Program][] = [
    ['rev', [['rev']]],
    ['fast', [['fast', 2]]],
    ['slow', [['slow', 2]]],
    ['fast-rev', [['fast', 2], ['rev']]]
  ];
  for (const n of [1, 2, 3, 4]) {
    for (const [stem, transform] of transforms.slice(0, n === 2 ? 4 : 2)) {
      out.push(
        make(
          'combinators',
          `every-${n}-${stem}`,
          `${t}: applies the transform on cycles 0, n, 2n, ...`,
          [words('a b c'), ['every', n, transform]]
        )
      );
    }
  }
  out.push(
    make('combinators', 'every', `${t}: rejects non-positive or fractional cycle counts`, [
      words('a b'),
      ['every', 0, [['rev']]]
    ])
  );
  out.push(
    make('combinators', 'every', `${t}: rejects non-positive or fractional cycle counts`, [
      words('a b'),
      ['every', 1.5, [['rev']]]
    ])
  );
  out.push(
    make('combinators', 'every', `${t}: applies the transform on cycles 0, n, 2n, ...`, [
      words('a b'),
      ['every', 2, [['rev']]],
      ['every', 3, [['fast', 2]]]
    ])
  );
  out.push(
    make('combinators', 'every', 'docs/guide/arranging-songs.md: every', [
      words('a [b c] <d e>'),
      ['every', 4, [['slow', 2]]]
    ])
  );
  out.push(
    make('combinators', 'every', `${t}: applies the transform on cycles 0, n, 2n, ...`, [
      words('a b c d'),
      ['every', 2, [['every', 3, [['rev']]]]]
    ])
  );
  // jux, on note patterns (it pans: left, right)
  const juxBases: Step[] = [note('c3 e3'), note('c3 e3 g3 b3'), note('a2 ~ [c3 e3]'), note('c3*2')];
  for (const base of juxBases) {
    out.push(
      make(
        'combinators',
        'jux',
        'src/control.test.ts: jux plays the original hard left and the transformed copy hard right',
        [base, ['jux', [['rev']]]]
      )
    );
  }
  out.push(
    make('combinators', 'jux', 'src/control.test.ts: composes with pattern combinators', [
      note('c3 e3 g3'),
      ['jux', [['fast', 2]]]
    ])
  );
  out.push(
    make('combinators', 'jux', 'src/control.test.ts: composes with pattern combinators', [
      note('c3 e3 g3'),
      ['jux', [['slow', 2]]],
      ['gain', 0.5]
    ])
  );
  out.push(
    make(
      'combinators',
      'jux',
      'src/controlSignals.test.ts: jux gives the transformed side a signal-driven filter',
      [note('c3 e3 g3 e3'), ['jux', [['rev'], ['lpf', [['sine']]]]]]
    )
  );
  // arrange
  const arrangements: [string, Step][] = [
    ['two', ['arrange', [1, [words('a')]], [1, [words('b')]]]],
    ['lengths', ['arrange', [2, [words('a b')]], [1, [words('c')]]]],
    [
      'plays each section for its own span of whole cycles',
      ['arrange', [3, [words('a <b c>')]], [2, [words('d')]]]
    ],
    ['three', ['arrange', [1, [words('a')]], [2, [words('b c')]], [3, [words('d e f')]]]],
    ['alt', ['arrange', [2, [words('<a b>')]], [2, [words('<c d>')]]]],
    [
      "restarts each section's pattern at its own cycle 0",
      ['arrange', [2, [words('a b')]], [2, [words('<c d e>')]]]
    ],
    ['signal', ['arrange', [1, [['saw']]], [1, [['pure', 0.5]]]]],
    ['empty', ['arrange']],
    ['zero', ['arrange', [0, [words('a')]]]],
    ['fractional', ['arrange', [1.5, [words('a')]]]]
  ];
  for (const [what, step] of arrangements) {
    const from =
      what === 'empty'
        ? `${t}: returns silence for no sections`
        : what === 'zero' || what === 'fractional'
          ? `${t}: rejects non-positive-integer cycle counts`
          : `${t}: plays each section for its own span of whole cycles`;
    out.push(make('combinators', 'arrange', from, [step]));
  }
  out.push(
    make('combinators', 'arrange', `${t}: loops the whole arrangement once the total is reached`, [
      ['arrange', [1, [words('a')]], [1, [words('b')]]],
      ['fast', 2]
    ])
  );
  out.push(
    make('combinators', 'arrange', 'docs/guide/arranging-songs.md: arrange', [
      ['arrange', [4, [note('c3 e3 g3 e3')]], [4, [note('a2 c3 e3 c3')]]],
      ['every', 4, [['rev']]]
    ])
  );
  // fmap with named maps, over number patterns
  const maps: [string, ...unknown[]][] = [
    ['add', 7],
    ['sub', 3],
    ['mul', 2],
    ['div', 4],
    ['neg'],
    ['abs'],
    ['round'],
    ['floor']
  ];
  const numberBases: Step[] = [
    ['mini', '0 1.5 -2.5 3', 'number'],
    ['mini', '<1 2 3> 4.25', 'number'],
    ['sine']
  ];
  for (const [index, base] of numberBases.entries()) {
    for (const map of maps.slice(0, index === 0 ? 8 : index === 1 ? 5 : 4)) {
      out.push(
        make('combinators', 'fmap', `generated: fmap ${map[0]} over a number pattern`, [
          base,
          ['fmap', ...map]
        ])
      );
    }
  }
  out.push(
    make('combinators', 'fmap', `${t}: rounds and floors`, [
      ['mini', '0.5 1.5 -1.5 2.4999', 'number'],
      ['fmap', 'round']
    ])
  );
  out.push(
    make('combinators', 'fmap', `${t}: rounds and floors`, [
      ['mini', '-4.2 4.2', 'number'],
      ['fmap', 'floor']
    ])
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// notes: note, sound, s, bank, n and scale
// ---------------------------------------------------------------------------------------------

function notes(): ProgramCase[] {
  const out: ProgramCase[] = [];
  const t = 'src/control.test.ts';
  const noteForms: [string, string][] = [
    ['c4', `${t}: builds a one-event-per-cycle pattern from a single note name`],
    ['c4 e4 g4', `${t}: parses mini-notation into multiple pitched events`],
    ['c4 e4 g4 e4', 'docs/recipes.md: pluck'],
    ['a1 [a1 a2] c2 <e2 g1>', 'docs/recipes.md: acid'],
    ['<a1 f1 c2 g1>(3,8)', 'docs/recipes.md: bass'],
    ['c1 ~ [~ c1] ~', 'docs/recipes.md: kick'],
    ['f#3 Bb2 c#5', 'generated: sharps and flats'],
    ['c3*8', 'generated: speed'],
    ['110 220 440', `${t}: passes raw Hz numbers through`],
    ['e2 e2 g2 e2', 'docs/recipes.md: groove'],
    ['c5 e5 g5 e5*2', 'docs/recipes.md: mallet'],
    ['[c3,e3,g3]', 'generated: a chord as a stack'],
    ['c3 e3 g3 b3 c4', 'generated: five steps'],
    ['zz', `${t}: rejects invalid notes eagerly, at build time`],
    ['c4 h9', `${t}: rejects invalid notes eagerly, at build time`]
  ];
  for (const [source, from] of noteForms) out.push(make('notes', 'note', from, [note(source)]));
  out.push(make('notes', 'note', `${t}: passes raw Hz numbers through`, [['note', 440]]));
  const soundForms: [string, string][] = [
    ['white', `${t}: builds an unpitched pattern from a sound type`],
    ['white*8', 'docs/recipes.md: hats'],
    ['white ~ pink(3,8)', `${t}: parses mini-notation of sound types`],
    ['sine triangle square sawtooth', 'generated: oscillator types'],
    ['white*16', 'docs/recipes.md: sound(white*16)'],
    ['bogus', `${t}: rejects unknown sound types eagerly`]
  ];
  for (const [source, from] of soundForms)
    out.push(make('notes', 'sound', from, [['sound', source]]));
  const sForms: [string, string][] = [
    ['square', `${t}: behaves exactly like sound() for a synth type`],
    ['bd ~ [bd bd] sd', `${t}: treats an unknown word as a sample name instead of throwing`],
    [
      'gm_acoustic_bass',
      `${t}: parses mini-notation mixing synth types and sample names, underscores included`
    ],
    [
      'bd sine hh*2',
      `${t}: parses mini-notation mixing synth types and sample names, underscores included`
    ]
  ];
  for (const [source, from] of sForms) out.push(make('notes', 's', from, [['s', source]]));
  out.push(
    make('notes', 'bank', `${t}: .bank() sets a bank prefix used for sample lookup`, [
      ['s', 'bd sd'],
      ['bank', 'RolandTR909']
    ])
  );
  out.push(
    make(
      'notes',
      'sound',
      `${t}: .sound() also clears a previously-set sample name — sampleName otherwise wins in the engine`,
      [
        ['s', 'bd sd'],
        ['sound', 'square']
      ]
    )
  );
  out.push(
    make(
      'notes',
      's',
      `${t}: .s() clears the previous soundType/sampleName when switching between them`,
      [note('c3 e3'), ['sound', 'sawtooth'], ['s', 'bd']]
    )
  );
  const scales: [string, string, string][] = [
    ['0 1 2 3 4 5 6 7', 'C4:major', `${t}: resolves n()'s degree into pitch via a scale spec`],
    ['0 2 4 7', 'D5:minor', `${t}: resolves n()'s degree into pitch via a scale spec`],
    ['<0 4 2 7>*2 ~ <4 9> ~', 'a3:minorPentatonic', 'docs/recipes.md: shimmer'],
    ['<0 2 4 7 4 2>*2 ~', 'c4:dorian', 'docs/recipes.md: lead'],
    [
      '-3 -1 0 7 8',
      'e3:harmonicMinor',
      `${t}: parses mini-notation into multiple degree events, negatives included`
    ],
    ['0 3 6 9 12', 'f2:chromatic', 'generated: chromatic degrees'],
    ['0 1 2', 'g4:Harmonic Minor', 'generated: a spaced scale name'],
    ['0 1 2', 'C4:bogus', `${t}: rejects an invalid scale spec eagerly, at build time`]
  ];
  for (const [degrees, spec, from] of scales) {
    out.push(
      make('notes', 'scale', from, [
        ['n', degrees],
        ['scale', spec]
      ])
    );
  }
  out.push(
    make('notes', 'n', `${t}: builds a one-event-per-cycle pattern from a single degree`, [
      ['n', 3]
    ])
  );
  out.push(
    make('notes', 'n', `${t}: rejects non-integer input eagerly, at build time`, [['n', 1.5]])
  );
  out.push(
    make('notes', 'n', `${t}: rejects non-integer input eagerly, at build time`, [['n', '0 1.5']])
  );
  out.push(
    make('notes', 'scale', `${t}: leaves already-pitched events (from note()) untouched`, [
      note('c3 e3'),
      ['scale', 'C4:major']
    ])
  );
  out.push(
    make('notes', 'n', 'generated: n() over a signal with events', [
      ['n', [['sine'], ['segment', 8], ['range', 0, 7]]],
      ['scale', 'D4:major']
    ])
  );
  out.push(
    make(
      'notes',
      'chord',
      `${t}: builds a one-event-per-cycle pattern from a single chord symbol`,
      [['chord', '<Dm9 BbM7 Gm9 A7sus>'], ['voicing']]
    )
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// controls: five controls (gain, lpf, pan, attack, n) with number, string, and signal inputs
// ---------------------------------------------------------------------------------------------

const CONTROL_INPUTS: [string, (scale: number) => unknown, string][] = [
  ['number', (s) => 0.5 * s, 'src/control.test.ts: merges parameter patches across all events'],
  [
    'string',
    (s) => `${0.2 * s} ${0.8 * s}`,
    'src/control.test.ts: assigns one control step per event when the step counts match'
  ],
  [
    'alternation',
    (s) => `<${0.25 * s} ${0.72 * s}>`,
    'src/control.test.ts: alternates per cycle through <...> the same way mini-notation always does'
  ],
  [
    'rest',
    (s) => `${0.5 * s} ~`,
    'src/control.test.ts: leaves the key unset where the control has a rest'
  ],
  [
    'signal',
    () => [['sine']],
    'src/controlSignals.test.ts: books the sine at each onset on the panner'
  ],
  [
    'slow-signal',
    () => [['saw'], ['slow', 4]],
    'docs/guide/patterned-parameters.md: Patterns and signals as controls'
  ],
  [
    'random',
    () => [['rand']],
    'src/controlSignals.test.ts: gives the same sequence every time it is played, but each cycle reads its own times'
  ],
  [
    'pattern',
    () => [['mini', '0.1 0.9', 'number']],
    'src/controlSignals.test.ts: every patternable control'
  ],
  ['pure', () => [['pure', 0.3]], 'src/controlSignals.test.ts: every patternable control'],
  ['edge-zero', () => 0, 'generated: edge value zero'],
  ['edge-negative', () => -0.5, 'generated: edge value below the range'],
  ['edge-beyond', () => 3, 'generated: edge value beyond the range']
];

/** The controls recorded: the method, and a scale that keeps each control's values meaningful. */
const CONTROLS: [string, number][] = [
  ['gain', 1],
  ['lpf', 4000],
  ['pan', 1],
  ['attack', 0.1]
];

/** The base notes a control is applied to. */
const CONTROL_BASE = 'c3 e3 g3 e3';

function controls(): ProgramCase[] {
  const out: ProgramCase[] = [];
  for (const [control, scale] of CONTROLS) {
    for (const [stem, input, from] of CONTROL_INPUTS) {
      out.push(
        make('controls', `${control}-${stem}`, from, [note(CONTROL_BASE), [control, input(scale)]])
      );
    }
  }
  const nInputs: [string, unknown, string][] = [
    [
      'string',
      '0 2 4 7',
      'src/control.test.ts: parses mini-notation into multiple degree events, negatives included'
    ],
    [
      'alternation',
      '<0 3> 5',
      'src/control.test.ts: alternates per cycle through <...> the same way mini-notation always does'
    ],
    [
      'signal',
      [['sine'], ['segment', 4], ['range', 0, 7]],
      'generated: n() over a signal with events'
    ],
    [
      'floor',
      [['saw'], ['segment', 4], ['range', -2, 9]],
      'generated: n() over a signal, floored to whole degrees'
    ],
    ['number', 5, 'src/control.test.ts: builds a one-event-per-cycle pattern from a single degree'],
    [
      'negative',
      '-2 -1',
      'src/control.test.ts: parses mini-notation into multiple degree events, negatives included'
    ],
    [
      'unsegmented',
      [['sine']],
      'src/control.test.ts: n() needs events: call .segment(n) on a signal first'
    ]
  ];
  for (const [stem, input, from] of nInputs) {
    out.push(
      make('controls', `n-${stem}`, from, [
        ['n', input],
        ['scale', 'C4:major']
      ])
    );
  }
  // Scalar-only controls given a pattern are errors (the names say so in the reference's tests).
  const scalarOnly: [string, unknown][] = [
    ['orbit', [['pure', 1]]],
    ['panlaw', [['pure', -3]]],
    ['cut', [['pure', 1]]]
  ];
  for (const [control, input] of scalarOnly) {
    out.push(
      make(
        'controls',
        `${control}-pattern`,
        'src/controlSignals.test.ts: controls that stay scalar',
        [note('c3 e3'), [control, input]]
      )
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// signals: every signal and shaping method, sampled controls, mixed compositions, negative time
// ---------------------------------------------------------------------------------------------

const PERIODIC = [
  'sine',
  'cosine',
  'saw',
  'isaw',
  'tri',
  'square',
  'sine2',
  'cosine2',
  'saw2',
  'isaw2',
  'tri2',
  'square2'
];

function signals(): ProgramCase[] {
  const out: ProgramCase[] = [];
  const t = 'src/signal.test.ts';
  const withSamples = (c: ProgramCase): ProgramCase => ({ ...c, samples: DEFAULT_SAMPLES });
  const add = (stem: string, from: string, program: Program, spans?: readonly SpanText[]) =>
    out.push(withSamples({ ...make('signals', stem, from, program), spans }));
  const negative: readonly SpanText[] = [
    ['-3/2', '-1/2'],
    ['-1', '0'],
    ['0', '2'],
    ['1/3', '7/4']
  ];
  for (const name of PERIODIC) {
    add(name, `${t}: have one structureless event per query, valued at the span’s begin`, [[name]]);
    add(
      `${name}-neg`,
      `${t}: repeat every cycle from the exact phase, negative cycles included`,
      [[name]],
      negative
    );
  }
  for (const name of ['sine', 'saw', 'tri', 'square2', 'cosine']) {
    add(
      `${name}-segment`,
      'src/pattern.test.ts: gives n events per cycle, each holding the value at its onset',
      [[name], ['segment', 4]]
    );
    add(`${name}-range`, `${t}: range maps 0..1 linearly onto lo..hi, either way up`, [
      [name],
      ['range', 200, 2000]
    ]);
    add(`${name}-slow`, 'src/controlSignals.test.ts: fast and slow move the signal in time', [
      [name],
      ['slow', 4]
    ]);
    add(`${name}-fast`, 'src/controlSignals.test.ts: fast and slow move the signal in time', [
      [name],
      ['fast', 3]
    ]);
    add(
      `${name}-rev`,
      'src/pattern.test.ts: mirrors each cycle point by point: c + x reads c + 1 - x',
      [[name], ['rev']]
    );
  }
  for (const name of ['saw', 'sine', 'tri']) {
    add(`${name}-rev-segment`, 'src/pattern.test.ts: reads correctly through segment()', [
      [name],
      ['rev'],
      ['segment', 4]
    ]);
    add(
      `${name}-euclid`,
      'src/pattern.test.ts: acts as a structure: the rhythm, each event read at its onset',
      [[name], ['euclid', 3, 8]]
    );
    add(`${name}-euclid-rot`, 'src/pattern.test.ts: rotates like the discrete form', [
      [name],
      ['euclid', 3, 8, 2]
    ]);
    add(
      `${name}-every`,
      'src/controlSignals.test.ts: every picks the transformed signal on cycle 0 and the plain one after',
      [[name], ['every', 2, [['rev']]]]
    );
  }
  add('range2', `${t}: range2 maps -1..1 linearly onto lo..hi`, [['sine2'], ['range2', 0, 10]]);
  add('rangex', `${t}: rangex maps exponentially, equal ratios for equal steps`, [
    ['saw'],
    ['rangex', 100, 1600]
  ]);
  add(
    'add-number',
    'src/pattern.test.ts: applies a number to every value and keeps a signal a signal',
    [['saw'], ['add', 1]]
  );
  add(
    'mul-number',
    'src/pattern.test.ts: applies a number to every value and keeps a signal a signal',
    [['saw'], ['mul', 4]]
  );
  add(
    'sub-number',
    'src/pattern.test.ts: applies a number to every value and keeps a signal a signal',
    [['sine'], ['sub', 0.5]]
  );
  add('div-zero', 'src/pattern.test.ts: divides by zero to Infinity', [['saw'], ['div', 0]]);
  add('add-signal', 'src/pattern.test.ts: combines two signals point by point', [
    ['saw'],
    ['add', [['sine']]]
  ]);
  add(
    'add-pattern',
    'src/pattern.test.ts: reads a pattern on the right at each onset of the left: structure from the left',
    [
      ['mini', '1 2 3 4', 'number'],
      ['add', [['saw']]]
    ]
  );
  add('add-rest', 'src/pattern.test.ts: drops an event where the right side rests', [
    ['mini', '1 2 3 4', 'number'],
    ['add', [['mini', '10 ~', 'number']]]
  ]);
  add('add-bad', 'src/pattern.test.ts: rejects anything but a number or a pattern', [
    ['saw'],
    ['add', 'x']
  ]);
  add('round', 'src/pattern.test.ts: rounds and floors', [['saw'], ['mul', 8], ['round']]);
  add('floor', 'src/pattern.test.ts: rounds and floors', [['sine2'], ['mul', 8], ['floor']]);
  add('segment-bad', 'src/pattern.test.ts: rejects a count that is not positive and finite', [
    ['sine'],
    ['segment', 0]
  ]);
  add('segment-fractional', 'src/pattern.test.ts: takes a fractional count, like fast()', [
    ['saw'],
    ['segment', 2.5]
  ]);
  // random signals
  for (const name of ['rand', 'rand2', 'perlin', 'brand']) {
    add(name, `${t}: give the same values however the span is cut into queries`, [[name]]);
    add(
      `${name}-seed`,
      `${t}: defaults to 0, gives the same values for the same seed and others for another`,
      [[name], ['seed', 7]]
    );
    add(
      `${name}-segment`,
      `${t}: read each value at the event onset, so a query mid-event changes nothing`,
      [[name], ['segment', 8]]
    );
  }
  add('rand-seed-string', `${t}: takes a string seed and can be chosen again`, [
    ['rand'],
    ['seed', 'kick']
  ]);
  add(
    'irand',
    `${t}: cover their ranges: irand every integer, choose every value, brandBy its probability`,
    [
      ['irand', 8],
      ['segment', 4]
    ]
  );
  add('irand-bad', `${t}: validate their arguments`, [['irand', 0]]);
  add('choose', `${t}: derive rand2, irand, choose and brandBy from the rand stream`, [
    ['choose', 'a', 'b', 'c'],
    ['segment', 4]
  ]);
  add(
    'brandBy',
    `${t}: cover their ranges: irand every integer, choose every value, brandBy its probability`,
    [
      ['brandBy', 0.25],
      ['segment', 8]
    ]
  );
  add('brandBy-bad', `${t}: validate their arguments`, [['brandBy', 2]]);
  add('perlin-range', 'docs/recipes.md: a bass with a filter that wanders on its own', [
    ['perlin'],
    ['range', 300, 2400]
  ]);
  add(
    'rand-cycles',
    'src/controlSignals.test.ts: arrange([1, signal]) repeats the first cycle on every cycle',
    [['arrange', [1, [['rand'], ['segment', 4]]]]]
  );
  // mixed continuous and discrete compositions
  add(
    'cat-mixed',
    'src/controlSignals.test.ts: cat(saw2, pure) keeps the saw moving through its cycle',
    [['cat', [['saw2']], [['pure', 0.5]]]]
  );
  add(
    'seq-mixed',
    'src/controlSignals.test.ts: seq squeezes each signal into its half of the cycle',
    [['seq', [['saw']], [['sine']]]]
  );
  add('stack-mixed', 'src/controlSignals.test.ts: mixed continuous and discrete compositions', [
    ['stack', [['saw']], [['pure', 2]]]
  ]);
  add('timecat-mixed', 'src/controlSignals.test.ts: mixed continuous and discrete compositions', [
    [
      'timecat',
      [
        [1, [['saw']]],
        [3, [['pure', 5]]]
      ]
    ]
  ]);
  add(
    'seq-rest',
    'src/pattern.test.ts: is undefined outside a seq window, where the query has no covering event',
    [['seq', [['saw']], [['silence']]]]
  );
  add(
    'every-mixed',
    'src/controlSignals.test.ts: every picks the transformed signal on cycle 0 and the plain one after',
    [
      ['pure', 0.5],
      ['every', 2, [['add', [['saw']]]]]
    ]
  );
  add(
    'arrange-signals',
    'src/controlSignals.test.ts: signals as control values under the combinators',
    [['arrange', [2, [['saw']]], [1, [['sine']]]]]
  );
  add(
    'phase-carry',
    'src/controlSignals.test.ts: saw.fast(hz * secondsPerCycle) is the phase of an LFO running under the whole loop',
    [['saw'], ['fast', 1.5], ['segment', 4]]
  );
  add(
    'signal-in-fast-seq',
    'src/pattern.test.ts: leaves discrete patterns without a sampler through every combinator',
    [
      ['seq', [['saw']], [['saw']], [['saw']]],
      ['fast', 2]
    ]
  );
  return out;
}

/** Every layer 1 program of the first subset, in file order. */
export function layer1Programs(): ProgramCase[] {
  counter = new Map();
  return [
    ...core(),
    ...combinators(),
    ...notes(),
    ...controls(),
    ...signals(),
    ...miniCases(),
    ...scaleCases(),
    ...chordCases()
  ];
}
