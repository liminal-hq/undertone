// The layer 4 render cases: programs and render options a browser renders for the Rust engine to match
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { RenderOptions } from '../../src/render';
import type { Program, Step } from './interpret';

/** One layer 4 case: a program rendered with real audio (a browser's `OfflineAudioContext`). */
export interface RenderCase {
  id: string;
  /** What the case exercises, and where its program comes from. */
  from: string;
  program: Program;
  render: Omit<RenderOptions, 'context'>;
  /**
   * Set only on a case that keeps a Chromium quirk on record (`R-layer4.md`). Every other case is recorded on
   * 128-frame boundaries without delay feedback (`checkRenderQuirks`), so the quirks do not apply and it is held
   * to the proposed tolerances.
   * - `delay-feedback`: the program has a delay send with feedback, and Chromium adds 128 frames to every pass through the loop.
   * - `mid-quantum-start`: a voice starts inside a render quantum, and Chromium runs its oscillator at the wrong frequency for the rest of that quantum.
   */
  quirk?: Quirk;
}

/** The two Chromium behaviours a labelled case documents. */
export type Quirk = 'delay-feedback' | 'mid-quantum-start';

/** Frames in a Web Audio render quantum. */
export const RENDER_QUANTUM = 128;

const note = (source: string): Step => ['note', source];
const sound = (type: string): Step => ['sound', type];

/** A plain voice: one waveform, a short envelope, a stereo pan, no effects. */
function voice(type: string, source = 'a2 e3 a3 e4'): Program {
  return [
    note(source),
    sound(type),
    ['attack', 0.01],
    ['decay', 0.1],
    ['sustain', 0.6],
    ['release', 0.15],
    ['gain', 0.5]
  ];
}

/**
 * The two timing setups the cases use. Every onset must land on a multiple of 128 frames (a render quantum) **and be
 * exact in a double**: with an onset such as 0.4 * 3 = 1.2000000000000002 s, Chromium puts the voice's first sample
 * one event too early (a gain event at the next instant, so the first sample is at the unset gain: a click of up to
 * full scale). So the sample rates are 2^k times a small odd number and the cycles a power of two seconds:
 * - `S49` is 49152 Hz (3 * 2^14) at one cycle a second: an eighth of a cycle is 6144 frames (48 quanta), and every onset is a multiple of 1/128 s, exact in a double.
 * - `S32` is 32768 Hz at one cycle a second: a cycle is 256 quanta, so every power-of-two division of it (down to 1/256) is whole quanta.
 */
const S49 = { sampleRate: 49152, channels: 2, cps: 1, cycles: 2, master: false } as const;
const S32 = { sampleRate: 32768, channels: 2, cps: 1, cycles: 2, master: false } as const;

/** The loud chord pattern the limiter cases share: well above full scale before the master bus. */
const LOUD: Program = [
  note('[c3,e3,g3] [e3,g3,b3]'),
  sound('sawtooth'),
  ['attack', 0.005],
  ['sustain', 0.8],
  ['release', 0.1],
  ['gain', 1.5]
];

/** A playground example, as the recorder's programs write it. */
const ACID_LINE: Program = [
  note('a1 [a1 a2] c2 <e2 g1>'),
  sound('sawtooth'),
  ['attack', 0.004],
  ['decay', 0.12],
  ['sustain', 0.25],
  ['release', 0.08],
  ['gain', 0.6],
  ['lpf', 700],
  ['jux', [['rev']]]
];

