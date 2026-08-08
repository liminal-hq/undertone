// The demo page's preset one-shot sound effects — a game-SFX kit
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, sound, stack } from '../../../../src/index';

// The example that started this whole library: a placed-building thunk, sparkle, and click
export const placeBuilding = stack(
  note('c2')
    .sound('triangle')
    .attack(0.001)
    .decay(0.1)
    .sustain(0)
    .release(0.05)
    .gain(0.9)
    .lpf(220)
    .lpenv(5)
    .lpa(0.001)
    .lpd(0.08)
    .lps(0)
    .lpr(0.05)
    .slide(0.07),
  note('c6')
    .sound('sine')
    .attack(0.001)
    .decay(0.15)
    .sustain(0)
    .release(0.1)
    .gain(0.3)
    .lpf(2000)
    .lpenv(8)
    .lpa(0.001)
    .lpd(0.06)
    .lps(0)
    .lpr(0.1)
    .nudge(0.02),
  sound('white').attack(0).decay(0.02).sustain(0).release(0.01).gain(0.4).lpf(4000).lpenv(0)
);

// A short, higher-pitched confirmation blip — menu clicks, toggles, that kind of thing
export const uiBlip = stack(
  note('a5').sound('sine').attack(0.001).decay(0.06).sustain(0).release(0.03).gain(0.5).lpf(3000),
  sound('white').attack(0).decay(0.008).sustain(0).release(0.005).gain(0.15).lpf(6000)
);

// A short denied/error buzz — a descending square-wave slide through a tight filter
export const error = stack(
  note('a2')
    .sound('square')
    .attack(0.001)
    .decay(0.12)
    .sustain(0)
    .release(0.08)
    .gain(0.5)
    .lpf(600)
    .lpenv(0)
    .slide(0.15)
);

// A crunchy demolition sound — brown noise crunch under a descending thunk
export const bulldoze = stack(
  note('a1')
    .sound('sawtooth')
    .attack(0.001)
    .decay(0.14)
    .sustain(0)
    .release(0.08)
    .gain(0.7)
    .lpf(180)
    .lpenv(3)
    .lpa(0.001)
    .lpd(0.1)
    .lps(0)
    .lpr(0.08)
    .slide(0.12),
  sound('brown').attack(0.001).decay(0.1).sustain(0.1).release(0.12).gain(0.5).lpf(900).lpenv(0)
);

// A bright ascending two-note chime — tax collected, a sale completed, income received
export const cashIn = stack(
  note('c5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.12)
    .sustain(0)
    .release(0.08)
    .gain(0.5)
    .lpf(4000),
  note('e5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.16)
    .sustain(0)
    .release(0.1)
    .gain(0.5)
    .lpf(4500)
    .nudge(0.06)
);

// A rising sweep — a plant/line just connected a zone to the power grid
export const powerOn = stack(
  note('a3')
    .sound('sawtooth')
    .attack(0.02)
    .decay(0.14)
    .sustain(0.4)
    .release(0.1)
    .gain(0.35)
    .lpf(300)
    .lpenv(2200)
    .lpa(0.16)
    .lpd(0.05)
    .lps(0.6)
    .lpr(0.1)
);

// A short triumphant arpeggio — a population milestone, a new era, an achievement
export const milestone = stack(
  note('c5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500),
  note('e5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500)
    .nudge(0.09),
  note('g5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500)
    .nudge(0.18),
  note('c6')
    .sound('sine')
    .attack(0.002)
    .decay(0.3)
    .sustain(0)
    .release(0.2)
    .gain(0.4)
    .lpf(5000)
    .nudge(0.27)
);

// A soft two-tone chime — a news ticker item or advisor alert arrived
export const notification = stack(
  note('e5').sound('sine').attack(0.005).decay(0.1).sustain(0.1).release(0.1).gain(0.35).lpf(3000),
  note('b4')
    .sound('sine')
    .attack(0.005)
    .decay(0.12)
    .sustain(0.1)
    .release(0.12)
    .gain(0.3)
    .lpf(3000)
    .nudge(0.1)
);

// A quick reverse blip — undoing the last action
export const undo = stack(
  note('a4')
    .sound('square')
    .attack(0.001)
    .decay(0.08)
    .sustain(0)
    .release(0.04)
    .gain(0.35)
    .lpf(2200)
    .slide(0.05)
);
