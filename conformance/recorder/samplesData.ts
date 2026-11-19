// Layer 3 `samples` group: sample voices (a buffer source with its playback rate) booked from a registry of decoded PCM
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlPatch } from '../../src/types';
import type { GraphCase, OutputSetup, RenderGraphCase, SampleSpec, VoicesGraphCase } from './graph';
import type { Program } from './interpret';

const ENGINE = 'src/engine.test.ts: sample voices';
const SAMPLES = 'src/samples.test.ts';
const RENDER = 'src/render.test.ts';
const GUIDE = 'docs/guide/samples.md';
const GENERATED = 'generated: ';

/** `length` samples of a decaying sine at `cycles` periods, rounded so the case files stay readable. */
function tone(length: number, cycles: number, level = 0.8): number[] {
  return Array.from({ length }, (_, i) =>
    Number(
      (level * Math.sin((2 * Math.PI * cycles * i) / length) * (1 - i / (length * 1.5))).toFixed(6)
    )
  );
}

/** A sample of `channels` channels whose channels differ, so a mix-up of channels is a difference in the graph. */
function pcm(
  name: string,
  sampleRate: number,
  channels: number,
  extra: { baseNote?: string | number; before?: number; length?: number } = {}
): SampleSpec {
  const length = extra.length ?? 16;
  return {
    name,
    sampleRate,
    channels: Array.from({ length: channels }, (_, c) => tone(length, 1 + c, 0.8 - c * 0.15)),
    ...(extra.baseNote === undefined ? {} : { baseNote: extra.baseNote }),
    ...(extra.before === undefined ? {} : { before: extra.before })
  };
}

const MONO = (name = 'bd', extra: Parameters<typeof pcm>[3] = {}): SampleSpec =>
  pcm(name, 44100, 1, extra);

interface Extra {
  output?: OutputSetup;
  clearBefore?: number[];
}

function voices(
  stem: string,
  from: string,
  registry: SampleSpec[],
  list: { at: number; patch: ControlPatch }[],
  extra: Extra = {}
): VoicesGraphCase {
  return {
    kind: 'voices',
    id: `samples-${stem}`,
    group: 'samples',
    from,
    baseline: true,
    output: extra.output,
    registry,
    clearBefore: extra.clearBefore,
    voices: list
  };
}

/** One sample voice with `patch` (merged over `sampleName`). */
function hit(
  stem: string,
  from: string,
  registry: SampleSpec[],
  patch: ControlPatch,
  extra: Extra = {}
): VoicesGraphCase {
  return voices(stem, from, registry, [{ at: 0, patch: { sampleName: 'bd', ...patch } }], extra);
}

function rate(): GraphCase[] {
  const from = `${ENGINE}: computes playbackRate from pitch relative to the sample's registered baseNote`;
  return [
    hit(
      'plain',
      `${ENGINE}: builds a buffer source (not an oscillator) using the registered sample, at playbackRate 1 for an unpitched hit`,
      [MONO()],
      {}
    ),
    hit(
      'default-base-note-same',
      `${ENGINE}: assumes a c4 baseNote when the registered sample sets none`,
      [MONO()],
      {
        pitch: 'c4'
      }
    ),
    hit(
      'default-base-note-fifth',
      `${ENGINE}: assumes a c4 baseNote when the registered sample sets none`,
      [MONO('piano')],
      {
        sampleName: 'piano',
        pitch: 'g4'
      }
    ),
    hit('pitch-octave-up', from, [MONO()], { pitch: 'c5' }),
    hit('pitch-octave-down', from, [MONO()], { pitch: 'c3' }),
    hit('pitch-major-third', from, [MONO('piano', { baseNote: 'c4' })], {
      sampleName: 'piano',
      pitch: 'e4'
    }),
    hit('base-note-custom-same', from, [MONO('bass', { baseNote: 'a2' })], {
      sampleName: 'bass',
      pitch: 'a2'
    }),
    hit('base-note-custom-above', from, [MONO('bass', { baseNote: 'a2' })], {
      sampleName: 'bass',
      pitch: 'a3'
    }),
    hit('base-note-custom-below', from, [MONO('lead', { baseNote: 'a5' })], {
      sampleName: 'lead',
      pitch: 'e4'
    }),
    hit('base-note-sharp', from, [MONO('pad', { baseNote: 'f#3' })], {
      sampleName: 'pad',
      pitch: 'd4'
    }),
    hit(
      'base-note-ignored-unpitched',
      `${GUIDE}: declares the pitch the recording actually sounds at`,
      [MONO('bass', { baseNote: 'a2' })],
      { sampleName: 'bass' }
    ),
    hit(
      'base-note-hertz',
      `${GENERATED}a baseNote given as a frequency`,
      [MONO('tuned', { baseNote: 220 })],
      {
        sampleName: 'tuned',
        pitch: 440
      }
    ),
    hit('pitch-hertz', `${GENERATED}a pitch given as a frequency`, [MONO()], { pitch: 523.25 })
  ];
}

