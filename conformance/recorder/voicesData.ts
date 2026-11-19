// Layer 3 `voices` group: the 0.3.0 voice booking behaviours, recorded with every 0.4.0 option off
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlPatch } from '../../src/types';
import type { GraphCase, OutputSetup, VoicesGraphCase } from './graph';

const ENGINE = 'src/engine.test.ts';
const EFFECTS = 'src/effects.test.ts';
const MASTER = 'src/masterBus.test.ts';
const WAVES = 'src/waves.test.ts';
const NOISE = 'src/noise.test.ts';
const PITCH = 'src/pitchCurve.test.ts';
const FM = 'src/fm.test.ts';
const GATE = 'src/gate.test.ts';
const GENERATED = 'generated: ';

interface Extra {
  output?: OutputSetup;
  at?: number;
}

/** One voice with a patch of its own: the defaults of `resolveParams` fill in the rest. */
function one(stem: string, from: string, patch: ControlPatch, extra: Extra = {}): VoicesGraphCase {
  return {
    kind: 'voices',
    id: `voices-${stem}`,
    group: 'voices',
    from,
    baseline: true,
    output: extra.output,
    voices: [{ at: extra.at ?? 0, patch }]
  };
}

/** Several voices booked in order on one context (cut groups, shared buses, shared waves). */
function many(
  stem: string,
  from: string,
  voices: { at: number; patch: ControlPatch }[],
  output?: OutputSetup
): VoicesGraphCase {
  return {
    kind: 'voices',
    id: `voices-${stem}`,
    group: 'voices',
    from,
    baseline: true,
    output,
    voices
  };
}

/** A pitched, gated voice that holds its sustain: the shape most cases below vary. */
const HELD: ControlPatch = {
  pitch: 'a3',
  soundType: 'triangle',
  attack: 0.02,
  decay: 0.1,
  sustain: 0.6,
  release: 0.15,
  gainLevel: 0.5,
  duration: 0.4
};

const SINE_FM: ControlPatch = { ...HELD, soundType: 'sine' };

function waveforms(): GraphCase[] {
  const plain = `${ENGINE}: builds oscillator -> gain -> destination for a plain pitched voice`;
  const shaped = `${WAVES}: set a periodic wave on the carrier, shared between notes`;
  return [
    one('wave-sine', plain, { pitch: 'a4', soundType: 'sine', gainLevel: 0.7 }),
    one('wave-triangle', plain, { pitch: 'a4', soundType: 'triangle', gainLevel: 0.7 }),
    one('wave-square', plain, { pitch: 'a4', soundType: 'square', gainLevel: 0.7 }),
    one('wave-sawtooth', plain, { pitch: 'a4', soundType: 'sawtooth', gainLevel: 0.7 }),
    one('wave-halfsine', shaped, { pitch: 'c3', soundType: 'halfsine' }),
    one('wave-abssine', shaped, { pitch: 'c3', soundType: 'abssine' }),
    one('wave-pulsesine', shaped, { pitch: 'c3', soundType: 'pulsesine' }),
    many('wave-shared', `${WAVES}: creates one wave per shape per context and reuses it`, [
      { at: 0, patch: { pitch: 'c3', soundType: 'halfsine' } },
      { at: 0.25, patch: { pitch: 'e3', soundType: 'halfsine' } },
      { at: 0.5, patch: { pitch: 'g3', soundType: 'abssine' } }
    ]),
    one('pitch-default', `${ENGINE}: fills a patch out with the documented defaults`, {
      soundType: 'square'
    }),
    one('pitch-hz', `${GENERATED}a pitch given as a raw frequency`, { pitch: 261.63 })
  ];
}

function noise(): GraphCase[] {
  const from = `${ENGINE}: builds a buffer source (not an oscillator) for noise sound types`;
  return [
    one('noise-white', from, { soundType: 'white', release: 0.2 }),
    one('noise-pink', from, { soundType: 'pink', release: 0.2 }),
    one('noise-brown', from, { soundType: 'brown', release: 0.2 }),
    one(
      'noise-long-gate',
      `${ENGINE}: caps and loops the noise buffer for long gates instead of generating huge buffers`,
      { soundType: 'white', sustain: 0.5, duration: 3 }
    ),
    many(
      'noise-same-onset',
      `${NOISE}: gives two same-onset white-noise voices different buffers, reproducibly`,
      [
        { at: 0, patch: { soundType: 'white' } },
        { at: 0, patch: { soundType: 'white' } },
        { at: 0.5, patch: { soundType: 'brown' } }
      ]
    ),
    one('noise-ignores-pitch-curve', `${PITCH}: is ignored by noise voices`, {
      soundType: 'white',
      pitch: 'c3',
      pitchEnvAmount: 7,
      slideTime: 0.1,
      fmIndex: 3
    })
  ];
}

