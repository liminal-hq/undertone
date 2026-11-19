// The `score` group: score() compiled and rendered offline, its seam, gates, pan fields, and its errors
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ScoreDefinition } from '../../src/score';
import type { GraphCase, ScoreGraphCase } from './graph';

const GUIDE = 'docs/guide/instruments-and-scores.md';
const PAN_LAW = 'src/panLaw.test.ts';
const PAN_PATH = 'src/panPath.test.ts';
const AUTOPAN = 'src/autopan.test.ts';
const GENERATED = 'generated: ';

/** A two-second cue at 560 ticks a second (AdLib's rate): the length every score here starts from. */
const CUE = { ticksPerSecond: 560, lengthTicks: 1120 } as const;

function cue(
  stem: string,
  from: string,
  definition: Omit<ScoreDefinition, 'ticksPerSecond' | 'lengthTicks'> &
    Partial<Pick<ScoreDefinition, 'ticksPerSecond' | 'lengthTicks'>>,
  render: ScoreGraphCase['render'] = {}
): ScoreGraphCase {
  return {
    kind: 'score',
    id: `score-${stem}`,
    group: 'score',
    from,
    definition: { ...CUE, ...definition },
    render: { sampleRate: 1280, ...render }
  };
}

function compiling(): GraphCase[] {
  return [
    cue(
      'notes-midi-and-hz',
      `${GUIDE}: events at whole ticks with a note name, a MIDI number, or Hz`,
      {
        events: [
          { tick: 0, note: 'e4' },
          { tick: 280, midi: 69, gate: 140 },
          { tick: 560, note: 330 }
        ]
      }
    ),
    cue('gate-lengths', `${GUIDE}: a gate is in ticks, default one tick`, {
      events: [
        { tick: 0, note: 'c4', gate: 56 },
        { tick: 112, note: 'd4', gate: 280 },
        { tick: 560, note: 'e4' }
      ]
    }),
    cue(
      'events-out-of-order',
      `${GENERATED}events are sorted by onset, and events on one tick keep their order`,
      {
        events: [
          { tick: 700, note: 'g4', gate: 70 },
          { tick: 70, note: 'c4', gate: 70 },
          { tick: 70, note: 'e4', gate: 70 },
          { tick: 0, note: 'a3', gate: 70 }
        ]
      }
    ),
    cue(
      'uneven-ticks',
      `${GUIDE}: events are not snapped to a grid, so hand-played timing survives`,
      {
        events: [
          { tick: 0, note: 'c4', gate: 60 },
          { tick: 73, note: 'c4', gate: 60 },
          { tick: 148, note: 'c4', gate: 60 },
          { tick: 223, note: 'c4', gate: 60 },
          { tick: 444, note: 'c4', gate: 60 }
        ]
      }
    ),
    cue('level-and-pan', `${GUIDE}: level is the velocity control, and pan places the note`, {
      events: [
        { tick: 0, note: 'a3', gate: 100, level: 0.4, pan: -1 },
        { tick: 280, note: 'a4', gate: 100, level: 1, pan: 0.5 }
      ]
    }),
    cue(
      'voice-controls',
      `${GUIDE}: an event's voice carries any further voice controls, and the score's pitch and gate win`,
      {
        events: [
          {
            tick: 0,
            note: 'a3',
            gate: 200,
            voice: {
              soundType: 'square',
              attack: 0.02,
              release: 0.3,
              filterCutoff: 900,
              pitch: 'c9',
              duration: 9
            }
          },
          {
            tick: 560,
            midi: 60,
            gate: 200,
            voice: {
              soundType: 'sine',
              fmIndex: 3,
              fmHarmonicity: 2,
              fmDecay: 0.2,
              roomLevel: 0.2
            }
          }
        ]
      }
    ),
    cue('empty-cue', `${GENERATED}a score with no events books only the output`, { events: [] })
  ];
}

function seams(): GraphCase[] {
  const held = [{ tick: 1000, note: 'c4', gate: 400 }];
  return [
    cue('seam-cut-default', `${GUIDE}: a note held at the seam is cut there by default`, {
      events: held
    }),
    cue('seam-cut', `${GUIDE}: 'cut' closes the gate at the seam`, {
      seam: 'cut',
      events: held
    }),
    cue('seam-ring', `${GUIDE}: 'ring' lets the gate run on past the seam`, {
      seam: 'ring',
      events: held
    }),
    cue('seam-one-tick-left', `${GENERATED}the last tick of the cue gets a one tick gate`, {
      events: [{ tick: 1119, note: 'c4', gate: 5 }]
    })
  ];
}

