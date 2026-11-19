// The `instruments` group: fmVoice, fmPresets, voice(), layer(), and the shaped waves they select, as data
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlPatch } from '../../src/types';
import type { GraphCase, Instrument, OutputSetup, RenderGraphCase, VoicesGraphCase } from './graph';
import type { Program, Step } from './interpret';

const TOOLS = 'src/tools.test.ts';
const WAVES = 'src/waves.test.ts';
const FM = 'src/fm.test.ts';
const GUIDE = 'docs/guide/instruments-and-scores.md';
const GENERATED = 'generated: ';

/** The note every instrument case plays: a held e5, as the preset examples do. */
const NOTE: ControlPatch = { pitch: 'e5', duration: 0.5 };

const PRESETS = ['glassBell', 'roundBass', 'softPad', 'pluck', 'lead'] as const;

/** The definition the `fmVoice` test converts: every field set. */
const FULL_DEFINITION = {
  harmonicity: 2,
  modulationIndex: 7,
  oscillator: { type: 'triangle' },
  modulation: { type: 'square' },
  envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3 },
  modulationEnvelope: { attack: 0.02, decay: 0.1, sustain: 0.25, release: 0.05 },
  level: 0.4,
  pan: -0.3
};

function voice(
  stem: string,
  from: string,
  instrument: Instrument | undefined,
  extra: { patch?: ControlPatch; output?: OutputSetup } = {}
): VoicesGraphCase {
  return {
    kind: 'voices',
    id: `instruments-${stem}`,
    group: 'instruments',
    from,
    baseline: true,
    output: extra.output,
    voices: [{ at: 0, patch: { ...NOTE, ...extra.patch }, instrument }]
  };
}

function render(
  stem: string,
  from: string,
  program: Program,
  options: RenderGraphCase['render'] = {}
): RenderGraphCase {
  return {
    kind: 'render',
    id: `instruments-${stem}`,
    group: 'instruments',
    from,
    baseline: true,
    program,
    render: { sampleRate: 1280, cps: 1, ...options }
  };
}

const note = (source: string): Step => ['note', source];

