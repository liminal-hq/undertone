// Showcase song: Pixel Quest, a chiptune adventure theme written for four console-style channels
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const pixelQuest: ComposerExample = {
  label: 'Pixel Quest (chiptune)',
  bpm: 144,
  code: `// "Pixel Quest" — a chiptune adventure theme in C major, 40 bars at 144 bpm (about 67 s).
// Written the way an old games console had to play it: four channels, two pulse
// waves, one triangle and one noise, each able to sound only one note at a time.
//
// Features shown:
//   • .cut(group) — one cut group per console channel, so each channel is monophonic
//   • .pitchsteps() — the classic fast chord arpeggio, one pitch per video frame
//   • .penv() — a pitch envelope that turns a triangle blip into a kick drum
//   • arrange() inside arrange() — the song form, with a drum fill built into every phrase
//   • a shaped wave ('halfsine') for the darker colour of the bridge

// ---------------------------------------------------------------------------
// THE FOUR CHANNELS. A cut group stops the previous note in the same group the
// moment a new one starts, which is exactly how a console channel behaves.
const PULSE1 = 1; // the lead melody
const PULSE2 = 2; // chord arpeggios
const TRIANGLE = 3; // bass, and the kick drum (they share the channel, as on the real chip)
const NOISE = 4; // snare and hi-hats

// ---------------------------------------------------------------------------
// ARPEGGIOS (pulse 2). A console has no chords, so composers flicked one channel
// through the chord's notes every couple of video frames, too fast to hear as a
// tune. .pitchsteps(offsets, rate) is that trick as data: one semitone offset
// per frame at 60 frames a second. Plain JavaScript builds a long enough list:
// root, third, fifth, two frames each, round and round for a whole bar.
const arpFrames = (third) => Array.from({ length: 100 }, (_, i) => [0, third, 7][Math.floor(i / 2) % 3]);
const MAJOR = arpFrames(4);
const MINOR = arpFrames(3);
// pitchsteps() takes one fixed list, so major and minor chords are two patterns.
const arp = (root, steps) =>
  note(root)
    .sound('square')
    .attack(0.002).decay(0.05).sustain(0.7).release(0.04)
    .lpf(3500)
    .gain(0.05)
    .pitchsteps(steps, 60)
    .cut(PULSE2);
const maj = (root) => arp(root, MAJOR);
const min = (root) => arp(root, MINOR);
// One chord per bar: C C F G Am F G C for the theme, a minor-key turn for the bridge.
const arpsTheme = cat(maj('c4'), maj('c4'), maj('f3'), maj('g3'), min('a3'), maj('f3'), maj('g3'), maj('c4'));
const arpsBridge = cat(min('a3'), min('e3'), maj('f3'), maj('c4'), min('d4'), maj('e3'), maj('f3'), maj('g3'));
const arpsEnd = cat(maj('f3'), maj('g3'), maj('c4'), silence);

// ---------------------------------------------------------------------------
// BASS (triangle). The bouncing octave bass of a hundred game soundtracks, on the
// off-beats so the kick can have the beats. A helper writes each bar:
// bounce('c2') is '[~ c2 ~ c3 ~ c2 ~ c3]'.
const bounce = (low) => {
  const high = low.slice(0, -1) + (Number(low.slice(-1)) + 1);
  return '[~ ' + low + ' ~ ' + high + ' ~ ' + low + ' ~ ' + high + ']';
};
const bassLine = (roots) =>
  note('<' + roots.map(bounce).join(' ') + '>')
    .sound('triangle')
    .attack(0.002).decay(0.08).sustain(0.6).release(0.03)
    .gain(0.3)
    .cut(TRIANGLE);
const bassTheme = bassLine(['c2', 'c2', 'f2', 'g2', 'a1', 'f2', 'g2', 'c2']);
const bassBridge = bassLine(['a1', 'e2', 'f2', 'c2', 'd2', 'e2', 'f2', 'g2']);
const bassEnd = bassLine(['f2', 'g2', 'c2']);

// ---------------------------------------------------------------------------
// DRUMS. The kick lives on the triangle channel: a short blip whose pitch starts
// two octaves up and falls in 60 milliseconds (.penv(24).pdecay(0.06)). Because it
// shares the bass's cut group, each kick chokes the bass note before it, the
// little gap that gives chip music its bounce.
const kick = note('[c2 ~ ~ ~ c2 ~ ~ ~]')
  .sound('triangle')
  .attack(0.001).decay(0.12).sustain(0).release(0.03)
  .penv(24).pdecay(0.06)
  .gain(0.4)
  .cut(TRIANGLE);
// Snare and hats both come from the noise channel, so they share a cut group too.
const snare = sound('[~ ~ white ~ ~ ~ white ~]')
  .attack(0.001).decay(0.12).sustain(0).release(0.05)
  .lpf(7000)
  .gain(0.16)
  .cut(NOISE);
const hats = sound('[~ white ~ white ~ white ~ white]')
  .attack(0.001).decay(0.025).sustain(0).release(0.01)
  .hpf(7000)
  .gain(0.06)
  .cut(NOISE);
const beat = stack(kick, snare, hats);
// A fill: eight snare hits getting harder, the classic "here comes the next part".
const fill = stack(
  kick,
  sound('white*8')
    .attack(0.001).decay(0.08).sustain(0).release(0.04)
    .lpf(6000)
    .velocity('0.3 0.4 0.5 0.6 0.7 0.8 0.9 1')
    .gain(0.16)
    .cut(NOISE)
);
// arrange() inside arrange(): seven bars of beat, then the fill. Every section that
// uses phraseDrums gets a fill on its last bar without anyone counting.
const phraseDrums = arrange([7, beat], [1, fill]);
// The bridge is "half-time": the snare only on beat three, so it feels slower.
const halfTime = stack(
  kick,
  sound('[~ ~ ~ ~ white ~ ~ ~]').attack(0.001).decay(0.15).sustain(0).release(0.05).lpf(6000).gain(0.16).cut(NOISE),
  hats
);

// ---------------------------------------------------------------------------
// MELODY (pulse 1). Eight eighth-note slots per bar; @ holds a note longer.
// The opening is a fanfare (c5 g4 c5 e5, up to c6 in bar 2) that every later
// phrase answers. Bar 7 is the only bar that differs between the first and
// second time through: once falling home, once climbing past it.
const themeBars = [
  '[c5@2 g4 c5 e5@2 d5 e5]', // C   — the fanfare
  '[c6@4 g5@2 e5@2]', //        C   — and its leap
  '[f5@2 e5 f5 a5@2 g5 f5]', // F
  '[g5@6 ~ g4]', //             G
  '[e5@2 a5@2 g5 e5 c5@2]', //  Am
  '[f5@2 a5@2 c6@2 a5 f5]' //   F
];
const themeOnce = [...themeBars, '[g5@2 f5 e5 d5@2 b4 d5]', '[c5@4 ~@2 g4@2]'];
const themeTwice = [...themeBars, '[d5@2 e5 f5 g5@2 a5 b5]', '[c6@6 ~@2]'];
// The bridge goes underground: A minor, lower and slower, with one G# (from the
// E major chord) for a hint of danger before it climbs back to the theme.
const bridgeBars = [
  '[a4@3 b4 c5@2 e5@2]', // Am
  '[b4@6 g4@2]', //         Em
  '[a4@3 g4 f4@2 a4@2]', // F
  '[g4@6 e4@2]', //         C
  '[f4@3 a4 d5@2 f5@2]', // Dm
  '[e5@4 g#4@2 b4@2]', //   E
  '[c5@2 a4@2 f5@2 a5@2]', // F
  '[g5@2 f5 e5 d5 c5 b4 d5]' // G — running up into the reprise
];
const endBars = ['[f5@2 a5@2 c6@4]', '[d6@2 b5@2 g5@4]', '[c6@8]', '~'];

const lead = (bars) =>
  note('<' + bars.join(' ') + '>')
    .sound('square')
    .attack(0.004).decay(0.1).sustain(0.6).release(0.05)
    .lpf(5000)
    .gain(0.1)
    .cut(PULSE1);
// The same channel in the bridge, with a different wave: 'halfsine' is a sine
// with its negative half cut away, hollow and reedy beside the square. (Its
// cousins 'abssine' and 'pulsesine' repeat twice a cycle, so they sound an
// octave up: try one here and the cave gets brighter.)
const caveLead = (bars) =>
  note('<' + bars.join(' ') + '>')
    .sound('halfsine')
    .attack(0.01).decay(0.15).sustain(0.7).release(0.1)
    .gain(0.16)
    .cut(PULSE1);

// ---------------------------------------------------------------------------
// SONG FORM. Each arrange() section starts its own alternations at bar one, so
// the theme's '<...>' always opens on the fanfare, wherever the section falls.
const intro = arrange(
  [2, stack(arpsTheme, hats)], // the arpeggio and hats alone...
  [2, stack(arpsTheme, bassTheme, beat)] // ...then the whole band but the tune
);
return arrange(
  [4, intro],
  [8, stack(lead(themeOnce), arpsTheme, bassTheme, phraseDrums)], //  A: the theme
  [8, stack(lead(themeTwice), arpsTheme, bassTheme, phraseDrums)], // A: the theme, climbing
  [8, stack(caveLead(bridgeBars), arpsBridge, bassBridge, halfTime)], // B: the cave
  [8, stack(lead(themeTwice), arpsTheme, bassTheme, phraseDrums)], // A: home again
  [4, stack(lead(endBars), arpsEnd, bassEnd, arrange([2, beat], [1, fill], [1, silence]))] // the ending
);

// Try this:
//   • Delete every .cut(...) and hear the channels pile up: the arpeggio smears
//     and the bass stops bouncing, because notes no longer stop each other.
//   • Change arpFrames' Math.floor(i / 2) to Math.floor(i / 1) for a faster,
//     buzzier arpeggio, or i / 4 to hear the chord's notes one by one.
//   • Give the lead .pitchsteps([0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, -0.3, 0], 30)
//     for a little vibrato (it holds the last value, so lengthen the list to keep it going).`
};