/** Four bars at one cycle a second: a bass, a chord pad, a lead, and a hat, with a reverb and a delay on the lead. */
const MIX: Program = [
  [
    'stack',
    [
      note('<c2 a1 f1 g1>*2'),
      sound('sawtooth'),
      ['attack', 0.005],
      ['decay', 0.15],
      ['sustain', 0.4],
      ['release', 0.1],
      ['gain', 0.45],
      ['lpf', 600],
      ['pan', -0.2]
    ],
    [
      note('<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>'),
      sound('triangle'),
      ['attack', 0.05],
      ['sustain', 0.7],
      ['release', 0.3],
      ['gain', 0.3],
      ['lpf', 2000],
      ['pan', 0.3]
    ],
    [
      note('~ g4 [e4 c5] ~'),
      sound('square'),
      ['attack', 0.004],
      ['decay', 0.1],
      ['sustain', 0.2],
      ['release', 0.1],
      ['gain', 0.2],
      ['lpf', 3000],
      ['room', 0.3],
      ['roomsize', 2],
      ['delay', 0.25],
      ['delaytime', 0.25],
      ['delayfeedback', 0],
      ['pan', 0.6]
    ],
    [
      sound('white*4'),
      ['attack', 0],
      ['decay', 0.03],
      ['sustain', 0],
      ['release', 0.01],
      ['gain', 0.25],
      ['hpf', 6000],
      ['pan', -0.5]
    ]
  ]
];