function envelopes(): GraphCase[] {
  return [
    one(
      'env-percussive',
      `${ENGINE}: schedules a percussive attack/decay/release gain envelope with no held plateau`,
      { pitch: 'c3', attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.05 }
    ),
    one(
      'env-gated',
      `${ENGINE}: holds the sustain level until the gate ends when duration is set`,
      HELD
    ),
    one(
      'env-gate-sustain-zero',
      `${ENGINE}: skips gating entirely when sustain is 0 — a silent hold would only waste node lifetime`,
      { ...HELD, sustain: 0 }
    ),
    one(
      'env-outlasts-gate',
      `${ENGINE}: stays percussive (no hold) when the envelope outlasts the gate`,
      { ...HELD, attack: 0.3, decay: 0.3, duration: 0.2 }
    ),
    one('env-zero-attack', `${GENERATED}a zero attack`, { ...HELD, attack: 0 }),
    one('env-zero-release', `${GENERATED}a zero release`, { ...HELD, release: 0 }),
    one('env-all-zero', `${GENERATED}every envelope time zero`, {
      ...HELD,
      attack: 0,
      decay: 0,
      release: 0
    }),
    one('env-long', `${GENERATED}long attack, decay and release`, {
      ...HELD,
      attack: 2,
      decay: 3,
      release: 5,
      duration: 8
    }),
    one('gain-zero', `${GENERATED}a gain level of zero`, { ...HELD, gainLevel: 0 }),
    one('gain-over-unity', `${GENERATED}a gain level above full scale`, {
      ...HELD,
      gainLevel: 1.5
    }),
    one(
      'gain-velocity',
      `${GATE}: scales the carrier peak only, leaving the envelope shape alone`,
      { ...HELD, velocity: 0.5 }
    ),
    one('start-negative', `${ENGINE}: clamps negative start times to the context origin`, HELD, {
      at: -0.5
    }),
    one(
      'nudge',
      `${ENGINE}: offsets everything by nudgeTime relative to the shared start time`,
      { ...HELD, nudgeTime: 0.125 },
      { at: 0.5 }
    )
  ];
}

function filters(): GraphCase[] {
  const lowpass = `${ENGINE}: inserts a lowpass filter between source and gain, enveloped between lpf and lpf+lpenv`;
  const saw: ControlPatch = { ...HELD, soundType: 'sawtooth' };
  return [
    one('filter-lpf', lowpass, { ...saw, filterCutoff: 800 }),
    one('filter-envelope', lowpass, {
      ...saw,
      filterCutoff: 400,
      filterEnvAmount: 2000,
      filterAttack: 0.05,
      filterDecay: 0.2,
      filterSustain: 0.5,
      filterRelease: 0.3
    }),
    one('filter-gated', `${ENGINE}: applies the same gate to the filter envelope`, {
      ...HELD,
      soundType: 'square',
      filterCutoff: 500,
      filterEnvAmount: 1500,
      filterDecay: 0.1,
      filterSustain: 0.4
    }),
    one('hpf', `${ENGINE}: inserts a highpass filter in series after the lowpass`, {
      ...saw,
      filterCutoff: 2000,
      hpfCutoff: 300
    }),
    one(
      'phaser',
      `${ENGINE}: inserts a 4-stage allpass phaser driven by one LFO through a shared depth gain`,
      { ...saw, phaserRate: 0.5 }
    )
  ];
}

function pitchCurves(): GraphCase[] {
  return [
    one(
      'slide',
      `${ENGINE}: glides from an octave above down to the target note when slideTime is set`,
      { ...HELD, slideTime: 0.15 }
    ),
    one('penv-rise', `${PITCH}: starts below the note and rises to it`, {
      ...HELD,
      pitchEnvAmount: -12,
      pitchDecay: 0.1
    }),
    one(
      'penv-fall-default-decay',
      `${PITCH}: starts above the note and falls to it, with a default decay of 0.1s`,
      { ...HELD, pitchEnvAmount: 7 }
    ),
    one(
      'penv-attack-decay',
      `${PITCH}: sweeps up to the offset over the attack, then back down over the decay`,
      { ...HELD, pitchEnvAmount: 12, pitchAttack: 0.05, pitchDecay: 0.2 }
    ),
    one(
      'pitch-steps',
      `${PITCH}: jumps to each offset at the given frame rate and holds the last`,
      { ...HELD, pitchSteps: [12, 7, 3, 0, -2], pitchStepRate: 20 }
    ),
    one('pitch-steps-priority', `${PITCH}: lets steps beat penv beat slide, and warns once`, {
      ...HELD,
      pitchSteps: [5, 0],
      pitchEnvAmount: 12,
      slideTime: 0.2
    })
  ];
}