function controls(): GraphCase[] {
  return [
    hit(
      'gate-holds',
      `${ENGINE}: defaults to a sustain of 1 so a gated sample holds for its note length`,
      [MONO()],
      { duration: 0.5 }
    ),
    hit(
      'sustain-explicit',
      `${ENGINE}: an explicit sustain still overrides the sample default`,
      [MONO()],
      {
        sustain: 0,
        duration: 0.5
      }
    ),
    hit(
      'long-gate-no-loop',
      `${GENERATED}a gate far longer than the buffer: a sample never loops, only noise does`,
      [MONO()],
      { duration: 4 }
    ),
    hit('envelope', `${GENERATED}attack, decay, and release shaped around a sample`, [MONO()], {
      attack: 0.05,
      decay: 0.2,
      sustain: 0.5,
      release: 0.4,
      duration: 0.6
    }),
    hit('gain-and-velocity', `${GENERATED}gain and velocity scale the sample's level`, [MONO()], {
      gainLevel: 0.4,
      velocity: 0.5
    }),
    hit('nudge', `${GENERATED}a nudge moves the whole voice`, [MONO()], { nudgeTime: 0.125 }),
    hit('pitch-curve-ignored', `src/pitchCurve.test.ts: is ignored by sample voices`, [MONO()], {
      pitch: 'e4',
      pitchEnvAmount: 7,
      slideTime: 0.1,
      pitchSteps: [0, 5, 7],
      fmIndex: 3
    }),
    hit('filter', `${GENERATED}a low-pass with its envelope after a sample`, [MONO()], {
      filterCutoff: 800,
      filterEnvAmount: 1200,
      filterDecay: 0.2,
      duration: 0.5
    }),
    hit('highpass-phaser', `${GENERATED}a high-pass and a phaser after a sample`, [MONO()], {
      hpfCutoff: 300,
      phaserRate: 0.5
    }),
    hit('pan', `${GENERATED}a stereo pan on a sample voice`, [MONO()], { pan: -0.5 }),
    hit('pan-path', `${GENERATED}pan automation inside a sample voice`, [MONO()], {
      panPath: [
        { time: 0, pan: -1 },
        { time: 0.3, pan: 1 }
      ]
    }),
    hit('room-send', `${GENERATED}a reverb send from a sample`, [MONO()], {
      roomLevel: 0.4,
      roomSize: 3
    }),
    hit('delay-send', `${GENERATED}a delay send from a sample`, [MONO()], {
      delayLevel: 0.5,
      delayTime: 0.25,
      delayFeedback: 0.4
    }),
    hit('orbit-sends', `${GENERATED}sends to the second orbit`, [MONO()], {
      roomLevel: 0.3,
      delayLevel: 0.3,
      orbit: 1
    }),
    voices(
      'cut-group',
      `${GENERATED}a second sample cuts the first in the same cut group`,
      [MONO('bd'), MONO('sd')],
      [
        { at: 0, patch: { sampleName: 'bd', cutGroup: 1, release: 1 } },
        { at: 0.25, patch: { sampleName: 'sd', cutGroup: 1 } }
      ]
    ),
    hit(
      'master-bus',
      `${GENERATED}a sample through the master bus`,
      [MONO()],
      { pitch: 'g3' },
      { output: { master: true } }
    )
  ];
}