/** The layer 3 cases: instruments booked as voices, and layered patterns rendered. */
export function instrumentsCases(): GraphCase[] {
  const out: GraphCase[] = [];
  for (const name of PRESETS) {
    out.push(
      voice(
        `preset-${name}`,
        `${TOOLS}: are frozen plain data that turn a note pattern into an FM voice (${name})`,
        { preset: name }
      )
    );
  }
  out.push(
    voice(
      'fmvoice-full',
      `${TOOLS}: converts a Tone.js-shaped definition into plain Undertone controls`,
      { fmVoice: FULL_DEFINITION }
    ),
    voice('fmvoice-no-index', `${TOOLS}: leaves FM out without a modulation index`, {
      fmVoice: { harmonicity: 3, envelope: { attack: 0.1 } }
    }),
    voice('fmvoice-index-zero', `${GENERATED}a modulation index of 0 leaves FM out`, {
      fmVoice: { harmonicity: 2, modulationIndex: 0, envelope: { decay: 0.3 } }
    }),
    voice(
      'fmvoice-empty',
      `${TOOLS}: leaves FM out without a modulation index (empty definition)`,
      {
        fmVoice: {}
      }
    ),
    voice(
      'fmvoice-index-only',
      `${GENERATED}an index without a harmonicity divides by 1 and sets no ratio`,
      { fmVoice: { modulationIndex: 4 } }
    ),
    voice(
      'fmvoice-harmonicity-only',
      `${GENERATED}a fractional harmonicity divides the index and sets the ratio`,
      { fmVoice: { harmonicity: 1.5, modulationIndex: 3 } }
    ),
    voice('fmvoice-level-pan', `${GUIDE}: level is the peak gain and pan the stereo position`, {
      fmVoice: { harmonicity: 2, modulationIndex: 2, level: 0.6, pan: 0.5 }
    }),
    voice(
      'fmvoice-shaped-carrier-and-modulator',
      `${WAVES}: set a periodic wave on the carrier, shared between notes (carrier and modulator shaped)`,
      {
        fmVoice: {
          harmonicity: 2,
          modulationIndex: 3,
          oscillator: { type: 'halfsine' },
          modulation: { type: 'abssine' }
        }
      }
    ),
    voice('fmvoice-shaped-modulator-only', `${FM}: a shaped modulator on a native carrier`, {
      fmVoice: {
        harmonicity: 1,
        modulationIndex: 2,
        oscillator: { type: 'triangle' },
        modulation: { type: 'pulsesine' }
      }
    }),
    voice('fmvoice-shaped-carrier-only', `${GENERATED}a shaped carrier with a native modulator`, {
      fmVoice: {
        harmonicity: 3,
        modulationIndex: 1,
        oscillator: { type: 'pulsesine' },
        modulation: { type: 'sawtooth' }
      }
    }),
    voice('fmvoice-shaped-no-fm', `${GENERATED}a shaped carrier with no FM at all`, {
      fmVoice: { oscillator: { type: 'abssine' } }
    }),
    voice(
      'voice-then-gain',
      `${TOOLS}: lets controls chained after voice() win`,
      { preset: 'pluck' },
      { patch: { gainLevel: 0.9 } }
    ),
    voice(
      'preset-placed',
      `${GENERATED}a preset booked on a four-channel destination, placed on the front and centre`,
      { preset: 'softPad' },
      { patch: { channelGains: [0.3, 0, 1, 0.5] }, output: { channels: 4 } }
    ),
    voice(
      'preset-sends',
      `${GENERATED}a preset with reverb and delay sends`,
      { preset: 'glassBell' },
      { patch: { roomLevel: 0.3, delayLevel: 0.2 } }
    ),
    {
      kind: 'voices',
      id: 'instruments-shared-waves',
      group: 'instruments',
      from: `${WAVES}: creates one wave per shape per context and reuses it (two FM instruments)`,
      baseline: true,
      voices: [
        {
          at: 0,
          patch: NOTE,
          instrument: {
            fmVoice: {
              harmonicity: 2,
              modulationIndex: 2,
              oscillator: { type: 'abssine' },
              modulation: { type: 'halfsine' }
            }
          }
        },
        {
          at: 0.25,
          patch: { ...NOTE, pitch: 'g5' },
          instrument: {
            fmVoice: {
              harmonicity: 2,
              modulationIndex: 2,
              oscillator: { type: 'abssine' },
              modulation: { type: 'halfsine' }
            }
          }
        }
      ]
    },
    voice(
      'fmvoice-error-harmonicity',
      `${TOOLS}: is JSON-safe and rejects bad values (harmonicity)`,
      { fmVoice: { harmonicity: 0 } }
    ),
    voice(
      'fmvoice-error-index',
      `${TOOLS}: is JSON-safe and rejects bad values (modulation index)`,
      { fmVoice: { modulationIndex: -1 } }
    ),
    render(
      'layer-stagger-levels-pans',
      `${TOOLS}: stacks the voices with a start stagger, level balance and opposite pans`,
      [
        note('a4'),
        [
          'layer',
          [{ soundType: 'square' }, { soundType: 'triangle' }],
          { stagger: 0.002, levels: [1, 0.5], pans: [-0.4, 0.4] }
        ]
      ]
    ),
    render('layer-presets', `${GUIDE}: layering a bell and a pad on one pattern of notes`, [
      note('e5 g5'),
      ['layer', [{ $preset: 'glassBell' }, { $preset: 'softPad' }], { stagger: 0.003 }]
    ]),
    render(
      'layer-velocity-levels',
      `${TOOLS}: multiplies the notes' own velocity by the layer level`,
      [
        note('a4 a4'),
        ['velocity', '1 0.25'],
        ['gain', 1],
        ['layer', [{}, {}], { levels: [1, 0.5] }]
      ]
    ),
    render('layer-own-pan', `${TOOLS}: keeps a layer's own pan when no pan is given`, [
      note('a4'),
      ['layer', [{ pan: 0.7 }]]
    ]),
    render(
      'layer-error-empty',
      `${TOOLS}: keeps a layer's own pan when no pan is given, and rejects bad input (no voices)`,
      [note('a4'), ['layer', []]]
    ),
    render(
      'layer-error-stagger',
      `${TOOLS}: keeps a layer's own pan when no pan is given, and rejects bad input (stagger)`,
      [note('a4'), ['layer', [{}], { stagger: -1 }]]
    )
  );
  return out;
}