function fm(): GraphCase[] {
  return [
    one('fm-wired', `${FM}: wires modulator -> depth gain -> carrier frequency`, {
      ...SINE_FM,
      fmIndex: 4
    }),
    one(
      'fm-harmonicity',
      `${FM}: sets the modulator to harmonicity × pitch and the depth to index × modulator Hz`,
      { ...SINE_FM, fmIndex: 2, fmHarmonicity: 3.5 }
    ),
    one(
      'fm-wave-square',
      `${FM}: defaults the harmonicity to 1 and the waveform to sine, and honours fmwave`,
      { ...SINE_FM, fmIndex: 2, fmWave: 'square' }
    ),
    one(
      'fm-wave-shaped',
      `${WAVES}: give the modulator a periodic wave while the carrier keeps its native type`,
      { ...SINE_FM, fmIndex: 2, fmWave: 'halfsine' }
    ),
    one(
      'fm-envelope',
      `${FM}: routes depth -> envelope -> carrier frequency and shapes the envelope`,
      {
        ...SINE_FM,
        fmIndex: 5,
        fmAttack: 0.02,
        fmDecay: 0.2,
        fmSustain: 0.3,
        fmRelease: 0.1
      }
    ),
    one(
      'fm-envelope-linear',
      `${FM}: defaults to an exponential curve with a floor above silence`,
      { ...SINE_FM, fmIndex: 5, fmDecay: 0.2, fmEnvCurve: 'lin' }
    ),
    one('fm-decay-only', `${FM}: lets a bare fmdecay fall toward silence`, {
      ...SINE_FM,
      fmIndex: 5,
      fmDecay: 0.3
    }),
    one(
      'fm-gate-own-sustain',
      `${FM}: gates the depth on its own sustain, independent of the amplitude sustain`,
      { ...SINE_FM, sustain: 0, fmIndex: 3, fmSustain: 0.5, fmDecay: 0.1 }
    ),
    one(
      'fm-slide',
      `${FM}: scales slide automation at each stage (carrier x1, modulator x harmonicity, depth x both)`,
      { ...SINE_FM, fmIndex: 2, fmHarmonicity: 2, slideTime: 0.1 }
    )
  ];
}

function cutGroups(): GraphCase[] {
  const patch = (pitch: string, cutGroup?: number): ControlPatch => ({
    ...HELD,
    pitch,
    cutGroup
  });
  return [
    many('cut-choke', `${GATE}: stops the previous voice in the group when the next one starts`, [
      { at: 0, patch: patch('c3', 1) },
      { at: 0.2, patch: patch('e3', 1) }
    ]),
    many('cut-other-groups', `${GATE}: leaves other groups and ungrouped voices alone`, [
      { at: 0, patch: patch('c3', 1) },
      { at: 0.1, patch: patch('e3', 2) },
      { at: 0.2, patch: patch('g3') },
      { at: 0.3, patch: patch('b3', 1) }
    ]),
    many(
      'cut-out-of-order',
      `${GATE}: chokes an earlier-booked voice at the onset of a later one that already holds the group`,
      [
        { at: 0.5, patch: patch('c3', 1) },
        { at: 0.1, patch: patch('e3', 1) }
      ]
    )
  ];
}

function orbits(): GraphCase[] {
  const send = (extra: ControlPatch): ControlPatch => ({ ...HELD, ...extra });
  const placed = `${ENGINE}: sends the placed voice to the default orbit (0) reverb bus, post-pan`;
  const delay = `${ENGINE}: sends to the delay bus as well when delayLevel is set, using delayTime/delayFeedback`;
  const floors = `${EFFECTS}: floors the impulse response length instead of going degenerate for a tiny or non-positive size`;
  return [
    one('room', placed, send({ pan: 0.3, roomLevel: 0.4, roomSize: 4 })),
    one('delay', delay, send({ delayLevel: 0.3, delayTime: 0.2, delayFeedback: 0.5 })),
    one(
      'room-and-delay',
      delay,
      send({
        roomLevel: 0.3,
        roomSize: 6,
        delayLevel: 0.2,
        delayTime: 0.25,
        delayFeedback: 0.4
      })
    ),
    many('orbit-buses', `${ENGINE}: routes different orbit numbers to different buses`, [
      { at: 0, patch: send({ roomLevel: 0.3, roomSize: 2, orbit: 0 }) },
      { at: 0.25, patch: send({ roomLevel: 0.3, roomSize: 5, orbit: 1 }) },
      { at: 0.5, patch: send({ delayLevel: 0.3, orbit: 1 }) }
    ]),
    many(
      'delay-changes-per-onset',
      `${ENGINE}: applies each voice's delay change at its own onset`,
      [
        { at: 0, patch: send({ delayLevel: 0.3, delayTime: 0.1, delayFeedback: 0.2 }) },
        { at: 0.5, patch: send({ delayLevel: 0.3, delayTime: 0.3, delayFeedback: 0.6 }) }
      ]
    ),
    many(
      'room-last-size-wins',
      `${EFFECTS}: regenerates when a later voice on the same orbit sets a different size`,
      [
        { at: 0, patch: send({ roomLevel: 0.3, roomSize: 2 }) },
        { at: 0.25, patch: send({ roomLevel: 0.3, roomSize: 2 }) },
        { at: 0.5, patch: send({ roomLevel: 0.3, roomSize: 7 }) }
      ]
    ),
    one('room-tiny-size', floors, send({ roomLevel: 0.3, roomSize: 0 })),
    one(
      'sends-level-zero',
      `${ENGINE}: skips the send entirely when the level is 0`,
      send({ roomLevel: 0, delayLevel: 0 })
    ),
    one(
      'sends-placed',
      placed,
      send({ channelGains: [1, 0.5, 0, 0], roomLevel: 0.3, delayLevel: 0.2 }),
      { output: { channels: 4 } }
    )
  ];
}