function placement(): GraphCase[] {
  return [
    cue(
      'pan-law-for-every-event',
      `${PAN_LAW}: is given to every score event by the definition, unless the event sets its own`,
      {
        panLaw: -6,
        events: [
          { tick: 0, note: 'c4', gate: 100, pan: -0.5 },
          { tick: 280, note: 'e4', gate: 100, pan: 0.5, voice: { panLaw: -1.5 } },
          { tick: 560, note: 'g4', gate: 100 }
        ]
      }
    ),
    cue(
      'pan-law-zero',
      `${PAN_LAW}: a score pan law of 0 dB keeps the louder side full, as a balance control does`,
      {
        panLaw: 0,
        events: [{ tick: 0, note: 'c4', gate: 100, pan: 0.25 }]
      }
    ),
    cue('pan-path', `${PAN_PATH}: carries a pan path in ticks as seconds from the onset, clamped`, {
      events: [
        {
          tick: 0,
          note: 'c4',
          gate: 280,
          panPath: [
            { tick: 0, pan: -1 },
            { tick: 140, pan: 3 },
            { tick: 140, pan: 0 },
            { tick: 280, pan: 0.5 }
          ]
        },
        { tick: 560, note: 'e4', gate: 100, pan: 0.3, panPath: [] }
      ]
    }),
    cue(
      'autopan',
      `${AUTOPAN}: carries an autopan in ticks per cycle into controls in Hz, with its shape and phase`,
      {
        events: [
          {
            tick: 0,
            note: 'c4',
            gate: 560,
            pan: 0.2,
            autopan: { periodTicks: 280, depth: 0.5 }
          },
          {
            tick: 560,
            note: 'e4',
            gate: 560,
            autopan: { periodTicks: 140, depth: 1, shape: 'square', phase: 0.25 }
          }
        ]
      }
    ),
    cue(
      'pan-path-and-autopan',
      `${AUTOPAN}: an autopan swings around the pan a pan path leaves at its end`,
      {
        events: [
          {
            tick: 0,
            note: 'c4',
            gate: 560,
            panPath: [
              { tick: 0, pan: -0.5 },
              { tick: 560, pan: 0.5 }
            ],
            autopan: { periodTicks: 100, depth: 0.25, shape: 'triangle', phase: 1 }
          }
        ]
      }
    )
  ];
}

function rendering(): GraphCase[] {
  const run = [
    { tick: 0, note: 'c4', gate: 100 },
    { tick: 560, note: 'e4', gate: 100 }
  ];
  return [
    cue(
      'render-two-cycles',
      `${GUIDE}: cue.render() renders one pass at the score's own tempo`,
      {
        events: run
      },
      { cycles: 2 }
    ),
    cue(
      'render-tail-and-wrap',
      `src/render.test.ts: wrap folds the tail onto the start`,
      {
        events: [{ tick: 1000, note: 'c4', gate: 300, voice: { release: 0.5 } }]
      },
      { tail: 0.5, wrap: true }
    ),
    cue(
      'render-ungated',
      `src/render.test.ts: gated false keeps envelopes percussive`,
      {
        events: run
      },
      { gated: false }
    ),
    cue(
      'render-no-master',
      `src/render.test.ts: master false sends voices to the destination`,
      {
        events: run
      },
      { master: false }
    ),
    cue(
      'render-four-channels',
      `src/render.test.ts: more than two channels are discrete`,
      {
        events: run
      },
      { channels: 4 }
    ),
    cue(
      'render-booking-window',
      `src/render.test.ts: bookingWindow books the cue in windows`,
      {
        events: [
          { tick: 0, note: 'c4', gate: 100 },
          { tick: 280, note: 'd4', gate: 100 },
          { tick: 560, note: 'e4', gate: 100 },
          { tick: 840, note: 'g4', gate: 100 }
        ]
      },
      { bookingWindow: 0.5 }
    ),
    cue('render-slow-cue', `${GUIDE}: a score's tempo is its own, here 4 seconds a cycle`, {
      ticksPerSecond: 100,
      lengthTicks: 400,
      events: [
        { tick: 0, note: 'c4', gate: 50 },
        { tick: 200, note: 'c5', gate: 50 }
      ]
    }),
    cue(
      'render-seeded-noise',
      `${GENERATED}the render seed reaches a noise voice`,
      {
        events: [{ tick: 0, midi: 60, gate: 100, voice: { soundType: 'noise' } }]
      },
      { seed: 'cue' }
    )
  ];
}

