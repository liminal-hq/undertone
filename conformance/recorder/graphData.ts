// Layer 3 graph cases: placement, plus the `voices` and `options` groups from their own files
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlPatch } from '../../src/types';
import type { GraphCase, OutputSetup, RenderGraphCase, VoicesGraphCase } from './graph';
import type { Program, Step } from './interpret';
import { channelsCases } from './channelsData';
import { instrumentsCases } from './instrumentsData';
import { optionsCases } from './optionsData';
import { voicesCases } from './voicesData';

/** A short held tone: the patch every placement voice starts from. */
const TONE: ControlPatch = {
  soundType: 'triangle',
  pitch: 220,
  attack: 0.01,
  decay: 0.1,
  sustain: 0.5,
  release: 0.2,
  gainLevel: 0.3,
  duration: 0.5
};

function voice(
  stem: string,
  from: string,
  patch: ControlPatch,
  extra: { baseline?: boolean; output?: OutputSetup; at?: number } = {}
): VoicesGraphCase {
  return {
    kind: 'voices',
    id: `placement-${stem}`,
    group: 'placement',
    from,
    baseline: extra.baseline,
    output: extra.output,
    voices: [{ at: extra.at ?? 0, patch: { ...TONE, ...patch } }]
  };
}

function render(
  stem: string,
  from: string,
  program: Program,
  options: RenderGraphCase['render'],
  baseline = false
): RenderGraphCase {
  return {
    kind: 'render',
    id: `placement-${stem}`,
    group: 'placement',
    from,
    baseline: baseline || undefined,
    program,
    render: { sampleRate: 1280, ...options }
  };
}

const PAN_LAW = 'src/panLaw.test.ts';
const PAN_PATH = 'src/panPath.test.ts';
const AUTOPAN = 'src/autopan.test.ts';
const MASTER = 'src/masterBus.test.ts';
const RENDER = 'src/render.test.ts';

function panLaw(): GraphCase[] {
  return [
    voice(
      'pan-default',
      `${PAN_LAW}: leaves the stereo panner graph unchanged when unset or -3`,
      { pan: 0.5 },
      { baseline: true }
    ),
    voice(
      'pan-law-minus3',
      `${PAN_LAW}: leaves the stereo panner graph unchanged when unset or -3`,
      { pan: 0.5, panLaw: -3 }
    ),
    voice(
      'pan-law-minus6',
      `${PAN_LAW}: places a panned voice with one gain per side into a two-input merger`,
      { pan: 0.5, panLaw: -6 }
    ),
    voice(
      'pan-law-minus45',
      `${PAN_LAW}: gives the documented levels at hard left, centre and hard right`,
      { pan: -0.25, panLaw: -4.5 }
    ),
    voice(
      'pan-law-0',
      `${PAN_LAW}: gives the documented levels at hard left, centre and hard right`,
      { pan: 1, panLaw: 0 }
    ),
    voice(
      'pan-law-left',
      `${PAN_LAW}: gives the documented levels at hard left, centre and hard right`,
      { pan: -1, panLaw: -6 }
    ),
    voice(
      'pan-law-centre',
      `${PAN_LAW}: gives the documented levels at hard left, centre and hard right`,
      { pan: 0, panLaw: -6 }
    ),
    voice(
      'pan-law-unpanned',
      `${PAN_LAW}: changes nothing for a voice with no pan`,
      { panLaw: -6 },
      { baseline: true }
    ),
    voice('pan-law-clamped', `${PAN_LAW}: clamps a law outside -6..0 in plain voice data`, {
      pan: 0.5,
      panLaw: -9
    }),
    voice('pan-law-channel-gains', `${PAN_LAW}: lets channelGains take precedence over the law`, {
      pan: 0.5,
      panLaw: -6,
      channelGains: [0.8, 0.2]
    })
  ];
}

