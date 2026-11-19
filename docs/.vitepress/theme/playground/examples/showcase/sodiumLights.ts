// Showcase song: Sodium Lights, a night-drive synthwave track about streetlights passing the car window
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const sodiumLights: ComposerExample = {
  label: 'Sodium Lights (night drive)',
  bpm: 96,
  code: `// "Sodium Lights" — night-drive synthwave in F minor, 36 bars at 96 bpm (a minute and a half).
// A pumping pad, a plucked bass, a lead that glides in from the side, strings
// that sway, and the orange streetlights: little chimes that sweep past from
// right to left, one every two beats, like lamps going by the window.
//
// Features shown:
//   • .panpath() — pan automation inside each note: every streetlight travels across the field
//   • .panlaw() — a 0 dB law so each light is loudest as it passes right beside you
//   • .panslide() — lead notes that glide in from the left to where they sit
//   • .autopan() with .autopandepth() and .autopanshape() — strings that sway with the bar
//   • a patterned .velocity() "pump": the sidechain feel without a compressor

const BEAT = 60 / 96; // 0.625 s
const DOTTED_EIGHTH = BEAT * 0.75; // the classic synthwave echo time

// ---------------------------------------------------------------------------
// HARMONY. Verse: i - VI - III - VII (Fm9, Dbmaj7, Ab, Eb), the minor-key loop
// of a hundred night drives. Chorus: VI - VII - v - i (Dbmaj7, Eb, Cm7, Fm9),
// which lifts because it starts away from home and takes four bars to return.
const verse = ['Fm9', 'Dbmaj7', 'Ab', 'Eb'];
const chorus = ['Dbmaj7', 'Eb', 'Cm7', 'Fm9'];

// ---------------------------------------------------------------------------
// THE PUMP. In this style the pad and bass duck on every kick and swell back,
// usually because a compressor listens to the kick. Here the same shape is
// simply written down: every chord is struck eight times a bar, and the
// velocity pattern '0.3 1' plays the one on the beat (with the kick) softly and
// the one between loudly. A short attack makes each swell rise, not click.
const pumpBars = (changes) => '<' + changes.map((symbol) => symbol + '*8').join(' ') + '>';
const pad = (changes, cutoff) =>
  chord(pumpBars(changes))
    .voicing({ anchor: 'f3' })
    .sound('sawtooth')
    .attack(0.05).decay(0.1).sustain(0.8).release(0.12)
    .velocity('0.3 1')
    .lpf(cutoff)
    .gain(0.04)
    .room(0.2).roomsize(4).orbit(1);

// BASS. Root eighths through a filter envelope: each note opens the lowpass from
// 220 Hz towards 1400 Hz and closes it within 120 ms, a short "pluck" of
// brightness, and it pumps with the pad.
const bass = (roots) =>
  note('<' + roots.map((root) => root + '*8').join(' ') + '>')
    .sound('sawtooth')
    .attack(0.004).decay(0.15).sustain(0.4).release(0.06)
    .lpf(220).lpenv(1200).lpa(0.005).lpd(0.12).lps(0.15)
    .velocity('0.55 1')
    .gain(0.2);
const verseBass = bass(['f1', 'db2', 'ab1', 'eb2']);
const chorusBass = bass(['db2', 'eb2', 'c2', 'f1']);

// ---------------------------------------------------------------------------
// DRUMS. A sine kick (.penv drops its pitch from 30 semitones up), a noise
// snare with a little tuned body underneath, and eighth-note hats.
const kick = note('f1*4') // tuned to the key's home note
  .sound('sine')
  .attack(0.001).decay(0.28).sustain(0).release(0.05)
  .penv(30).pdecay(0.05)
  .gain(0.34);
const snare = stack(
  sound('~ white ~ white').attack(0.001).decay(0.16).sustain(0).release(0.08).hpf(1200).gain(0.13),
  note('~ g3 ~ g3').sound('triangle').attack(0.001).decay(0.08).sustain(0).penv(7).pdecay(0.03).gain(0.08)
).room(0.25).roomsize(2).orbit(2);
const hats = sound('white*8')
  .attack(0.001).decay(0.03).sustain(0).release(0.02)
  .hpf(8000)
  .velocity('0.4 1')
  .pan('-0.2 0.2')
  .gain(0.05);

// ---------------------------------------------------------------------------
// THE STREETLIGHTS. A soft chime on the off-beat of beats one and three. Each one
// carries its own pan path, plain { time, pan } points in seconds from the onset:
// it appears on the right (0.9) and sweeps to the left (-0.9) over 0.8 s, swelling
// in as it approaches (a slow attack) and fading as it goes.
// .panlaw(0): with the default -3 dB law a sound in the centre is turned down a
// little on each side so its loudness stays even as it moves. A 0 dB law keeps
// both sides full in the centre, so the light is loudest as it passes right
// beside you, which is exactly what a passing light does.
const lights = note('[~ c6 ~ ~ ~ c6 ~ ~]')
  .sound('triangle')
  .attack(0.25).decay(0.6).sustain(0).release(0.3)
  .panpath([
    { time: 0, pan: 0.9 },
    { time: 0.8, pan: -0.9 }
  ])
  .panlaw(0)
  .gain(0.06)
  .delay(0.3).delaytime(DOTTED_EIGHTH).delayfeedback(0.35)
  .orbit(3);

// ---------------------------------------------------------------------------
// THE STRINGS. One held chord a bar, swaying side to side. autopan(0.4) is an LFO
// at 0.4 Hz, one full sway every 2.5 s, which at 96 bpm is exactly one bar, so
// every new chord's sway starts just where the last one's finished.
// autopanshape('triangle') sways at an even speed instead of lingering at the
// sides, and autopandepth(0.6) keeps it within the middle of the field.
const strings = chord('<' + chorus.join(' ') + '>')
  .voicing({ anchor: 'f4' })
  .sound('sawtooth')
  .attack(0.5).decay(0.4).sustain(0.8).release(1.2)
  .lpf(1800)
  .gain(0.028)
  .autopan(0.4)
  .autopandepth(0.6)
  .autopanshape('triangle')
  .room(0.4).roomsize(4).orbit(1);

// THE ARPEGGIO. Chord tones in eighths, one bar per chord, a little to the right.
const arp = note(
  '<[f4 ab4 c5 g5 c5 ab4 f4 c5] [db4 f4 ab4 c5 ab4 f4 db4 ab4] [c4 eb4 ab4 c5 ab4 eb4 c4 eb4] [bb3 eb4 g4 bb4 g4 eb4 bb3 g4]>'
)
  .sound('square')
  .attack(0.003).decay(0.12).sustain(0.15).release(0.08)
  .lpf(1800)
  .pan(0.35)
  .gain(0.05)
  .delay(0.2).delaytime(DOTTED_EIGHTH).orbit(3);

// ---------------------------------------------------------------------------
// THE LEAD. Two four-bar phrases over the chorus; the second answers the first a
// third higher and ends on the home note, F. .panslide(-0.7, 0.18) makes every
// note start out on the left and glide to its own pan (-0.15) over 0.18 s, so
// each phrase seems to come in from the passenger side.
const lead = note(
  '<[f5@3 eb5@3 c5@2] [eb5@3 bb4@3 g4@2] [g4@2 bb4@2 c5@2 eb5@2] [f5@6 ~@2] [ab5@3 f5@3 c5@2] [g5@3 eb5@3 bb4@2] [c5@2 eb5@2 g5@2 bb5@2] [g5@2 ab5@2 f5@4]>'
)
  .sound('sawtooth')
  .attack(0.02).decay(0.2).sustain(0.6).release(0.25)
  .lpf(2200)
  .pan(-0.15)
  .panslide(-0.7, 0.18)
  .gain(0.09)
  .delay(0.3).delaytime(DOTTED_EIGHTH).delayfeedback(0.45)
  .orbit(4); // its own orbit, so its longer echo tail does not change the lights' echo

// ---------------------------------------------------------------------------
// SECTIONS. In the intro and verse the pad's lowpass follows a slow saw, read at
// each of its eight strikes a bar, so the filter opens steadily over the section.
//   intro  (4)  the pad pumping alone, the streetlights begin
//   verse  (8)  drums, bass and the arpeggio join, the pad keeps opening
//   chorus (8)  the lead and the swaying strings, the pad wide open
//   break  (4)  the drums drop out; only the pad, strings and lights
//   chorus (8)  again, with the arpeggio as well
//   outro  (4)  the pad closes back down as the lights go by
const intro = stack(pad(verse, saw.slow(4).rangex(300, 900)), lights);
const verseSection = stack(pad(verse, saw.slow(8).rangex(600, 2600)), verseBass, kick, hats, arp, lights);
const chorusSection = stack(pad(chorus, 2800), chorusBass, kick, snare, hats, strings, lead);
const breakSection = stack(pad(chorus, 900), strings, lights);
const outro = stack(pad(verse, isaw.slow(4).rangex(400, 2400)), lights);

// A note on loudness: in your own app you could pass the output of
// createMasterBus(ctx, { ceiling: -1 }) to loop() for a limiter and a hard
// ceiling. A playground script has no audio context to build one with, so this
// mix leaves itself headroom instead. Add up the gains of everything that can
// sound at once (kick 0.34, bass 0.2, five pad notes at 0.04, strings, lead,
// snare, hats) and the worst case is about 1.5; voices at different pitches
// almost never peak on the same sample, so the real mix sits well below that.
return arrange(
  [4, intro],
  [8, verseSection],
  [8, chorusSection],
  [4, breakSection],
  [8, stack(chorusSection, arp)],
  [4, outro]
);

// Try this:
//   • Change the pad's velocity to '1' and the pump disappears: hear how much
//     of the groove it was carrying.
//   • Give the lights .panlaw(-6) and they dip as they pass, as if the car had
//     driven through a tunnel.
//   • Reverse the streetlights' path (pan -0.9 to 0.9) to drive the other way.`
};