function placement(): GraphCase[] {
  const wide = `${ENGINE}: routes channelGains through per-speaker gains into a merger on a multichannel destination`;
  return [
    one('pan', `${ENGINE}: routes through a stereo panner when pan is set`, {
      ...HELD,
      pan: -0.6
    }),
    one(
      'pan-mono-destination',
      `${GENERATED}a pan on a mono destination`,
      { ...HELD, pan: 0.5 },
      { output: { channels: 1 } }
    ),
    one(
      'channels-four',
      wide,
      { ...HELD, channelGains: [1, 0.5, 0, 0.25] },
      { output: { channels: 4 } }
    ),
    one(
      'channels-fold-stereo',
      `${ENGINE}: folds channelGains down to stereo when the destination cannot address them`,
      { ...HELD, channelGains: [0, 0, 1, 0, 0.5, 0.5, 0, 0] }
    ),
    one(
      'channels-fold-six',
      `${ENGINE}: folds 7.1 placement to 5.1 (not stereo) on a six-channel destination`,
      { ...HELD, channelGains: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 1, 1] },
      { output: { channels: 6 } }
    ),
    one(
      'channels-unplaced-wide',
      `${ENGINE}: routes unplaced voices through a centred stereo merger on a widened destination`,
      HELD,
      { output: { channels: 6 } }
    ),
    one('channels-empty', `${ENGINE}: treats empty channelGains as no placement at all`, {
      ...HELD,
      channelGains: []
    }),
    one(
      'channels-single',
      `${ENGINE}: pads single-entry channelGains to two so the merger cannot up-mix mono to both speakers`,
      { ...HELD, channelGains: [0.7] }
    )
  ];
}

function masterBus(): GraphCase[] {
  return [
    one(
      'master-default',
      `${MASTER}: connects gain -> limiter -> makeup compensation -> destination, creating nothing else`,
      HELD,
      { output: { master: true } }
    ),
    one(
      'master-tuned-limiter',
      `${MASTER}: takes a level, a custom output and tuned limiter settings`,
      HELD,
      {
        output: {
          master: {
            gain: 0.5,
            limiter: { threshold: -6, knee: 3, ratio: 8, attack: 0.01, release: 0.25 }
          }
        }
      }
    ),
    one('master-no-limiter', `${MASTER}: is gain only when the limiter is turned off`, HELD, {
      output: { master: { limiter: false, gain: 0.8 } }
    }),
    one(
      'master-surround',
      `${MASTER}: skips the limiter above two channels so surround is not folded to stereo`,
      { ...HELD, channelGains: [1, 1, 0, 0] },
      { output: { master: true, channels: 4 } }
    ),
    one(
      'master-orbit',
      `${MASTER}: works as the output of a pattern, so voices reach the destination only through it`,
      { ...HELD, roomLevel: 0.3, delayLevel: 0.2 },
      { output: { master: true } }
    ),
    many(
      'master-two-loud-voices',
      `${GENERATED}two loud voices into the limiter`,
      [
        { at: 0, patch: { ...HELD, gainLevel: 1.5 } },
        { at: 0, patch: { ...HELD, pitch: 'e3', gainLevel: 1.5 } }
      ],
      { master: true }
    )
  ];
}

/** The `voices` group: baseline cases for the 0.3.0 booking behaviours. */
export function voicesCases(): GraphCase[] {
  return [
    ...waveforms(),
    ...noise(),
    ...envelopes(),
    ...filters(),
    ...pitchCurves(),
    ...fm(),
    ...cutGroups(),
    ...orbits(),
    ...placement(),
    ...masterBus()
  ];
}
