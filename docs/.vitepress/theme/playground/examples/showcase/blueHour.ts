// Showcase song: Blue Hour, a slow jazz ballad built on chord voicings and modal scale runs
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const blueHour: ComposerExample = {
  label: 'Blue Hour (jazz ballad)',
  bpm: 64,
  code: `// "Blue Hour" — a slow jazz ballad in F major, 40 bars at 64 bpm (about two and a half minutes).
// Muted horn melody, soft keys, brushes and a bass that starts in half notes and
// starts walking once the bridge arrives. AABA song form with an intro and a tag.
//
// Features shown:
//   • chord().voicing({ anchor }) — chord symbols turned into real voicings, held in one register
//   • n().scale() with modes — dorian, mixolydian, lydian and locrian runs over the chords they fit
//   • a patterned .nudge() — swing, by pushing every off-beat eighth a little late
//   • .legato() — a walking bass whose notes join up instead of stopping short
//   • plain JavaScript that writes mini-notation for you (comping rhythms, an octave-up copy)

// ---------------------------------------------------------------------------
// SWING. A ballad's eighths are not even: the second of each pair lands late, on
// the last third of the beat. One beat is 60 / 64 seconds, so the off-beat moves
// from half way (0.5) to two thirds of the way (0.667) through it, a push of one
// sixth of a beat. A patterned nudge applies that push to the off-beats only:
// '[0 x]*4' is "on time, late" four times a bar, and each note reads the step
// that covers its onset. Notes on the beat stay put.
const BEAT = 60 / 64;
const SWING = '[0 ' + (BEAT / 6).toFixed(3) + ']*4';

// ---------------------------------------------------------------------------
// HARMONY. One chord symbol per bar (two where a bar is bracketed). These are the
// changes a jazz player would read from a lead sheet.
//   A, first ending:  I  VI7  ii  V  iii  VI7  ii  V          (back to the top)
//   A, second ending: the same, closing ii-V into I
//   Bridge:           ii-V into IV (Bb), then iiø-V into ii (Gm), then V
const intro = '<Gm7 C7 Gm7 C7>';
const aFirst = '<Fmaj7 D7 Gm7 C7 Am7 D7 Gm7 C7>';
const aSecond = '<Fmaj7 D7 Gm7 C7 Am7 D7 [Gm7 C7] Fmaj7>';
const bridge = '<Cm7 F7 Bbmaj7 Bbmaj7 Am7b5 D7 Gm7 C7>';
const tag = '<[Gm7 C7] [Am7 D7] [Gm7 C7] Fmaj9>';

// KEYS. chord().voicing() turns each symbol into its notes. Left alone it voices
// around middle C; anchor: 'a3' keeps every root between F3 and D4, so the hand
// stays in one comfortable place while the chords change underneath it.
// A warm, slightly dark electric-piano stand-in: a triangle through a lowpass,
// a quick decay to a soft held level, and a long release so the chords overlap.
const keys = (changes) =>
  chord(changes)
    .voicing({ anchor: 'a3' })
    .sound('triangle')
    .attack(0.01).decay(0.8).sustain(0.35).release(0.9)
    .lpf(1700)
    .gain(0.06)
    .room(0.25).roomsize(3).orbit(1);

// A comping rhythm, written by a helper instead of by hand: the "Charleston", a
// chord on beat one and another on the "and" of two (3 eighths, then 5). Bars
// that already hold two chords are left as they are.
const charleston = (changes) =>
  '<' +
  changes
    .slice(1, -1)
    .split(/ (?![^[]*])/)
    .map((bar) => (bar.startsWith('[') ? bar : '[' + bar + '@3 ' + bar + '@5]'))
    .join(' ') +
  '>';

// A quiet sustained pad behind the bridge and the last A, voiced a little higher.
const pad = (changes) =>
  chord(changes)
    .voicing({ anchor: 'd4' })
    .sound('sine')
    .attack(0.8).sustain(0.8).release(1.5)
    .gain(0.03)
    .room(0.5).roomsize(5).orbit(2);

// ---------------------------------------------------------------------------
// BASS. Half notes (root, fifth) for the first two As: the ballad "two-feel".
// From the bridge on it walks in quarter notes, stepping and approaching each new
// root from a step away. .legato(0.95) holds every note for 95% of its slot, so
// the line sounds joined, like a plucked upright, without smearing into the next.
const bassVoice = (line) =>
  note(line)
    .sound('triangle')
    .attack(0.01).decay(0.3).sustain(0.55).release(0.2)
    .legato(0.95)
    .lpf(650)
    .gain(0.3);
const bassIntro = '<[g2 d2] [c2 g2] [g2 d2] [c2 bb1 a1 e2]>';
const bassAFirst = '<[f2 c3] [d2 a2] [g2 d2] [c2 g2] [a2 e2] [d2 f#2] [g2 d2] [c2 g2]>';
const bassASecond = '<[f2 c3] [d2 a2] [g2 d2] [c2 g2] [a2 e2] [d2 f#2] [g2 c2] [f2 c2]>';
const bassBridge =
  '<[c2 d2 eb2 e2] [f2 a2 c3 b2] [bb2 a2 f2 d2] [bb1 c2 d2 e2] [a2 g2 eb2 c2] [d2 f#2 a2 c3] [bb2 a2 g2 f2] [c2 e2 g2 e2]>';
const bassAWalk =
  '<[f2 a2 c3 a2] [d2 f#2 a2 f#2] [g2 a2 bb2 b2] [c3 bb2 g2 e2] [a2 g2 e2 c2] [d2 c2 a1 f#1] [g1 bb1 c2 e2] [f2 c2 a1 c2]>';
const bassTag = '<[g2 d2 c2 g1] [a1 e2 d2 a1] [g1 d2 c2 e2] f2>';

// ---------------------------------------------------------------------------
// MELODY. Eight slots per bar (eighth notes); @ makes a note longer. The whole A
// section grows from one idea, a little arch: c5 a4 c5 e5 in bar 1. Bar 3 is the
// same shape a step lower (bb4 g4 bb4 d5), and bar 5 lifts it to the top of the
// phrase (e5 c5 e5 g5). The F#5 in bar 6 is the D7's own third, the one note
// outside F major, and the reason that bar aches a little.
const aBars = [
  '[c5@2 a4 c5 e5@4]', // Fmaj7 — the idea
  '[d5@3 c5 a4@4]', //    D7
  '[bb4@2 g4 bb4 d5@4]', // Gm7 — the idea, a step down
  '[c5@3 bb4 g4@4]', //   C7
  '[e5@2 c5 e5 g5@4]', // Am7 — the idea, at the top
  '[f#5@3 e5 d5@2 c5@2]', // D7
  '[d5@2 bb4@2 a4@2 g4@2]' // Gm7
];
const aFirstMelody = [...aBars, '[g4@4 ~@2 a4 bb4]']; // C7, with a pickup back to bar 1
const aSecondMelody = [...aBars.slice(0, 6), '[d5@2 bb4@2 e4@2 g4@2]', '[f4@6 ~@2]'];
// The bridge answers in a new key area (Bb), with the darker Eb of Cm7 and
// Am7b5, and a flattened ninth (eb5 over D7) on the way back.
const bridgeMelody = [
  '[~@2 g4 bb4 eb5@4]', //  Cm7
  '[eb5@3 c5 a4@4]', //     F7
  '[~@2 f4 a4 d5@4]', //    Bbmaj7
  '[c5@3 bb4 a4@4]', //     Bbmaj7 (a lydian run answers here)
  '[~@2 c5 eb5 g5@4]', //   Am7b5
  '[f#5@3 eb5 d5@2 c5@2]', // D7
  '[bb4@3 a4 g4@2 f4@2]', // Gm7
  '[e4@4 ~@2 a4 bb4]' //    C7, pickup into the last A
];
const tagMelody = ['[a4@4 bb4@2 g4@2]', '[c5@4 a4@2 f#4@2]', '[g4@2 bb4@2 e5@2 d5@2]', '[f5@8]'];

// A muted-horn lead: a sawtooth darkened by a lowpass, a slow-ish attack so notes
// swell in like breath, and real sustain, since a horn holds its notes.
const horn = (bars) =>
  note('<' + bars.join(' ') + '>')
    .sound('sawtooth')
    .attack(0.06).decay(0.2).sustain(0.7).release(0.35)
    .lpf(1300)
    .gain(0.12)
    .nudge(SWING)
    .room(0.3).orbit(1);

// For the last A, a soft sine doubles the tune an octave up, like a vibraphone
// joining in. Rather than retype the bars, a regular expression adds one to
// every octave number: 'c5' becomes 'c6', 'bb4' becomes 'bb5'.
const octaveUp = (bars) =>
  bars.map((bar) => bar.replace(/([a-g](?:#|b)?)(\\d)/g, (_, name, octave) => name + (Number(octave) + 1)));
const vibes = (bars) =>
  note('<' + octaveUp(bars).join(' ') + '>')
    .sound('sine')
    .attack(0.005).decay(0.9).sustain(0.15).release(0.8)
    .gain(0.045)
    .nudge(SWING)
    .room(0.45).roomsize(5).orbit(2); // the same room size as the pad: one orbit, one room

// ---------------------------------------------------------------------------
// SCALE RUNS. A mode is one scale started from a different note. Every run here
// uses F major's own notes (or the bridge's Bb major), started from the root of
// the chord underneath, so each run fits its bar exactly:
//   dorian over a minor ii chord, mixolydian over a dominant V, lydian over the
//   major IV, locrian over the half-diminished chord.
// n() takes scale degrees and .scale() makes them pitches; 0 to 7 is one octave up.
// A run fills the second half of a bar, eight sixteenths, where the horn rests.
// .scale() takes one fixed scale, so each bar's run is its own pattern and cat()
// strings the bars together, with silence where there is no run.
const run = (spec, direction) =>
  n(direction === 'up' ? '[~ [0 1 2 3 4 5 6 7]]' : '[~ [7 6 5 4 3 2 1 0]]')
    .scale(spec)
    .sound('triangle')
    .attack(0.003).decay(0.18).sustain(0.15).release(0.15)
    .lpf(2600)
    .gain(0.08)
    .nudge(SWING)
    .room(0.3).orbit(1);
const introRuns = cat(run('G3:dorian', 'up'), run('C4:mixolydian', 'down'), silence, run('C4:mixolydian', 'up'));
const bridgeRuns = cat(silence, silence, silence, run('Bb3:lydian', 'up'), run('A3:locrian', 'up'), silence, silence, silence);
const tagRuns = cat(silence, silence, silence, run('F4:major', 'down'));

// ---------------------------------------------------------------------------
// BRUSHES. Noise does the drummer's work: a soft pink "swish" on every beat,
// and a brighter white tap on beats 2 and 4 with a swung ghost note before it.
// .velocity() sets how hard each one is played without changing its sound.
const swish = sound('pink*4')
  .attack(0.06).decay(0.3).sustain(0).release(0.1)
  .hpf(1800).lpf(6000)
  .velocity('0.7 0.5 0.6 0.5')
  .gain(0.06);
const taps = sound('[~ ~ ~ white ~ ~ ~ white]')
  .attack(0.001).decay(0.06).sustain(0).release(0.05)
  .hpf(3000)
  .gain(0.07)
  .nudge(SWING)
  .room(0.15).orbit(1);
const ghosts = sound('[~ ~ white ~ ~ ~ white ~]')
  .attack(0.001).decay(0.04).sustain(0).release(0.03)
  .hpf(4000)
  .velocity('<0.5 0.35>')
  .gain(0.05)
  .nudge(SWING);
const brushes = stack(swish, taps);
const brushesBusy = stack(swish, taps, ghosts);

// ---------------------------------------------------------------------------
// SECTIONS. The song builds by adding parts, not by playing louder:
//   intro  (4)  keys and bass trade a ii-V, scale runs answer
//   A1     (8)  the horn states the tune, brushes come in, bass in two
//   A2     (8)  the tune again, with its closing ending
//   bridge (8)  the bass starts walking, the keys comp in a rhythm, a pad opens up
//   A3     (8)  the tune once more, doubled by vibes, the band at its fullest
//   tag    (4)  a turnaround played twice as fast, ending on Fmaj9
return arrange(
  [4, stack(keys(intro), bassVoice(bassIntro), introRuns, swish.velocity(0.4))],
  [8, stack(keys(aFirst), bassVoice(bassAFirst), horn(aFirstMelody), brushes)],
  [8, stack(keys(aSecond), bassVoice(bassASecond), horn(aSecondMelody), brushes)],
  [8, stack(keys(charleston(bridge)), pad(bridge), bassVoice(bassBridge), horn(bridgeMelody), bridgeRuns, brushesBusy)],
  [8, stack(keys(charleston(aSecond)), pad(aSecond), bassVoice(bassAWalk), horn(aSecondMelody), vibes(aSecondMelody), brushesBusy)],
  [4, stack(keys(tag), bassVoice(bassTag), horn(tagMelody), tagRuns, swish)]
);

// Try this:
//   • Change SWING to '[0 0]*4' and hear the same notes played straight, then
//     try BEAT / 4 for a heavier, lazier shuffle.
//   • Move the keys' anchor to 'c5' and the whole band seems to step forward.
//   • Swap 'Bb3:lydian' for 'Bb3:major' in bridgeRuns: one note (E becomes Eb)
//     and the run stops fitting the key around it.`
};