function panPath(): GraphCase[] {
  return [
    voice(
      'pan-path-ramp',
      `${PAN_PATH}: books the first point at the onset, ramps to each later point and steps on a shared time`,
      {
        panPath: [
          { time: 0, pan: 1 },
          { time: 0.5, pan: -1 }
        ]
      }
    ),
    voice(
      'pan-path-jump',
      `${PAN_PATH}: books the first point at the onset, ramps to each later point and steps on a shared time`,
      {
        panPath: [
          { time: 0, pan: -0.8 },
          { time: 0.1, pan: -0.8 },
          { time: 0.1, pan: 0.8 },
          { time: 0.3, pan: 0.8 }
        ]
      }
    ),
    voice(
      'pan-path-after-release',
      `${PAN_PATH}: leaves a finished path, an unstarted voice and a plain pan alone on stop`,
      {
        duration: 0.2,
        panPath: [
          { time: 0, pan: 0.5 },
          { time: 0.1, pan: -0.5 }
        ]
      }
    ),
    voice('pan-path-law', `${PAN_LAW}: books a pan path as side gain ramps that follow the law`, {
      panLaw: -6,
      panPath: [
        { time: 0, pan: -1 },
        { time: 0.4, pan: 1 }
      ]
    }),
    voice('pan-path-single', 'generated: a pan path of one point', {
      panPath: [{ time: 0, pan: 0.3 }]
    })
  ];
}

function autopan(): GraphCase[] {
  return [
    voice(
      'autopan-sine',
      `${AUTOPAN}: is an oscillator into a depth gain into the panner pan, started and stopped with the voice`,
      { autopan: 2 }
    ),
    voice(
      'autopan-depth',
      `${AUTOPAN}: clamps the depth, wraps the phase and treats an unknown shape as a sine in voice data`,
      { autopan: 2, autopanDepth: 0.5 }
    ),
    voice('autopan-triangle', `${AUTOPAN}: uses the built-in wave for each shape at phase 0`, {
      autopan: 1,
      autopanShape: 'triangle'
    }),
    voice('autopan-square', `${AUTOPAN}: uses the built-in wave for each shape at phase 0`, {
      autopan: 1,
      autopanShape: 'square'
    }),
    voice(
      'autopan-phase-sine',
      `${AUTOPAN}: turns every harmonic of a shifted triangle or square by its share of the phase`,
      { autopan: 1, autopanPhase: 0.25 }
    ),
    voice(
      'autopan-phase-triangle',
      `${AUTOPAN}: turns every harmonic of a shifted triangle or square by its share of the phase`,
      { autopan: 1, autopanShape: 'triangle', autopanPhase: 0.5 }
    ),
    voice(
      'autopan-phase-square',
      `${AUTOPAN}: turns every harmonic of a shifted triangle or square by its share of the phase`,
      { autopan: 2, autopanShape: 'square', autopanPhase: 0.3, autopanDepth: 0.6 }
    ),
    voice(
      'autopan-pan',
      `${AUTOPAN}: keeps the panner under a pan law: scaled exactly below -3 dB, the panner law above`,
      { autopan: 1, pan: 0.5 }
    ),
    voice('autopan-path', `${AUTOPAN}: adds to a pan path, which sets the centre`, {
      autopan: 2,
      autopanDepth: 0.4,
      panPath: [
        { time: 0, pan: -0.5 },
        { time: 0.4, pan: 0.5 }
      ]
    }),
    voice(
      'autopan-law',
      `${AUTOPAN}: keeps the panner under a pan law: scaled exactly below -3 dB, the panner law above`,
      { autopan: 1, pan: 0.2, panLaw: -6 }
    ),
    voice(
      'autopan-room',
      `${AUTOPAN}: sends the room and delay from the panner, so the wet signal swings too`,
      { autopan: 1, roomLevel: 0.3, delayLevel: 0.2 }
    ),
    voice(
      'autopan-off',
      `${AUTOPAN}: adds nothing without an autopan rate`,
      { pan: 0.5 },
      { baseline: true }
    )
  ];
}