/** The twenty cases, each at most four seconds. */
export function renderCases(): RenderCase[] {
  return [
    ...(['sine', 'triangle', 'square', 'sawtooth'] as const).map((type) => ({
      id: `render-voice-${type}`,
      from: `a ${type} voice over four notes (A2 to E4), master bus off`,
      program: voice(type),
      render: { ...S49 }
    })),
    {
      id: 'render-voice-white',
      from: 'white noise hits through the seeded noise buffer, master bus off',
      program: [
        sound('white white ~ white'),
        ['attack', 0.002],
        ['decay', 0.1],
        ['sustain', 0],
        ['release', 0.05],
        ['gain', 0.5]
      ],
      render: { ...S49 }
    },
    {
      id: 'render-voice-pink-brown',
      from: 'pink and brown noise hits through the seeded noise buffers, master bus off',
      program: [
        sound('pink brown ~ pink'),
        ['attack', 0.002],
        ['decay', 0.1],
        ['sustain', 0],
        ['release', 0.05],
        ['gain', 0.5]
      ],
      render: { ...S32 }
    },
    {
      id: 'render-filter-sweep',
      from: 'a low-pass sweep: lpf 200 Hz opened by lpenv 5 kHz over 0.4 s on a sawtooth',
      program: [
        note('c2 g2'),
        sound('sawtooth'),
        ['attack', 0.01],
        ['sustain', 0.8],
        ['release', 0.2],
        ['gain', 0.5],
        ['lpf', 200],
        ['lpenv', 5000],
        ['lpa', 0.4],
        ['lpd', 0.05],
        ['lps', 1]
      ],
      render: { ...S32, cycles: 3 }
    },
    {
      id: 'render-envelope',
      from: 'a slow attack, a decay to half, and a long release, with the tail rendered',
      program: [
        note('c4'),
        sound('triangle'),
        ['attack', 0.2],
        ['decay', 0.3],
        ['sustain', 0.5],
        ['release', 0.8],
        ['gain', 0.6],
        ['legato', 0.5]
      ],
      render: { ...S32, cycles: 2, tail: 1 }
    },
    {
      id: 'render-reverb',
      from: 'a short pluck into the orbit reverb (room 0.5, size 2) with the tail rendered',
      program: [
        note('c4 ~ g4 ~'),
        sound('sawtooth'),
        ['attack', 0.003],
        ['decay', 0.1],
        ['sustain', 0],
        ['release', 0.05],
        ['gain', 0.4],
        ['lpf', 3000],
        ['room', 0.5],
        ['roomsize', 2]
      ],
      render: { ...S32, cycles: 2, tail: 1.5 }
    },
    {
      id: 'render-delay',
      from: 'a short pluck into the orbit delay (0.25 s, no feedback: one echo) with the tail rendered',
      program: [
        note('e4 ~ ~ ~'),
        sound('square'),
        ['attack', 0.003],
        ['decay', 0.08],
        ['sustain', 0],
        ['release', 0.05],
        ['gain', 0.4],
        ['delay', 0.5],
        ['delaytime', 0.25],
        ['delayfeedback', 0]
      ],
      render: { ...S32, cycles: 2, tail: 1 }
    },
    {
      id: 'render-quirk-delay-feedback',
      from: 'KNOWN QUIRK: a short pluck into the orbit delay with feedback 0.5; Chromium adds 128 frames to every pass through the loop',
      program: [
        note('e4 ~ ~ ~'),
        sound('square'),
        ['attack', 0.003],
        ['decay', 0.08],
        ['sustain', 0],
        ['release', 0.05],
        ['gain', 0.4],
        ['delay', 0.5],
        ['delaytime', 0.25],
        ['delayfeedback', 0.5]
      ],
      render: { ...S32, cycles: 2, tail: 1 },
      quirk: 'delay-feedback'
    },
    {
      id: 'render-quirk-mid-quantum-start',
      from: 'KNOWN QUIRK: four sine notes at 1 cycle a second at 48 kHz, so each starts 96 or 32 frames into a render quantum; Chromium runs the oscillator at the wrong frequency for the rest of that quantum',
      program: voice('sine'),
      render: { sampleRate: 48000, channels: 2, cps: 1, cycles: 2, master: false },
      quirk: 'mid-quantum-start'
    },
    {
      id: 'render-pan-law',
      from: 'notes crossing the stereo field under the -3 dB law (the playground pan-law example, one cycle)',
      program: [
        note('c3 e3 g3 e3 c4 e4 g4 e4'),
        sound('triangle'),
        ['attack', 0.005],
        ['decay', 0.2],
        ['sustain', 0.5],
        ['release', 0.1],
        ['gain', 0.35],
        ['pan', '-1 -0.5 0 0.5 1 0.5 0 -0.5'],
        ['panlaw', -3]
      ],
      render: { ...S49 }
    },
    {
      id: 'render-pan-law-6',
      from: 'the same notes under the -6 dB law',
      program: [
        note('c3 e3 g3 e3 c4 e4 g4 e4'),
        sound('triangle'),
        ['attack', 0.005],
        ['decay', 0.2],
        ['sustain', 0.5],
        ['release', 0.1],
        ['gain', 0.35],
        ['pan', '-1 -0.5 0 0.5 1 0.5 0 -0.5'],
        ['panlaw', -6]
      ],
      render: { ...S49 }
    },
    {
      id: 'render-limiter-off',
      from: 'a loud sawtooth chord pair (gain 1.5) with the master bus off, so it clips the float range',
      program: LOUD,
      render: { ...S32 }
    },
    {
      id: 'render-limiter-on',
      from: 'the same loud pair through the default master bus and its limiter',
      program: LOUD,
      render: { sampleRate: 32768, channels: 2, cps: 1, cycles: 2, tail: 0.5 }
    },
    {
      id: 'render-limiter-ceiling',
      from: 'the same loud pair through the master bus with a -6 dB ceiling',
      program: LOUD,
      render: {
        sampleRate: 32768,
        channels: 2,
        cps: 1,
        cycles: 2,
        tail: 0.5,
        master: { ceiling: -6 }
      }
    },
    {
      id: 'render-playground-acid-line',
      from: 'the playground example Acid line (120 bpm, where the playground has 150; jux rev), master bus off',
      program: ACID_LINE,
      render: { sampleRate: 49152, channels: 2, bpm: 120, cycles: 2, master: false }
    },
    {
      id: 'render-playground-acid-line-master',
      from: 'the same example through the default master bus',
      program: ACID_LINE,
      render: { sampleRate: 49152, channels: 2, bpm: 120, cycles: 2 }
    },
    {
      id: 'render-mix-four-bars',
      from: 'four bars of bass, pad, lead with reverb and an echo (no feedback), and a hat, through the default master bus',
      program: MIX,
      render: { sampleRate: 32768, channels: 2, cps: 1, cycles: 4 }
    }
  ];
}