function buffers(): GraphCase[] {
  return [
    hit(
      'mono',
      `${ENGINE}: builds a buffer source using the registered sample`,
      [pcm('bd', 44100, 1)],
      {}
    ),
    hit('stereo', `${GENERATED}a stereo buffer`, [pcm('bd', 44100, 2)], {}),
    hit('three-channels', `${GENERATED}a three-channel buffer`, [pcm('bd', 44100, 3)], {}),
    hit('one-frame', `${GENERATED}a buffer of one frame`, [MONO('bd', { length: 1 })], {}),
    hit(
      'rate-lower',
      `${GENERATED}a sample recorded at a lower rate than the context`,
      [pcm('bd', 22050, 1)],
      {
        pitch: 'e4'
      }
    ),
    hit(
      'rate-higher',
      `${GENERATED}a sample recorded at a higher rate than the context`,
      [pcm('bd', 96000, 2)],
      {
        pitch: 'e4'
      }
    ),
    hit(
      'rate-same-as-context',
      `${GENERATED}a sample at the context's rate`,
      [pcm('bd', 44100, 1)],
      {}
    ),
    voices(
      'shared-buffer',
      `${SAMPLES}: caches the decoded buffer per context`,
      [MONO('bd')],
      [
        { at: 0, patch: { sampleName: 'bd' } },
        { at: 0.25, patch: { sampleName: 'bd', pitch: 'g4' } },
        { at: 0.5, patch: { sampleName: 'bd', pitch: 'c3' } }
      ]
    ),
    voices(
      'two-samples',
      `${GENERATED}two different samples get two buffers, numbered in the order the nodes use them`,
      [MONO('bd'), pcm('sd', 48000, 2)],
      [
        { at: 0, patch: { sampleName: 'sd' } },
        { at: 0.25, patch: { sampleName: 'bd' } },
        { at: 0.5, patch: { sampleName: 'sd' } }
      ]
    ),
    voices(
      'with-wave-and-noise',
      `${GENERATED}a sample, a shaped wave, a plain oscillator, and noise in one score`,
      [MONO('bd')],
      [
        { at: 0, patch: { pitch: 'c3', soundType: 'halfsine' } },
        { at: 0.125, patch: { sampleName: 'bd' } },
        { at: 0.25, patch: { pitch: 'e3', soundType: 'triangle' } },
        { at: 0.375, patch: { soundType: 'white', release: 0.1 } },
        { at: 0.5, patch: { sampleName: 'bd', pitch: 'g4' } }
      ]
    ),
    voices(
      'sample-takes-precedence',
      `${ENGINE}: sampleName takes precedence over soundType when both are set`,
      [MONO('bd')],
      [{ at: 0, patch: { sampleName: 'bd', soundType: 'triangle', pitch: 'e4' } }]
    )
  ];
}

function missing(): GraphCase[] {
  return [
    hit(
      'unregistered',
      `${ENGINE}: skips the voice entirely, with no nodes created at all, for an unregistered sample name`,
      [],
      { sampleName: 'nope' }
    ),
    voices(
      'unregistered-among-voices',
      `${SAMPLES}: warns once and skips (returns undefined) for an unregistered name`,
      [MONO('bd')],
      [
        { at: 0, patch: { sampleName: 'bd' } },
        { at: 0.25, patch: { sampleName: 'ghost' } },
        { at: 0.5, patch: { sampleName: 'ghost', pitch: 'e4' } },
        { at: 0.75, patch: { sampleName: 'bd' } }
      ]
    ),
    hit('cut-group-alone', `${GENERATED}a lone sample voice in a cut group`, [MONO('bd')], {
      sampleName: 'bd',
      cutGroup: 1,
      release: 2
    }),
    voices(
      'skipped-leaves-cut-group',
      `${GENERATED}a skipped sample voice does not cut the voice that really plays`,
      [],
      [
        { at: 0, patch: { pitch: 'c3', cutGroup: 1, release: 2 } },
        { at: 0.25, patch: { sampleName: 'ghost', cutGroup: 1 } }
      ]
    )
  ];
}