function panSlide(): GraphCase[] {
  return [
    voice(
      'pan-slide-time',
      `${AUTOPAN}: ramps from the start pan to the voice's pan over its attack`,
      { pan: 0.4, panSlideFrom: -1, panSlideTime: 0.12 }
    ),
    voice(
      'pan-slide-attack',
      `${AUTOPAN}: ramps from the start pan to the voice's pan over its attack`,
      { attack: 0.05, pan: 0.4, panSlideFrom: -1 }
    ),
    voice(
      'pan-slide-centre',
      `${AUTOPAN}: takes its own time, slides to the centre without a pan, and holds on an early stop`,
      { panSlideFrom: 1, panSlideTime: 0.2 }
    ),
    voice('pan-slide-path', `${AUTOPAN}: gives way to a pan path, warning once`, {
      panSlideFrom: 1,
      panSlideTime: 0.2,
      panPath: [
        { time: 0, pan: 0 },
        { time: 0.3, pan: 0.6 }
      ]
    })
  ];
}

function baselines(): GraphCase[] {
  const from = 'generated: a 0.3.0 voice with every 0.4.0 option off';
  return [
    voice('off-plain', from, {}, { baseline: true }),
    voice(
      'off-filter-envelope',
      from,
      { soundType: 'sawtooth', filterCutoff: 600, filterEnvAmount: 1200, filterDecay: 0.2 },
      { baseline: true }
    ),
    voice(
      'off-effects',
      from,
      { roomLevel: 0.4, roomSize: 2, delayLevel: 0.3, delayTime: 0.25, orbit: 1 },
      { baseline: true }
    ),
    voice('off-noise', from, { soundType: 'white', pan: -0.3 }, { baseline: true })
  ];
}

const note = (source: string): Step => ['note', source];