/** A program that books `voice(patch)` after the notes: the programs of the layer 2 group, as `[stem, from, program]`. */
export function instrumentPrograms(): [string, string, Program][] {
  const out: [string, string, Program][] = [];
  for (const name of PRESETS) {
    out.push([
      `preset-${name}`,
      `${TOOLS}: are frozen plain data that turn a note pattern into an FM voice (${name})`,
      [note('e5 g5'), ['voice', { $preset: name }]]
    ]);
  }
  out.push(
    [
      'voice-then-gain',
      `${TOOLS}: lets controls chained after voice() win`,
      [note('e5'), ['voice', { $preset: 'pluck' }], ['gain', 0.9]]
    ],
    [
      'gain-then-voice',
      `${GUIDE}: fields the patch sets overwrite the events' own, so call voice() first`,
      [note('e5'), ['gain', 0.9], ['voice', { $preset: 'pluck' }]]
    ],
    [
      'fmvoice-full',
      `${TOOLS}: converts a Tone.js-shaped definition into plain Undertone controls`,
      [note('c4 e4'), ['voice', { $fmVoice: FULL_DEFINITION }]]
    ],
    [
      'fmvoice-no-index',
      `${TOOLS}: leaves FM out without a modulation index`,
      [note('c4'), ['voice', { $fmVoice: { harmonicity: 3, envelope: { attack: 0.1 } } }]]
    ],
    [
      'fmvoice-empty',
      `${TOOLS}: leaves FM out without a modulation index (empty definition)`,
      [note('c4'), ['voice', { $fmVoice: {} }]]
    ],
    [
      'fmvoice-index-only',
      `${GENERATED}an index without a harmonicity divides by 1`,
      [note('c4 g4'), ['voice', { $fmVoice: { modulationIndex: 4 } }]]
    ],
    [
      'fmvoice-index-zero',
      `${GENERATED}a modulation index of 0 leaves FM out, with the modulator's envelope unused`,
      [
        note('c4'),
        [
          'voice',
          { $fmVoice: { modulationIndex: 0, harmonicity: 2, modulationEnvelope: { attack: 0.1 } } }
        ]
      ]
    ],
    [
      'fmvoice-shaped',
      `${WAVES}: set a periodic wave on the carrier (shaped carrier and modulator)`,
      [
        note('c3 e3'),
        [
          'voice',
          {
            $fmVoice: {
              harmonicity: 2,
              modulationIndex: 3,
              oscillator: { type: 'halfsine' },
              modulation: { type: 'abssine' }
            }
          }
        ]
      ]
    ],
    [
      'fmvoice-level-pan',
      `${GUIDE}: level is the peak gain and pan the stereo position`,
      [note('c4'), ['voice', { $fmVoice: { level: 0.6, pan: 0.5, modulationIndex: 1 } }]]
    ],
    [
      'fmvoice-error-harmonicity',
      `${TOOLS}: is JSON-safe and rejects bad values (harmonicity)`,
      [note('c4'), ['voice', { $fmVoice: { harmonicity: 0 } }]]
    ],
    [
      'fmvoice-error-index',
      `${TOOLS}: is JSON-safe and rejects bad values (modulation index)`,
      [note('c4'), ['voice', { $fmVoice: { modulationIndex: -1 } }]]
    ],
    [
      'voice-plain-patch',
      `${GUIDE}: a patch is plain data, saved and reloaded`,
      [note('c4 e4 g4'), ['voice', { soundType: 'square', attack: 0.1, filterCutoff: 900 }]]
    ],
    [
      'voice-empty-patch',
      `${GENERATED}an empty patch changes nothing`,
      [note('c4 e4'), ['voice', {}]]
    ],
    [
      'voice-twice',
      `${GENERATED}the later patch overwrites the fields of the earlier one`,
      [note('c4'), ['voice', { $preset: 'glassBell' }], ['voice', { $preset: 'roundBass' }]]
    ],
    [
      'layer-stagger-levels-pans',
      `${TOOLS}: stacks the voices with a start stagger, level balance and opposite pans`,
      [
        note('a4'),
        [
          'layer',
          [{ soundType: 'square' }, { soundType: 'triangle' }],
          { stagger: 0.002, levels: [1, 0.5], pans: [-0.4, 0.4] }
        ]
      ]
    ],
    [
      'layer-own-pan',
      `${TOOLS}: keeps a layer's own pan when no pan is given`,
      [note('a4'), ['layer', [{ pan: 0.7 }]]]
    ],
    [
      'layer-short-arrays',
      `${GENERATED}levels and pans shorter than the voices: missing entries use the defaults`,
      [
        note('a4 c5'),
        [
          'layer',
          [{}, { soundType: 'square' }, { soundType: 'sawtooth' }],
          { levels: [0.5], pans: [-1, 1] }
        ]
      ]
    ],
    [
      'layer-stagger-nudge',
      `${TOOLS}: adds the stagger to nudges the notes already carry`,
      [note('a4'), ['nudge', 0.01], ['layer', [{}, {}], { stagger: 0.002 }]]
    ],
    [
      'layer-stagger-zero-nudge',
      `${TOOLS}: keeps them when stagger is 0`,
      [note('a4'), ['nudge', 0.01], ['layer', [{}]]]
    ],
    [
      'layer-drift',
      `${TOOLS}: keeps timing from drift() when wrapped around it`,
      [
        note('a4*2'),
        ['drift', { seed: 'x', timing: 0.02 }],
        ['layer', [{ soundType: 'square' }, {}], { stagger: 0.001 }]
      ]
    ],
    [
      'layer-velocity',
      `${TOOLS}: multiplies the notes' own velocity by the layer level`,
      [
        note('a4 a4'),
        ['velocity', '1 0.25'],
        ['gain', 1],
        ['layer', [{}, {}], { levels: [1, 0.5] }]
      ]
    ],
    [
      'layer-inherit',
      `${TOOLS}: lets a layer voice override the notes, but inherits what it does not set`,
      [note('a4'), ['sound', 'sawtooth'], ['layer', [{ soundType: 'square' }, {}]]]
    ],
    [
      'layer-presets',
      `${GUIDE}: layering a bell and a pad on one pattern of notes`,
      [
        note('e5 g5'),
        ['layer', [{ $preset: 'glassBell' }, { $preset: 'softPad' }], { stagger: 0.003 }]
      ]
    ],
    [
      'layer-then-gain',
      `${GENERATED}a control after layer() applies to every layer`,
      [note('a4'), ['layer', [{}, { soundType: 'square' }], { levels: [1, 0.5] }], ['gain', 0.3]]
    ],
    [
      'layer-error-empty',
      `${TOOLS}: keeps a layer's own pan when no pan is given, and rejects bad input (no voices)`,
      [note('a4'), ['layer', []]]
    ],
    [
      'layer-error-stagger',
      `${TOOLS}: keeps a layer's own pan when no pan is given, and rejects bad input (stagger)`,
      [note('a4'), ['layer', [{}], { stagger: -1 }]]
    ]
  );
  return out;
}
