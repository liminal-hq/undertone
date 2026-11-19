// Showcase song: Circle at Dusk, a polyrhythmic drum circle with every player placed around the listener
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const circleAtDusk: ComposerExample = {
  label: 'Circle at Dusk (drum circle, surround)',
  bpm: 80,
  code: `// "Circle at Dusk" — a polyrhythmic drum circle in twelve-eight, 40 bars at 80 bpm (2 minutes).
// Seven players sit in a ring around you: a bell, a shaker, a djembe, a talking
// drum, a low drum behind you, a kalimba and a clapper. Each plays its own
// rhythm; together they lock into one groove that is in three and in two at once.
//
// Features shown:
//   • .euclid() and mini-notation (k,n,r) — the bell, the djembe and the talking drum are all euclidean rhythms
//   • polyrhythm — twelve slots, sixteen slots, three against four and a 3+3+2 clave in one bar
//   • timecat() — the clave's uneven 3+3+2 split, written as weights
//   • .surround() — each player at their own angle around the listener, and how it folds down to stereo
//   • orbits — a tight room for the drums, a long hall and an echo for the kalimba and claps

// ---------------------------------------------------------------------------
// THE BAR. Twelve-eight: twelve quick pulses, felt as four slow beats of three.
// At the slider's 80 a bar lasts 240 / 80 = 3 s, so each slow beat is 0.75 s.

// ---------------------------------------------------------------------------
// THE CIRCLE. surround(angle) places a voice on the speaker ring: 0 is straight
// ahead, positive angles go clockwise to the right, 180 is behind you.
//   bell 15 · shaker -15 · djembe -90 · talking drum 90 ·
//   low drum 180 · kalimba -165 · claps 165
// On a surround system (up to 7.1) every player has a place in the room. On
// stereo speakers or headphones the playground folds the ring down for you,
// and it becomes a line: the two front players lean a little either side of
// centre, the side players go hard left and hard right a little quieter, the
// rear pair become soft partial pans, and the low drum behind you lands in the
// centre. Players are paired as mirror images (15 and -15, 90 and -90, 165 and
// -165), so the fold-down stays balanced left to right. Angles like -60, where
// two front and side speakers would both fold onto the same side, come out
// louder in stereo than they sound in the room, so this ring avoids them.
const ANGLE = { bell: 15, shaker: -15, djembe: -90, talker: 90, low: 180, kalimba: -165, claps: 165 };

// ORBITS. Reverb and delay are shared buses, one per orbit number. The drums
// share orbit 1, a small tight room; the kalimba and claps have orbits of their
// own with a long hall, so the melody and the claps ring out into the dusk
// while the drums stay close and dry.
const DRUM_ROOM = (pat) => pat.room(0.12).roomsize(1.5).orbit(1);

// ---------------------------------------------------------------------------
// THE BELL. The standard West African bell pattern, x.x.xx.x.x.x, is a euclidean
// rhythm: seven strokes spread as evenly as possible over twelve slots, rotated
// three slots so it starts in the right place. .euclid(7, 12, 3) says exactly that.
// A pinch of FM gives it a metallic ring.
const bell = note('a5')
  .euclid(7, 12, 3)
  .sound('sine')
  .fm(2).fmh(2.4).fmdecay(0.08)
  .attack(0.001).decay(0.18).sustain(0).release(0.1)
  .gain(0.07)
  .surround(ANGLE.bell);

// THE SHAKER. All twelve slots, accented at the start of each slow beat.
const shaker = sound('white*12')
  .attack(0.003).decay(0.04).sustain(0).release(0.02)
  .hpf(5000)
  .velocity('[1 0.35 0.55]*4')
  .gain(0.035)
  .surround(ANGLE.shaker);

// THE LOW DRUM. Three strokes a bar, every four pulses: three against the four
// slow beats, the hemiola that makes twelve-eight feel like it turns over.
// A falling pitch envelope (.penv) gives each stroke its thump.
const low = DRUM_ROOM(
  note('[d2 ~ ~ ~ a1 ~ ~ ~ d2 ~ ~ ~]')
    .sound('sine')
    .attack(0.002).decay(0.4).sustain(0).release(0.1)
    .penv(12).pdecay(0.06)
    .gain(0.32)
    .surround(ANGLE.low)
);

// THE DJEMBE. Tones on a euclidean five-in-twelve, and bright slaps on a
// three-in-twelve written in mini-notation, 'white(3,12,2)'. Where a slap and a
// tone land together (once a bar) they make an accent.
const djembe = DRUM_ROOM(
  stack(
    note('g3')
      .euclid(5, 12)
      .sound('triangle')
      .attack(0.001).decay(0.16).sustain(0).release(0.06)
      .penv(5).pdecay(0.03)
      .gain(0.16),
    sound('white(3,12,2)')
      .attack(0.001).decay(0.05).sustain(0).release(0.03)
      .hpf(1800).lpf(7000)
      .gain(0.09)
  ).surround(ANGLE.djembe)
);

// THE TALKING DRUM. It plays on a grid of sixteen, not twelve: five strokes in
// sixteen slots, which drift against the bell and meet it again at the bar line.
// Its pitch changes once a bar (a2, a2, c3, g2), like a voice asking and answering.
// The squeeze of its pitch is a pitch envelope with an attack: .penv(5) with
// .pattack(0.04) bends each note up five semitones, then .pdecay(0.25) lets it
// sag back down, the way a player squeezes the drum's strings under the arm.
const talker = DRUM_ROOM(
  note('<a2 a2 c3 g2>')
    .euclid(5, 16, 2)
    .sound('triangle')
    .attack(0.002).decay(0.25).sustain(0).release(0.1)
    .penv(5).pattack(0.04).pdecay(0.25)
    .lpf(1600)
    .gain(0.18)
    .surround(ANGLE.talker)
);

// THE CLAVE. timecat() joins patterns with weights instead of equal shares:
// 3 + 3 + 2 of 8 puts the claps at 0, 3/8 and 6/8 of the bar, the tresillo. That
// is a pattern in two laid over a bar in three, the second polyrhythm of the
// piece. Each clap is two noise bursts 12 ms apart (.late), like real hands.
const clapOnce = sound('white').attack(0.001).decay(0.07).sustain(0).release(0.08).hpf(900).lpf(5000).gain(0.07);
const clap = stack(clapOnce, clapOnce.late(0.012).gain(0.05));
const claps = timecat([[3, clap], [3, clap], [2, clap]])
  .room(0.5).roomsize(8).orbit(2)
  .surround(ANGLE.claps);

// THE KALIMBA. The only melody: D minor pentatonic, six notes a bar (one per two
// pulses), a four-bar phrase that rises and comes back to rest on D. Its echo
// is one slow beat long (0.75 s), so every echo falls on the beat.
const kalimba = n('<[0 2 3 4 3 2] [0 2 3 5 4 ~] [7 5 4 3 2 ~] [3 2 0 ~ -1 0]>')
  .scale('D4:minorPentatonic')
  .voice({ ...fmPresets.pluck, gainLevel: 0.09 })
  .room(0.45).roomsize(7)
  .delay(0.3).delaytime(0.75).delayfeedback(0.35)
  .orbit(3)
  .surround(ANGLE.kalimba);

// The djembe and talking drum, trading calls: every second bar the talking drum
// plays twice as fast (.every(2, ...) picks bars 0, 2, 4 ...), and every fourth
// bar the djembe does.
const talkerCalls = talker.every(2, (pat) => pat.fast(2));
const djembeCalls = djembe.every(4, (pat) => pat.fast(2));

// ---------------------------------------------------------------------------
// SECTIONS. The circle fills up one player at a time, talks, then plays together.
//   gathering (8)  the bell alone, then the shaker, then the low drum
//   circle    (8)  the djembe and the talking drum join
//   song      (8)  the kalimba sings and the claps begin
//   talk      (8)  the melody and claps rest; djembe and talking drum trade calls
//   together  (8)  everyone, until only the bell is left
const gathering = arrange([2, bell], [2, stack(bell, shaker)], [4, stack(bell, shaker, low)]);
const circle = stack(bell, shaker, low, djembe, talker);
const song = stack(circle, kalimba, claps);
const talk = stack(bell, low, djembeCalls, talkerCalls);
const together = arrange([6, stack(bell, shaker, low, djembe, talkerCalls, kalimba, claps)], [2, bell]);

return arrange([8, gathering], [8, circle], [8, song], [8, talk], [8, together]);

// Try this:
//   • Change the bell's rotation from 3 to 0 and the whole circle seems to start
//     in a different place, though not one stroke has been added or taken away.
//   • Try talker's .euclid(5, 16, 2) as .euclid(7, 16, 2) for a busier talking drum.
//   • Swap two angles in ANGLE (say the djembe and the kalimba) and listen to the
//     circle rearrange itself around you.`
};
