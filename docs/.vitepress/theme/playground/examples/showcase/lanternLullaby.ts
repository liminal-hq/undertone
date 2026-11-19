// Showcase song: Lantern Lullaby, a waltz-time lullaby on layered FM music-box voices with seeded humanising
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const lanternLullaby: ComposerExample = {
  label: 'Lantern Lullaby (music box)',
  bpm: 88,
  code: `// "Lantern Lullaby" — a lullaby in G major, in three-four time, 40 bars (about a minute and three quarters).
// A music box plays the tune over a harp and a soft pad, a glass bell answers it,
// and every note is ever so slightly out of time and tune, as a real one would be.
//
// Features shown:
//   • fmVoice() — a music-box tine built from a plain description, and fmPresets reused at their own levels
//   • layer() — one tune on two voices at once, with a stagger, a balance and a pan for each
//   • drift() — seeded, repeatable humanising, with cyclesPerPass and a gentle push behind the beat
//   • mini() with .add() — one broken-chord shape, moved to each bar's root by arithmetic
//   • lanes: one arrange() per instrument, instead of one per section

// ---------------------------------------------------------------------------
// TEMPO IN THREE. A cycle is always one bar, and the Tempo slider counts four
// beats to a cycle. This bar has three beats, written as three (or six) steps,
// so at the slider's 88 a bar lasts 240 / 88 = 2.73 seconds and each of its three
// beats is 0.91 s: a rocking 66 beats a minute.

// ---------------------------------------------------------------------------
// THE MUSIC BOX. fmVoice() takes a description shaped like Tone.js's FMSynth and
// returns plain data. A tine is a bright strike that rings and fades: a sine
// carrier, a modulator two octaves up (harmonicity 4) whose depth dies away in a
// fifth of a second, and no sustain at all, so each note simply decays.
const tine = fmVoice({
  harmonicity: 4,
  modulationIndex: 2.5,
  modulation: { type: 'triangle' }, // a slightly edgier strike than a sine modulator
  envelope: { attack: 0.001, decay: 1.6, sustain: 0, release: 1.2 },
  modulationEnvelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
  level: 0.16
});
// A preset is just data too, so spread it and change its level.
const bell = { ...fmPresets.glassBell, gainLevel: 0.12 };

// ---------------------------------------------------------------------------
// THE TUNE. Six slots per bar (eighth notes in three-four); @ holds a note.
// The whole lullaby grows from a falling third, d5 to b4, in bar 1. Bar 2 lifts
// it a step (e5 to c5), and the B section hands it to a minor chord (Bm, bar 2).
const tuneA = [
  '[d5@4 b4@2]', //        G  — the falling third
  '[e5@4 c5@2]', //        C  — a step higher
  '[d5@2 b4@2 g4@2]', //   G
  '[a4@6]', //             D  — a breath
  '[d5@4 b4@2]', //        G
  '[e5@4 g5@2]', //        C  — reaching up this time
  '[f#5@2 e5@2 a4@2]', //  D
  '[g4@6]' //              G  — home
];
const tuneB = [
  '[g5@2 f#5@2 e5@2]', // Em
  '[d5@4 b4@2]', //       Bm — the falling third again, in the minor
  '[e5@2 d5@2 c5@2]', //  C
  '[b4@4 d5@2]', //       G
  '[e5@2 c5@2 a4@2]', //  Am
  '[f#4@4 a4@2]', //      D
  '[g4@2 a4@2 c5@2]', //  C
  '[a4@2 b4@2 c5@2]' //   D  — climbing back to the top of the tune
];
const tuneEnd = ['[d5@4 b4@2]', '[e5@4 c5@2]', '[b4@2 a4@2 f#4@2]', '[g4@6]'];
const bars = (list) => note('<' + list.join(' ') + '>');

// LANES. Instead of stacking instruments inside each section, each instrument
// gets its own arrange(), its "lane", and the lanes are stacked at the end.
// That keeps one instrument's whole part in one place. Every lane must add up to
// the same number of bars, or the parts drift apart when the song loops, so this
// little guard checks each one.
const SONG_BARS = 40;
const lane = (...sections) => {
  const total = sections.reduce((sum, [count]) => sum + count, 0);
  if (total !== SONG_BARS) throw new Error('a lane has ' + total + ' bars, not ' + SONG_BARS);
  return arrange(...sections);
};

const tune = lane([4, silence], [8, bars(tuneA)], [8, bars(tuneA)], [8, bars(tuneB)], [8, bars(tuneA)], [4, bars(tuneEnd)]);

// drift() gives every note its own small difference in timing, level and pitch,
// worked out from the seed, so it is the same on every play and every computer.
// cyclesPerPass: 8 makes each eight-bar phrase a "pass" with a fresh variation,
// so the three As are each played a little differently. push sits every note
// 15 ms behind the beat; keep push at least as large as timing so no note is
// ever pushed earlier than its slot.
const humanTune = drift(tune, {
  seed: 'lantern',
  timing: 0.012,
  level: 0.15,
  cents: 5, // a music box is never quite in tune
  push: 0.015,
  cyclesPerPass: 8
});

// layer(): the same humanised notes on the tine and the bell together. The bell
// starts 4 ms later (stagger), plays at half strength (levels) and sits a little
// to the right of the tine (pans): one richer instrument, not two.
const musicBox = layer(humanTune, [tine, bell], {
  stagger: 0.004,
  levels: [1, 0.5],
  pans: [-0.15, 0.2]
}).room(0.35).roomsize(6).orbit(1); // every voice on orbit 1 asks for the same room size, 6

// ---------------------------------------------------------------------------
// THE BELL'S ANSWERS. In the second A, a high glass bell fills the bars where
// the tune holds a long note, echoing its last few notes back.
const answers = note('<~ ~ ~ [~@2 a5 f#5 d5@2] ~ ~ ~ [~@2 b5 a5 g5@2]>')
  .voice({ ...fmPresets.glassBell, gainLevel: 0.07 })
  .pan(0.45)
  .room(0.5).roomsize(6).orbit(1);
const bellLane = lane([12, silence], [8, answers], [20, silence]);

// ---------------------------------------------------------------------------
// HARMONY. Each bar's chord as a scale degree of G major (G = 0, Am = 1, Bm = 2,
// C = 3, D = 4, Em = 5) and as a chord symbol for the pad.
const roots = {
  intro: '<0 3 0 4>',
  a: '<0 3 0 4 0 3 4 0>',
  b: '<5 2 3 0 1 4 3 4>',
  end: '<0 3 4 0>'
};
const symbols = {
  intro: '<G C G D>',
  a: '<G C G D G C D G>',
  b: '<Em Bm C G Am D C D>',
  end: '<G C D G>'
};

// THE HARP. One broken-chord shape: root, fifth, tenth, fifth, tenth, fifth (scale
// degrees 0 4 9 4 9 4). mini() parses a mini-notation string into a pattern of
// your own values (here plain numbers), and .add() shifts each note by the bar's
// root, read at the note's onset. One shape, every chord, no retyping.
const shape = mini('[0 4 9 4 9 4]', Number);
const harp = (rootBars) =>
  n(shape.add(mini(rootBars, Number)))
    .scale('G2:major')
    .voice({ ...fmPresets.pluck, gainLevel: 0.07 })
    .pan(-0.25)
    .room(0.3).roomsize(6).orbit(1);
const harpLane = lane([4, harp(roots.intro)], [8, harp(roots.a)], [8, harp(roots.a)], [8, harp(roots.b)], [8, harp(roots.a)], [4, harp(roots.end)]);

// THE PAD. chord().voicing() on the softPad preset, held for the whole bar.
// It drops out for the last A, so the music box sounds a little more alone.
const pad = (symbolBars) =>
  chord(symbolBars)
    .voicing({ anchor: 'g3' })
    .voice({ ...fmPresets.softPad, gainLevel: 0.045 })
    .pan(0.2)
    .room(0.45).roomsize(6).orbit(1);
const padLane = lane([4, pad(symbols.intro)], [8, pad(symbols.a)], [8, pad(symbols.a)], [8, pad(symbols.b)], [8, silence], [4, pad(symbols.end)]);

// A soft bass under the B section only: the same roots, held for the whole bar
// beneath the harp, so the minor-key middle feels a little deeper.
const bassLane = lane(
  [20, silence],
  [8, n(mini(roots.b, Number)).scale('G2:major').sound('triangle').attack(0.05).sustain(0.7).release(0.8).lpf(500).gain(0.12)],
  [12, silence]
);

// THE WHOLE SONG: the lanes, side by side.
//   intro (4) harp and pad · A (8) the tune · A (8) the tune, the bell answers ·
//   B (8) the minor-key middle, with bass · A (8) the tune, the pad gone · end (4)
return stack(musicBox, bellLane, harpLane, padLane, bassLane);

// Try this:
//   • Change the drift seed to 'firefly' for another performance of the same
//     notes, or set level and cents to 0 to hear a perfectly mechanical box.
//   • Change the harp's shape to '[0 2 4 7 4 2]' for a gentler, stepwise
//     accompaniment: the roots still move it to every chord.
//   • Try layer() levels: [0.4, 1] and the bell leads while the tine fills in.`
};