function banks(): GraphCase[] {
  return [
    hit(
      'bank-prefers-banked',
      `${ENGINE}: uses the bank-prefixed sample when it is registered`,
      [MONO('bd'), pcm('RolandTR707_bd', 44100, 2)],
      { sampleBank: 'RolandTR707' }
    ),
    hit(
      'bank-falls-back',
      `${SAMPLES}: falls back to the bare name when the banked key is not registered`,
      [MONO('bd')],
      { sampleBank: 'RolandTR707' }
    ),
    hit(
      'bank-only-banked',
      `${SAMPLES}: is true when the bank-prefixed key is registered, even if the bare name is not`,
      [pcm('RolandTR707_bd', 22050, 1, { baseNote: 'a3' })],
      { sampleBank: 'RolandTR707', pitch: 'a4' }
    ),
    hit(
      'bank-neither',
      `${GENERATED}a bank with neither the banked nor the bare name registered`,
      [MONO('sd')],
      { sampleBank: 'RolandTR707' }
    )
  ];
}

function clearing(): GraphCase[] {
  const from = `${SAMPLES}: empties the registry so a previously-registered name is unregistered again`;
  return [
    voices(
      'clear-before-first-voice',
      from,
      [MONO('bd')],
      [{ at: 0, patch: { sampleName: 'bd' } }],
      { clearBefore: [0] }
    ),
    voices(
      'clear-after-play-keeps-decoded-buffer',
      `${GENERATED}clearSamples() empties the registry, but a buffer this context already decoded still plays, at the default base note`,
      [MONO('bd', { baseNote: 'a2' })],
      [
        { at: 0, patch: { sampleName: 'bd', pitch: 'a3' } },
        { at: 0.25, patch: { sampleName: 'bd', pitch: 'a3' } }
      ],
      { clearBefore: [1] }
    ),
    voices(
      'clear-then-never-played-stays-skipped',
      `${GENERATED}clearSamples() before a name was ever played on the context makes it unregistered`,
      [MONO('bd'), MONO('sd')],
      [
        { at: 0, patch: { sampleName: 'bd' } },
        { at: 0.25, patch: { sampleName: 'sd' } }
      ],
      { clearBefore: [1] }
    ),
    voices(
      'register-again-after-clear',
      `${GENERATED}a name registered again after a clear keeps the buffer the context already decoded`,
      [MONO('bd'), pcm('bd', 22050, 2, { before: 1 })],
      [
        { at: 0, patch: { sampleName: 'bd' } },
        { at: 0.25, patch: { sampleName: 'bd' } }
      ],
      { clearBefore: [1] }
    ),
    voices(
      'register-late',
      `${GENERATED}a sample registered between two voices plays from then on`,
      [MONO('bd', { before: 1 })],
      [
        { at: 0, patch: { sampleName: 'bd' } },
        { at: 0.25, patch: { sampleName: 'bd' } }
      ]
    ),
    voices(
      'register-replace-before-play',
      `${GENERATED}a name registered twice before it plays uses the later registration`,
      [MONO('bd'), pcm('bd', 22050, 2, { baseNote: 'a3' })],
      [{ at: 0, patch: { sampleName: 'bd', pitch: 'a4' } }]
    )
  ];
}