function renders(): GraphCase[] {
  const crossing: Program = [
    note('c3 e3 g3 e3'),
    ['sound', 'triangle'],
    ['attack', 0.005],
    ['sustain', 0.5],
    ['release', 0.1],
    ['gain', 0.9],
    ['pan', '-1 -0.5 0.5 1']
  ];
  const loud: Program = [note('c3 e3 g3 e3'), ['sound', 'square'], ['gain', 1.5]];
  return [
    render(
      'master-default',
      `${MASTER}: works as the output of a pattern, so voices reach the destination only through it`,
      loud,
      { cps: 1 },
      true
    ),
    render(
      'master-off',
      `${RENDER}: routes through the master bus by default and skips it with master: false`,
      loud,
      { cps: 1, master: false },
      true
    ),
    render('ceiling-6', `${MASTER}: reaches a render through its master options`, loud, {
      cps: 1,
      master: { ceiling: -6 }
    }),
    render(
      'ceiling-no-limiter',
      `${MASTER}: follows the compressor, or the input, when there is no makeup or no limiter`,
      loud,
      { cps: 1, master: { ceiling: -3, limiter: false } }
    ),
    render('ceiling-wrap', `${RENDER}: keeps the folded tail under the master ceiling`, loud, {
      cps: 1,
      tail: 0.5,
      wrap: true,
      master: { ceiling: -6 }
    }),
    render(
      'ceiling-surround',
      `${MASTER}: still clips a surround output, where the limiter is skipped`,
      [note('c3 e3'), ['gain', 1.5], ['surround', 45]],
      { cps: 1, channels: 4, master: { ceiling: -6 } }
    ),
    render(
      'window-off',
      `${RENDER}: builds exactly the graph that booking up front builds`,
      loud,
      { cps: 1, cycles: 2 },
      true
    ),
    render('window-on', `${RENDER}: builds exactly the graph that booking up front builds`, loud, {
      cps: 1,
      cycles: 2,
      bookingWindow: 0.5
    }),
    render('window-ceiling', 'generated: windowed booking with a master ceiling', loud, {
      cps: 1,
      cycles: 2,
      bookingWindow: 1,
      master: { ceiling: -6 }
    }),
    render(
      'example-panpath-step',
      'docs/.vitepress/theme/playground/examples/movingPan/panpathStep.ts',
      [
        note('c4 e4 g4 e4'),
        ['sound', 'square'],
        ['attack', 0.003],
        ['decay', 0.2],
        ['sustain', 0.5],
        ['release', 0.15],
        ['lpf', 3000],
        ['gain', 0.25],
        ['legato', 1],
        ['panpath', [-0.8, 0.8, -0.8, 0.8, -0.4, 0.4, 0], 30]
      ],
      { cps: 0.5 }
    ),
    render(
      'example-panpath-sweep',
      'docs/.vitepress/theme/playground/examples/movingPan/panpathSweep.ts',
      [
        note('a2 e3 a3 c4'),
        ['sound', 'sawtooth'],
        ['attack', 0.01],
        ['decay', 0.3],
        ['sustain', 0.6],
        ['release', 0.4],
        ['lpf', 1500],
        ['gain', 0.3],
        ['legato', 1],
        [
          'panpath',
          [
            { time: 0, pan: 1 },
            { time: 0.5, pan: -1 }
          ]
        ]
      ],
      { cps: 0.5 }
    ),
    render(
      'example-autopan-pad',
      'docs/.vitepress/theme/playground/examples/movingPan/autopanPad.ts',
      [
        ['chord', '<Dm9 Gm9>'],
        ['voicing'],
        ['sound', 'triangle'],
        ['attack', 0.4],
        ['sustain', 0.8],
        ['release', 1],
        ['lpf', 1800],
        ['gain', 0.25],
        ['room', 0.4],
        ['roomsize', 6],
        ['autopan', 0.25],
        ['autopandepth', 0.7]
      ],
      { cps: 0.25, cycles: 2, tail: 1 }
    ),
    render(
      'example-pan-law-compare',
      'docs/.vitepress/theme/playground/examples/movingPan/panLawCompare.ts',
      [
        [
          'cat',
          [...crossing, ['panlaw', -6]],
          [...crossing, ['panlaw', -3]],
          [...crossing, ['panlaw', 0]]
        ]
      ],
      { cps: 0.5, cycles: 3 }
    ),
    render(
      'example-pan-slide',
      'docs/.vitepress/theme/playground/examples/movingPan/panSlideLead.ts',
      [
        note('e4 g4 b4 a4'),
        ['sound', 'square'],
        ['gain', 0.3],
        ['pan', 0.4],
        ['panslide', -1, 0.12]
      ],
      { cps: 0.5 }
    ),
    render(
      'example-autopan-shapes',
      'docs/.vitepress/theme/playground/examples/movingPan/autopanShapes.ts',
      [
        [
          'cat',
          [
            note('c3 e3 g3 b3'),
            ['sound', 'sawtooth'],
            ['autopan', 1],
            ['autopanshape', 'triangle']
          ],
          [
            note('c3 e3 g3 b3'),
            ['sound', 'sawtooth'],
            ['autopan', 2],
            ['autopanshape', 'square'],
            ['autopandepth', 0.6]
          ],
          [note('c3 e3 g3 b3'), ['sound', 'sawtooth'], ['autopan', 1], ['autopanphase', 0.5]]
        ]
      ],
      { cps: 0.5, cycles: 3 }
    )
  ];
}

/** Every layer 3 case of the first subset, in file order. */
export function layer3Cases(): GraphCase[] {
  return [
    ...panLaw(),
    ...panPath(),
    ...autopan(),
    ...panSlide(),
    ...baselines(),
    ...renders(),
    ...voicesCases(),
    ...optionsCases(),
    ...instrumentsCases(),
    ...channelsCases()
  ];
}
