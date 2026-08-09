// Playground example: Neon drive (7.1)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const neonDrive: ComposerExample = {
  label: 'Neon drive (7.1)',
  bpm: 110,
  code: `// An 80s synthwave cruise built for a 7.1 rig: the arp orbits the whole
// speaker ring (surround() isn't patternable, so cat() rotates eight fixed
// copies, one angle per cycle), channels() spotlights exact speakers for the
// side riser and rear zap, and the drums + lead hold the front on pan().

// Front of house — drums on plain stereo.
const kick = note('c1*4').sound('sine')
  .attack(0.001).decay(0.12).sustain(0).release(0.05)
  .gain(0.9).lpf(150).slide(0.05);
const snare = sound('~ white ~ white')
  .attack(0.001).decay(0.1).sustain(0).release(0.08)
  .gain(0.5).hpf(900).lpf(6000);
const hats = sound('white*8')
  .attack(0).decay(0.02).sustain(0).release(0.01)
  .gain(0.25).hpf(7000)
  .pan('-0.6 0.6 -0.3 0.3'); // pan() is patternable — hats tick across the front

const bass = cat(note('a1*8'), note('f1*8'), note('c2*8'), note('g1*8')) // Am F C G roots
  .sound('sawtooth')
  .attack(0.002).decay(0.1).sustain(0.3).release(0.05)
  .gain(0.55).lpf(500);

const pad = note('<[a2,c3,e3] [f2,a2,c3] [c3,e3,g3] [g2,b2,d3]>')
  .sound('sawtooth')
  .attack(0.06).decay(0.2).sustain(0.85).release(0.3)
  .gain(0.25).lpf(1100).phaser(0.4);

// The lead: two saw layers ~10 cents apart (detuned in plain JS), gliding on slide().
const detuned = (line) => stack(
  note(line),
  note(line.split(' ').map((w) => (w === '~' ? w : (noteToFrequency(w) * 1.006).toFixed(1))).join(' '))
);
const lead = cat(detuned('a4 ~ c5 e5 ~ e5 d5 c5'), detuned('b4 ~ d5 ~ c5 ~ a4 ~'))
  .sound('sawtooth')
  .attack(0.01).decay(0.15).sustain(0.5).release(0.15)
  .gain(0.3).lpf(2400)
  .slide(0.09)
  .pan('<-0.3 0.3>')
  .delay(0.3).delaytime(0.41).delayfeedback(0.3); // ~a dotted eighth at 110 bpm

// The showpiece: the arp laps the whole 7.1 ring, one 45° step per cycle.
const arpNotes = note('a3 c4 e4 a4 c5 a4 e4 c4')
  .sound('triangle')
  .attack(0.002).decay(0.1).sustain(0.15).release(0.06)
  .gain(0.4).lpf(2800);
const orbitArp = cat(...[0, 45, 90, 135, 180, 225, 270, 315].map((a) => arpNotes.surround(a)));

// Hand-built channels() spotlights — gains in CHANNEL_ORDER: FL FR C LFE SL SR RL RR.
const sideRiser = sound('white').slow(2) // a 2-cycle swell in the sides (SL+SR) only
  .attack(3.2).decay(0.3).sustain(0.5).release(0.4)
  .gain(0.2).lpf(3500)
  .channels([0, 0, 0, 0, 1, 1, 0, 0]);
const rearZap = note('~ ~ ~ a5').sound('square') // answers beat 4 from dead behind (RL+RR)
  .attack(0.001).decay(0.08).sustain(0).release(0.1)
  .gain(0.3).slide(0.12)
  .channels([0, 0, 0, 0, 0, 0, 0.9, 0.9]);

// Intro -> build -> drop -> outro; each arrange() section restarts its own cycles at 0.
return arrange(
  [2, stack(pad, orbitArp.gain(0.2))],
  [4, stack(pad, bass, hats, orbitArp, sideRiser)],
  [8, stack(kick, snare, hats, bass, pad, lead, orbitArp, rearZap)],
  [2, stack(pad, arpNotes.gain(0.25).surround(180))] // the arp parks dead-behind to close
);`
};
