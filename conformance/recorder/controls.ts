// Layer 2: programs recorded as score events and the resolved voice parameters of each
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { encodeValue, messageOf, programJson } from './format';
import type { CaseRecord, CorpusFile, Json } from './format';
import { build } from './programs';
import type { ProgramCase } from './programs';
import type { Program } from './interpret';
import type { Reference } from './reference';

/** One layer 2 case: a program booked over a range of whole cycles at a tempo. */
export interface VoiceCase {
  id: string;
  group: string;
  from: string;
  program: Program;
  /** Whole cycles booked, from the first up to but not including the second. */
  cycles: readonly [begin: number, end: number];
  /** Cycles per second. */
  cps: number;
  /** Hold each note for its share of the cycle, as `loop()` does, or play a one-shot. */
  gated: boolean;
}

/** The groups of layer 2 in the first subset, in file order. */
export const LAYER2_GROUPS = ['notes', 'controls', 'signals'] as const;

/** The tempos and gating the derived cases cycle through, so each is exercised by every group. */
const VARIANTS: readonly { cps: number; gated: boolean }[] = [
  { cps: 0.5, gated: true },
  { cps: 1, gated: false },
  { cps: 0.8, gated: true },
  { cps: 2, gated: false }
];

/** Programs that sample a signal into a control, hand-written for the layer 2 `signals` group. */
const SIGNAL_CONTROLS: [string, string, Program][] = [
  [
    'lpf-sine',
    'docs/guide/patterned-parameters.md: Patterns and signals as controls',
    [
      ['note', 'c3*4'],
      ['lpf', [['sine'], ['range', 300, 3000]]]
    ]
  ],
  [
    'pan-sine2',
    'docs/recipes.md: Hats can drift across the field one hit at a time with a signal',
    [
      ['sound', 'white*8'],
      ['pan', [['sine2'], ['slow', 4]]]
    ]
  ],
  [
    'lpf-perlin',
    'docs/recipes.md: a bass with a filter that wanders on its own',
    [
      ['note', 'c2*8'],
      ['sound', 'sawtooth'],
      ['lpf', [['perlin'], ['range', 300, 2400]]]
    ]
  ],
  [
    'gain-rand',
    'docs/recipes.md: random accents that come out the same every time you play',
    [
      ['note', 'c3*4'],
      ['gain', [['rand'], ['seed', 7], ['range', 0.2, 0.6]]]
    ]
  ],
  [
    'pan-saw',
    'src/controlSignals.test.ts: books the sine at each onset on the panner',
    [
      ['note', 'c3 e3 g3 b3'],
      ['pan', [['saw2']]]
    ]
  ],
  [
    'pan-clamped',
    'src/controlSignals.test.ts: clamps pan to -1..1 and warns once',
    [
      ['note', 'c3 e3'],
      ['pan', [['sine'], ['mul', 3]]]
    ]
  ],
  [
    'attack-negative',
    'src/controlSignals.test.ts: clamps the low side, the start of panslide and autopandepth',
    [
      ['note', 'c3 e3'],
      ['attack', [['sine2']]]
    ]
  ],
  [
    'rest-keeps-earlier',
    'src/controlSignals.test.ts: leaves an earlier value in place where a pattern gives none',
    [
      ['note', 'c3 e3 g3 b3'],
      ['gain', 0.4],
      ['gain', [['seq', [['silence']], [['saw']]]]]
    ]
  ],
  [
    'autopan-phase',
    'src/controlSignals.test.ts: saw.fast(hz * secondsPerCycle) is the phase of an LFO running under the whole loop',
    [
      ['chord', '<Am7 Fmaj7>'],
      ['voicing'],
      ['autopan', 0.5],
      ['autopanphase', [['saw'], ['fast', 1.5]]]
    ]
  ],
  [
    'every-signal',
    'src/controlSignals.test.ts: every picks the transformed signal on cycle 0 and the plain one after',
    [
      ['note', 'c3 e3'],
      ['pan', [['saw2'], ['every', 2, [['rev']]]]]
    ]
  ],
  [
    'cat-signals',
    'src/controlSignals.test.ts: cat plays one signal per cycle, each in its own cycles',
    [
      ['note', 'c3*4'],
      [
        'lpf',
        [
          ['cat', [['saw']], [['tri']]],
          ['range', 500, 2500]
        ]
      ]
    ]
  ],
  [
    'euclid-signal',
    'src/controlSignals.test.ts: euclid on a signal is a structure: only the pulses get a value',
    [
      ['note', 'c3*8'],
      ['gain', [['sine'], ['euclid', 3, 8], ['range', 0.2, 0.6]]]
    ]
  ],
  [
    'jux-signal',
    'src/controlSignals.test.ts: jux gives the transformed side a signal-driven filter',
    [
      ['note', 'c3 e3 g3 e3'],
      ['jux', [['rev'], ['lpf', [['sine'], ['range', 400, 1600]]]]]
    ]
  ],
  [
    'lpenv-signal',
    'generated: a signal into the filter envelope amount',
    [
      ['note', 'a2*4'],
      ['lpf', 400],
      ['lpenv', [['saw'], ['range', 0, 2000]]]
    ]
  ],
  [
    'slide-signal',
    'generated: a signal into the slide time',
    [
      ['note', 'c3 e3 g3 e3'],
      ['slide', [['sine'], ['range', 0, 0.1]]]
    ]
  ],
  [
    'delay-brand',
    'generated: a random 0 or 1 into the delay send',
    [
      ['note', 'c4*8'],
      ['delay', [['brand']]]
    ]
  ],
  [
    'panslide-signal',
    'generated: panslide from a signal',
    [
      ['note', 'c3 e3'],
      ['panslide', [['saw2']], 0.1]
    ]
  ],
  [
    'autopandepth-signal',
    'src/controlSignals.test.ts: clamps the low side, the start of panslide and autopandepth',
    [
      ['note', 'c3 e3'],
      ['autopan', 1],
      ['autopandepth', [['sine2']]]
    ]
  ],
  [
    'irand-gain',
    'generated: whole numbers into a level',
    [
      ['note', 'c3*4'],
      [
        'gain',
        [
          ['irand', 4],
          ['fmap', 'mul', 0.25]
        ]
      ]
    ]
  ],
  [
    'choose-pan',
    'generated: choose into the pan',
    [
      ['note', 'c3*4'],
      ['pan', [['choose', -1, 0, 1]]]
    ]
  ]
];