function errors(): GraphCase[] {
  const event = { tick: 0, note: 'c4' } as const;
  const bad = (stem: string, definition: Partial<ScoreDefinition>) =>
    cue(`error-${stem}`, `${GENERATED}score() throws before anything is booked`, {
      events: [event],
      ...definition
    });
  const withEvent = (stem: string, extra: Record<string, unknown>) =>
    bad(stem, { events: [{ ...event, ...extra } as never] });
  return [
    bad('ticks-per-second-zero', { ticksPerSecond: 0 }),
    bad('ticks-per-second-nan', { ticksPerSecond: Number.NaN }),
    bad('length-zero', { lengthTicks: 0 }),
    bad('length-fractional', { lengthTicks: 10.5 }),
    bad('pan-law-too-low', { panLaw: -7 }),
    bad('pan-law-positive', { panLaw: 1 }),
    bad('event-after-cue', { events: [{ tick: 1120, note: 'c4' }] }),
    bad('event-tick-negative', { events: [{ tick: -1, note: 'c4' }] }),
    bad('event-tick-fractional', { events: [{ tick: 1.5, note: 'c4' }] }),
    bad('event-without-pitch', { events: [{ tick: 4 }] }),
    withEvent('gate-zero', { gate: 0 }),
    withEvent('gate-fractional', { gate: 2.5 }),
    withEvent('pan-path-backwards', {
      panPath: [
        { tick: 10, pan: 0 },
        { tick: 4, pan: 1 }
      ]
    }),
    withEvent('pan-path-tick-negative', { panPath: [{ tick: -1, pan: 0 }] }),
    withEvent('pan-path-pan-nan', { panPath: [{ tick: 0, pan: Number.NaN }] }),
    withEvent('autopan-period-zero', { autopan: { periodTicks: 0, depth: 0.5 } }),
    withEvent('autopan-depth-above-one', { autopan: { periodTicks: 4, depth: 2 } }),
    withEvent('autopan-depth-nan', { autopan: { periodTicks: 4, depth: Number.NaN } }),
    withEvent('autopan-shape', { autopan: { periodTicks: 4, depth: 0.5, shape: 'saw' } }),
    withEvent('autopan-phase', { autopan: { periodTicks: 4, depth: 0.5, phase: -0.1 } }),
    cue(
      'error-render-cycles',
      'src/render.test.ts: a render needs whole cycles',
      {
        events: [event]
      },
      { cycles: 0 }
    ),
    cue(
      'error-render-booking-window',
      'src/render.test.ts: a window of under two quanta',
      {
        events: [event]
      },
      { bookingWindow: 0.01 }
    )
  ];
}

/**
 * The cases that use only what 0.3.0 had (no pan law, pan path, autopan, or booking window), so the cross-check
 * against the v0.3.0 tag must give the same graph.
 */
const BASELINE = new Set([
  'notes-midi-and-hz',
  'gate-lengths',
  'events-out-of-order',
  'uneven-ticks',
  'level-and-pan',
  'voice-controls',
  'empty-cue',
  'seam-cut-default',
  'seam-cut',
  'seam-ring',
  'seam-one-tick-left',
  'render-two-cycles',
  'render-tail-and-wrap',
  'render-ungated',
  'render-no-master',
  'render-four-channels',
  'render-slow-cue',
  'render-seeded-noise',
  'error-ticks-per-second-zero',
  'error-ticks-per-second-nan',
  'error-length-zero',
  'error-length-fractional',
  'error-event-after-cue',
  'error-event-tick-negative',
  'error-event-tick-fractional',
  'error-event-without-pitch',
  'error-gate-zero',
  'error-gate-fractional',
  'error-render-cycles'
]);

/** Every case of the `score` group. */
export function scoreCases(): GraphCase[] {
  return [...compiling(), ...seams(), ...placement(), ...rendering(), ...errors()].map((spec) =>
    BASELINE.has(spec.id.replace(/^score-/, '')) ? { ...spec, baseline: true } : spec
  );
}
