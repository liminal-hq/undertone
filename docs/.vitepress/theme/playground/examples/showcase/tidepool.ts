// Showcase song: Tidepool, a generative ambient piece driven by seeded random signals and slow filter sweeps
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const tidepool: ComposerExample = {
  label: 'Tidepool (generative ambient)',
  bpm: 56,
  code: `// "Tidepool" — generative ambient in D major pentatonic, 32 bars at 56 bpm (about two and a quarter minutes).
// Nobody wrote the bell notes down: seeded random signals choose them. A drone
// breathes under it, waves of filtered noise roll in and out, and a low line
// wanders in the middle. Because the randomness is seeded, every play is the
// same performance, and a section that comes back plays the same notes again.
//
// Features shown:
//   • seeded random signals — irand(), choose(), brandBy() and rand2, each with its own .seed()
//   • signals driving controls — sine, perlin and saw shaping filters, pan and velocity
//   • .rangex() for filter sweeps that move evenly to the ear, and .segment() to give a signal a rhythm
//   • arrange() restarting a section's clock, so seeded material returns note for note
//   • .jux(rev) and .every() — the bells answered by their own reflection

// ---------------------------------------------------------------------------
// HOW A SIGNAL IS READ. A signal (sine, perlin, rand...) has a value at every
// instant but no notes of its own. A control reads it once, at each note's onset,
// so a long note keeps the value it started with. That is why the drone and the
// waves below retrigger every half bar or bar with long, overlapping envelopes:
// each new note picks up the next value of the sweep and crossfades into it.

// ---------------------------------------------------------------------------
// THE DRONE. D, A and D, two onsets a bar, each fading in over 1.2 s and out over
// 2.5 s, so they overlap into one continuous sound. The lowpass follows a sine
// that takes 16 bars to rise and fall. rangex() maps 0..1 exponentially, so the
// sweep from 220 Hz to 1400 Hz feels even to the ear instead of rushing past
// the low end, as a straight range() would.
const drone = (top) =>
  note('[d2,a2,d3]*2')
    .sound('sawtooth')
    .attack(1.2).decay(0.5).sustain(0.8).release(2.5)
    .lpf(sine.slow(16).rangex(220, top))
    .gain(0.04)
    .room(0.4).roomsize(9).orbit(2);

// THE WAVES. Pink noise, one wave a bar: it swells in, holds for 60% of the bar
// (.legato(0.6)) and rolls back out. perlin is smooth random motion, so each
// wave is a little brighter or darker than the last without jumping; rand2 is
// random from -1 to 1, scaled to place each wave somewhere across the shore.
const waves = s('pink')
  .attack(1.6).decay(0.4).sustain(0.6).release(2.2)
  .legato(0.6)
  .lpf(perlin.seed(9).slow(3).rangex(350, 2200))
  .hpf(120)
  .pan(rand2.seed(4).mul(0.6))
  .velocity(perlin.seed(10).slow(2).range(0.5, 1))
  .gain(0.06);

// ---------------------------------------------------------------------------
// THE BELLS. irand(10) is a random whole number from 0 to 9, and .seed(11) fixes
// which ones. .segment(8) reads it eight times a bar, giving the signal a rhythm,
// and n() with .scale() turns each number into a note of D major pentatonic, a
// scale with no semitones, so no two random notes can clash.
// Most slots stay silent: brandBy(0.35) is 1 about a third of the time and 0
// otherwise, and multiplied by a random strength it becomes each note's velocity.
// (A velocity of 0 plays nothing.)
const bells = (density, seed) =>
  n(irand(10).seed(seed).segment(8))
    .scale('D4:majorPentatonic')
    .voice({ ...fmPresets.glassBell, gainLevel: 0.09 })
    .velocity(brandBy(density).seed(seed + 1).mul(rand.seed(seed + 2).range(0.4, 1)))
    .room(0.6).roomsize(9) // the drone's room: voices sharing an orbit should agree on its size
    .delay(0.3).delaytime(60 / 56 / 2).delayfeedback(0.45) // an echo every eighth note
    .orbit(2)
    // jux(rev): the bells as written on the left, and the same bar played
    // backwards on the right. A random line and its mirror image, side by side.
    .jux(rev);

// ---------------------------------------------------------------------------
// THE LOW LINE. choose() picks one of the values you give it, here five scale
// degrees that spell a D6 chord (D, F#, A, B and D again). Four notes a bar, in the
// low register, drifting around the middle of the stereo field on a slow sine.
// every(4, rev) plays every fourth bar backwards, a small change you feel more
// than hear.
const lowLine = n(choose(0, 2, 3, 4, 5).seed(3).segment(4))
  .scale('D3:majorPentatonic')
  .sound('triangle')
  .attack(0.02).decay(0.6).sustain(0.25).release(0.9)
  .lpf(saw.slow(8).rangex(500, 1800))
  .pan(sine2.slow(8).mul(0.5))
  .gain(0.08)
  .room(0.3).roomsize(9).orbit(2)
  .every(4, rev);

// ---------------------------------------------------------------------------
// SECTIONS.
//   low tide (8)  the drone and the waves
//   pools    (8)  sparse bells arrive (seed 11)
//   current  (8)  the drone opens up, the bells grow busier (seed 31), the low line moves
//   return   (8)  pools again, then low tide for the last two bars
// Each arrange() section starts its own clock at zero, and the random signals
// are pure functions of their seed and that clock. So the pools section in the
// return plays exactly the bells it played the first time: a generative piece
// with a theme that comes back.
const lowTide = stack(drone(1400), waves);
const pools = stack(drone(1400), waves, bells(0.35, 11));
const current = stack(drone(2600), waves, bells(0.5, 31), lowLine);

return arrange(
  [8, lowTide],
  [8, pools],
  [8, current],
  [8, arrange([6, pools], [2, lowTide])]
);

// Try this:
//   • Change bells(0.35, 11) to bells(0.35, 12): a new tune, the same character.
//   • Swap 'D4:majorPentatonic' for 'D4:dorian': semitones come back, and with
//     them a few notes that rub against each other.
//   • Change the drone's rangex to range and listen to the low end of each
//     sweep rush past.`
};