function sendsAndPlacement(): GraphCase[] {
  return [
    voices(
      'multichannel',
      `${GENERATED}channel gains on a sample voice at four channels`,
      [pcm('bd', 44100, 2)],
      [{ at: 0, patch: { sampleName: 'bd', channelGains: [1, 0.5, 0.25, 0] } }],
      { output: { channels: 4 } }
    ),
    voices(
      'mono-destination',
      `${GENERATED}a stereo sample into a one-channel destination`,
      [pcm('bd', 44100, 2)],
      [{ at: 0, patch: { sampleName: 'bd', pan: 0.5 } }],
      { output: { channels: 1 } }
    )
  ];
}

const program = (...steps: Program): Program => steps;

function render(
  stem: string,
  from: string,
  registry: SampleSpec[],
  steps: Program,
  options: RenderGraphCase['render']
): RenderGraphCase {
  return {
    kind: 'render',
    id: `samples-${stem}`,
    group: 'samples',
    from,
    // A render without a booking window is a 0.3.0 behaviour; the window is new in 0.4.0.
    ...(options.bookingWindow === undefined ? { baseline: true } : {}),
    program: program(...steps),
    render: options,
    registry
  };
}

function renders(): GraphCase[] {
  return [
    render(
      'render-s-pattern',
      `${GUIDE}: s('bd sd hh') puts samples on the pattern`,
      [MONO('bd'), pcm('sd', 48000, 2), MONO('hh', { length: 8 })],
      [['s', 'bd sd hh sd']],
      { cps: 1, cycles: 2 }
    ),
    render(
      'render-pitched',
      `${GUIDE}: note('e1 g1').s('bass') plays one recording across a melody`,
      [MONO('bass', { baseNote: 'c2' })],
      [
        ['note', 'e2 g2 c3 ~'],
        ['s', 'bass']
      ],
      { cps: 1, cycles: 2, sampleRate: 22050 }
    ),
    render(
      'render-bank',
      `${GUIDE}: .bank(name) tries the banked name before the bare name`,
      [MONO('bd'), pcm('TR707_bd', 44100, 2)],
      [
        ['s', 'bd bd'],
        ['bank', 'TR707']
      ],
      { cps: 1, cycles: 1 }
    ),
    render(
      'render-missing-among-samples',
      `${RENDER}: ignores a sample that is not available when it works out the last room size`,
      [MONO('bd')],
      [
        [
          'stack',
          [
            ['s', 'bd ~ ghost ~'],
            ['room', 0.4],
            ['roomsize', 5]
          ],
          [
            ['note', 'c3 ~ ~ ~'],
            ['room', 0.4],
            ['roomsize', 2]
          ]
        ]
      ],
      { cps: 1, cycles: 2, bookingWindow: 0.5 }
    ),
    render(
      'render-windowed-samples',
      `${RENDER}: books samples in windows as booking up front does`,
      [MONO('bd'), pcm('sd', 48000, 2)],
      [['s', 'bd sd bd sd']],
      { cps: 1, cycles: 2, tail: 0.5, bookingWindow: 0.5 }
    ),
    render(
      'render-seed-and-master',
      `${GENERATED}samples with a seed and a ceiling on the master bus`,
      [MONO('bd')],
      [
        ['s', 'bd bd'],
        ['gain', 1.5]
      ],
      { cps: 1, cycles: 1, seed: 3, master: { ceiling: -6 } }
    ),
    render(
      'render-unregistered',
      `${RENDER}: a pattern whose samples are all missing books nothing`,
      [],
      [['s', 'ghost ghost']],
      { cps: 1, cycles: 1 }
    )
  ];
}

/** The `samples` group: sample voices from decoded PCM, and the registry they are booked from. */
export function samplesCases(): GraphCase[] {
  // Pan paths and the master ceiling are 0.4.0 features, so those two cases are not 0.3.0 baselines.
  const options = (spec: GraphCase): GraphCase =>
    spec.id === 'samples-pan-path' || spec.id === 'samples-render-seed-and-master'
      ? { ...spec, baseline: false }
      : spec;
  return [
    ...rate(),
    ...controls(),
    ...buffers(),
    ...missing(),
    ...banks(),
    ...clearing(),
    ...sendsAndPlacement(),
    ...renders()
  ].map(options);
}
