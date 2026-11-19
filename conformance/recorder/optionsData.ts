// Layer 3 `options` group: the 0.4.0 options at their corners, recorded with the options on
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlPatch } from '../../src/types';
import type { GraphCase, OutputSetup, RenderGraphCase, VoicesGraphCase } from './graph';
import type { Program, Step } from './interpret';

const PAN_LAW = 'src/panLaw.test.ts';
const PAN_PATH = 'src/panPath.test.ts';
const AUTOPAN = 'src/autopan.test.ts';
const MASTER = 'src/masterBus.test.ts';
const RENDER = 'src/render.test.ts';
const GENERATED = 'generated: ';

/** A short held tone, the patch every options voice starts from. */
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
  output?: OutputSetup
): VoicesGraphCase {
  return {
    kind: 'voices',
    id: `options-${stem}`,
    group: 'options',
    from,
    output,
    voices: [{ at: 0, patch: { ...TONE, ...patch } }]
  };
}

function render(
  stem: string,
  from: string,
  program: Program,
  options: RenderGraphCase['render']
): RenderGraphCase {
  return {
    kind: 'render',
    id: `options-${stem}`,
    group: 'options',
    from,
    program,
    render: { sampleRate: 1280, ...options }
  };
}

function panLaws(): GraphCase[] {
  const levels = `${PAN_LAW}: gives the documented levels at hard left, centre and hard right`;
  return [
    voice('law-minus6-hard-right', levels, { pan: 1, panLaw: -6 }),
    voice('law-minus1-5-centre', levels, { pan: 0, panLaw: -1.5 }),
    voice('law-0-centre', levels, { pan: 0, panLaw: 0 }),
    voice(
      'law-minus3-stays-panner',
      `${PAN_LAW}: leaves the stereo panner graph unchanged when unset or -3`,
      {
        pan: 0.25,
        panLaw: -3
      }
    ),
    voice('law-not-finite', `${GENERATED}a pan law that is not a number is the plain panner`, {
      pan: 0.5,
      panLaw: Number.NaN
    }),
    voice(
      'law-custom-mono-destination',
      `${GENERATED}a custom law on a mono destination: the merger sums to mono (the documented limit)`,
      {
        pan: 0.5,
        panLaw: -6
      },
      { channels: 1 }
    ),
    voice(
      'law-path-cap-knee',
      `${PAN_LAW}: books a pan path as side gain ramps that follow the law`,
      {
        panLaw: 0,
        panPath: [
          { time: 0, pan: -1 },
          { time: 0.5, pan: 1 }
        ]
      }
    ),
    voice(
      'law-autopan-scaled',
      `${AUTOPAN}: keeps the panner under a pan law: scaled exactly below -3 dB, the panner law above`,
      {
        pan: 0.2,
        panLaw: -5,
        autopan: 2
      }
    ),
    voice(
      'law-autopan-above-minus3',
      `${AUTOPAN}: keeps the panner under a pan law: scaled exactly below -3 dB, the panner law above`,
      {
        pan: 0.2,
        panLaw: -1,
        autopan: 2
      }
    )
  ];
}

function ceilings(): GraphCase[] {
  const loud: ControlPatch = { gainLevel: 1.4 };
  return [
    voice(
      'ceiling-0',
      `${MASTER}: puts a clip after the makeup compensation, as the last stage before the output`,
      loud,
      {
        master: { ceiling: 0 }
      }
    ),
    voice(
      'ceiling-no-limiter',
      `${MASTER}: follows the compressor, or the input, when there is no makeup or no limiter`,
      loud,
      {
        master: { ceiling: -9, limiter: false }
      }
    ),
    voice(
      'ceiling-surround',
      `${MASTER}: still clips a surround output, where the limiter is skipped`,
      {
        gainLevel: 1.4,
        channelGains: [1, 1, 0, 0]
      },
      { master: { ceiling: -6 }, channels: 4 }
    ),
    voice(
      'ceiling-above-full-scale',
      `${MASTER}: rejects a ceiling above full scale or not a level`,
      loud,
      {
        master: { ceiling: 3 }
      }
    ),
    voice(
      'ceiling-not-a-level',
      `${MASTER}: rejects a ceiling above full scale or not a level`,
      loud,
      {
        master: { ceiling: Number.NaN }
      }
    )
  ];
}

function panPaths(): GraphCase[] {
  return [
    voice(
      'path-later-first-point',
      `${PAN_PATH}: holds a later first point from the onset, clamps pans and keeps times running forwards`,
      {
        panPath: [
          { time: 0.2, pan: 3 },
          { time: 0.1, pan: -3 }
        ]
      }
    ),
    voice(
      'path-empty',
      `${PAN_PATH}: leaves the plain pan alone without a path, and treats an empty path as none`,
      {
        pan: 0.4,
        panPath: []
      }
    ),
    voice('path-channel-gains', `${PAN_PATH}: is ignored when channelGains is set`, {
      channelGains: [0.5, 1],
      panPath: [
        { time: 0, pan: -1 },
        { time: 0.3, pan: 1 }
      ]
    })
  ];
}