/** The layer 2 cases of the first subset: the notes and controls programs of layer 1, booked, plus the signal controls above. */
export function layer2Cases(layer1: readonly ProgramCase[]): VoiceCase[] {
  const out: VoiceCase[] = [];
  let index = 0;
  for (const spec of layer1) {
    if (spec.group !== 'notes' && spec.group !== 'controls') continue;
    const variant = VARIANTS[index % VARIANTS.length];
    index += 1;
    out.push({
      id: spec.id,
      group: spec.group,
      from: spec.from,
      program: spec.program,
      cycles: [0, 2],
      ...variant
    });
  }
  SIGNAL_CONTROLS.forEach(([stem, from, program], position) => {
    out.push({
      id: `signals-${stem}`,
      group: 'signals',
      from,
      program,
      cycles: [0, 2],
      ...VARIANTS[position % VARIANTS.length]
    });
  });
  return out;
}

/** Records one layer 2 case: each onset's start time in seconds and its resolved `VoiceParams`, in booking order. */
export function recordVoices(ref: Reference, spec: VoiceCase): CaseRecord {
  const head = {
    id: spec.id,
    group: spec.group,
    from: spec.from,
    program: programJson(spec.program),
    cycles: [...spec.cycles],
    cps: spec.cps,
    gated: spec.gated
  };
  const built = build(ref, spec.program);
  if ('error' in built) return { ...head, error: built.error };
  try {
    const cycleSeconds = ref.scheduler.cycleSecondsFor(undefined, spec.cps);
    const events: Json[] = [];
    for (let cycle = spec.cycles[0]; cycle < spec.cycles[1]; cycle++) {
      const span = { begin: new ref.lib.Fraction(cycle), end: new ref.lib.Fraction(cycle + 1) };
      const voices = ref.scheduler.collectOnsets(
        built.pattern as never,
        span,
        0,
        cycleSeconds,
        spec.gated
      );
      for (const voice of voices) {
        events.push({ at: encodeValue(voice.startTime), params: encodeValue(voice.params) });
      }
    }
    return { ...head, events };
  } catch (error) {
    return { ...head, error: messageOf(error) };
  }
}

/** Records every layer 2 file of the first subset. */
export function recordLayer2(ref: Reference, cases: readonly VoiceCase[]): CorpusFile[] {
  return LAYER2_GROUPS.map((group) => ({
    layer: 2 as const,
    group,
    cases: cases.filter((spec) => spec.group === group).map((spec) => recordVoices(ref, spec))
  }));
}