function panSlides(): GraphCase[] {
  const from = `${AUTOPAN}: takes its own time, slides to the centre without a pan, and holds on an early stop`;
  return [
    voice('slide-zero-time', from, { panSlideFrom: -1, panSlideTime: 0 }),
    voice('slide-longer-than-note', from, { panSlideFrom: -1, pan: 1, panSlideTime: 2 }),
    voice('slide-autopan', `${AUTOPAN}: is the centre of an autopan, and follows a pan law`, {
      panSlideFrom: -1,
      pan: 0.5,
      panSlideTime: 0.2,
      autopan: 1
    })
  ];
}

function autopans(): GraphCase[] {
  const clamps = `${AUTOPAN}: clamps the depth, wraps the phase and treats an unknown shape as a sine in voice data`;
  return [
    voice('autopan-depth-clamped', clamps, { autopan: 2, autopanDepth: 5 }),
    voice('autopan-unknown-shape', clamps, {
      autopan: 2,
      autopanShape: 'ramp' as unknown as 'sine'
    }),
    voice('autopan-phase-wrapped', clamps, {
      autopan: 2,
      autopanShape: 'triangle',
      autopanPhase: 1.25
    }),
    voice('autopan-rate-zero', `${AUTOPAN}: adds nothing without an autopan rate`, {
      autopan: 0,
      pan: 0.2
    }),
    voice('autopan-channel-gains', `${AUTOPAN}: lets channelGains take precedence`, {
      autopan: 2,
      channelGains: [1, 0.3]
    })
  ];
}

const note = (source: string): Step => ['note', source];
const stack = (...parts: Program[]): Program => [['stack', ...parts]];

function windows(): GraphCase[] {
  const same = (what: string) => `${RENDER}: books ${what} as booking up front does`;
  const loud: Program = [note('c3 e3 g3 e3'), ['sound', 'square'], ['gain', 1.5]];
  return [
    render(
      'window-skipped-voice-room-size',
      `${RENDER}: ignores a sample that is not available when it works out the last room size`,
      stack(
        [note('c3 ~ ~ ~'), ['room', 0.5], ['roomsize', 2]],
        [
          ['s', '~ ~ ghost ~'],
          ['room', 0.5],
          ['roomsize', 8]
        ]
      ),
      { cps: 1, cycles: 4, bookingWindow: 0.5 }
    ),
    render(
      'window-last-room-size',
      `${RENDER}: keeps each orbit's last booked room size, as booking up front does`,
      stack(
        [note('c3 e3 ~ ~'), ['room', 0.5], ['roomsize', 2]],
        [note('~ ~ g3 b3'), ['room', 0.5], ['roomsize', 6]]
      ),
      { cps: 1, cycles: 4, bookingWindow: 1 }
    ),
    render(
      'window-cut-groups',
      same('cut groups choking across windows'),
      stack(
        [note('c3 e3'), ['release', 2], ['cut', 1]],
        [note('~ g3'), ['release', 2], ['cut', 1]]
      ),
      { cps: 1, cycles: 4, tail: 1, bookingWindow: 0.5 }
    ),
    render(
      'window-missing-sample-cut',
      same('a cut group a missing sample does not claim'),
      stack(
        [note('c3 ~ ~ ~'), ['release', 2], ['cut', 1]],
        [
          ['s', '~ ghost ~ ~'],
          ['cut', 1]
        ],
        [note('~ ~ e3 ~'), ['cut', 1]]
      ),
      { cps: 1, cycles: 4, tail: 1, bookingWindow: 0.5 }
    ),
    render(
      'window-nudges',
      same('late and early nudges that reorder voices'),
      stack(
        [note('c3 e3 g3 b3'), ['nudge', '0 -0.6 0.9 0']],
        [note('~ c4 ~ ~'), ['nudge', 1.4], ['cut', 2]]
      ),
      { cps: 1, cycles: 4, tail: 1, bookingWindow: 0.5 }
    ),
    render(
      'window-ceiling-wrap-tail',
      `${RENDER}: keeps the folded tail under the master ceiling`,
      loud,
      { cps: 1, cycles: 2, tail: 0.5, wrap: true, bookingWindow: 0.5, master: { ceiling: -6 } }
    ),
    render(
      'window-not-positive',
      `${RENDER}: rejects a window that is not positive or shorter than two render quanta`,
      loud,
      { cps: 1, bookingWindow: 0 }
    ),
    render(
      'window-too-short',
      `${RENDER}: rejects a window that is not positive or shorter than two render quanta`,
      loud,
      { cps: 1, bookingWindow: 0.05 }
    )
  ];
}

/** The `options` group: the 0.4.0 options at their corners (not baseline). */
export function optionsCases(): GraphCase[] {
  return [...panLaws(), ...ceilings(), ...panPaths(), ...panSlides(), ...autopans(), ...windows()];
}
