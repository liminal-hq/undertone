// Playground example: Velvet Basement
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const velvetBasement: ComposerExample = {
  label: 'Velvet Basement',
  bpm: 86,
  code: `// "Velvet Basement" — a cinematic trip-hop/downtempo sketch, 80 bars.
// Built around a spacious half-time break, a live-feeling bass, dark
// extended chords, a distant "found-memory" pluck, filtered room tone,
// and an arrangement that moves by addition and subtraction rather than
// a drop. A full port onto the real API — no samples ship with
// undertone, so a tiny procedurally-generated noise-decay drum kit
// stands in for the break, and every synth voice gets an explicit
// .sustain() so it actually holds through its note instead of the
// engine's percussive sustain:0 default cutting it short.

// A decaying noise burst stands in for a real drum sample — the
// AudioBuffer constructor form needs no AudioContext, so this can just
// run inline instead of waiting for a play/loop button.
function decayingNoiseBuffer(length, decay) {
  const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: 44100 });
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-decay * (i / length));
    }
  }
  return buffer;
}

registerSamples({
  RolandTR707_bd: { buffer: decayingNoiseBuffer(4410, 4) },
  RolandTR707_sd: { buffer: decayingNoiseBuffer(3000, 6) },
  RolandTR707_hh: { buffer: decayingNoiseBuffer(800, 10) },
  RolandTR707_rim: { buffer: decayingNoiseBuffer(500, 12) },
  RolandTR909_oh: { buffer: decayingNoiseBuffer(2500, 5) }
});

// ATMOSPHERE — very quiet filtered noise: essentially a "tape/room" bed.
// .sustain(0.9) so it actually hums underneath the whole track instead
// of decaying away within a tenth of a second.
const air = s('pink').lpf(1600).attack(0.4).sustain(0.9).release(1).gain(0.018);

// HARMONIC BED — Dm9 -> BbM7 -> Gm9 -> A7sus. Extended/suspended harmony
// keeps the emotional character ambiguous instead of a straightforward
// pop progression. A real held chord pad, so it needs a high sustain.
const chords = chord('<Dm9 BbM7 Gm9 A7sus>')
  .voicing()
  .sound('triangle')
  .attack(0.35)
  .sustain(0.85)
  .release(1.4)
  .lpf(1450)
  .gain(0.16)
  .room(0.55)
  .roomsize(6)
  .orbit(1);

// A slightly brighter version for moments where the track opens up.
const chordsOpen = chord('<Dm9 BbM7 Gm9 A7sus>')
  .voicing()
  .sound('sawtooth')
  .attack(0.3)
  .sustain(0.85)
  .release(1.2)
  .lpf(2400)
  .gain(0.11)
  .room(0.65)
  .roomsize(6)
  .orbit(1);

// BASS — not an EDM sub pattern; let it behave like somebody is actually
// playing bass, with the occasional fifth/approach note and a gain that
// breathes across the four-bar phrase. Sustained enough to ring through
// its slot without turning into a held drone.
const bass = note(
  \`<
    [d2 ~ d2 a1]
    [bb1 ~ f2 a1]
    [g1 ~ d2 f2]
    [a1 ~ e2 g2]
  >\`
)
  .sound('sawtooth')
  .sustain(0.6)
  .release(0.3)
  .lpf(1050)
  .gain('.68 .5 .6 .55');

// MAIN BREAK — the kick deliberately does NOT hammer every beat; the
// snare gives the 2/4 backbeat; hats establish subdivision but stay
// subordinate. Should feel slow even with things happening between the
// main pulses.
const breakbeat = stack(
  s('bd ~ [~ bd] ~').bank('RolandTR707').gain(0.72),
  s('~ sd ~ sd').bank('RolandTR707').gain(0.58).room(0.08).orbit(2),
  s('hh [~ hh] hh [hh ~]').bank('RolandTR707').gain(0.19).late(0.008),
  s('~ ~ rim ~').bank('RolandTR707').gain(0.1).late(0.018)
);

// A slightly busier break for the larger sections.
const breakbeatOpen = stack(
  s('bd ~ [~ bd] [bd ~]').bank('RolandTR707').gain(0.75),
  s('~ sd ~ sd').bank('RolandTR707').gain(0.61).room(0.1).orbit(2),
  s('hh*8').bank('RolandTR707').gain(0.16).late(0.009),
  s('~ rim [~ rim] ~').bank('RolandTR707').gain(0.09).late(0.02),
  s('~ ~ ~ oh').bank('RolandTR909').gain(0.075)
);

// "FOUND MEMORY" MOTIF — plays the role an old soundtrack sample might
// play, but it's new melodic material: sparse, high register, short
// attack, large acoustic space. Should feel like this phrase belonged
// to another record before somebody sampled it — sustain(0) is
// deliberate here, a mallet-like pluck, not a pad.
const memory = n(
  \`<
    [0 ~ 4 2]
    [~ 3 ~ 1]
    [0 2 ~ 5]
    [~ 1 4 ~]
  >\`
)
  .scale('D5:minor')
  .sound('triangle')
  .decay(0.13)
  .sustain(0)
  .gain(0.15)
  .room(0.78)
  .roomsize(8)
  .delay(0.22)
  .delaytime(0.28)
  .delayfeedback(0.4)
  .orbit(3);

// A ghost copy creates a slightly unreal doubled quality.
const memoryGhost = n(
  \`<
    [0 ~ ~ 2]
    [~ 3 ~ ~]
    [0 ~ ~ 5]
    [~ ~ 4 ~]
  >\`
)
  .scale('D6:minor')
  .sound('triangle')
  .decay(0.08)
  .sustain(0)
  .gain(0.055)
  .room(0.9)
  .roomsize(9)
  .orbit(3);

// MUTED GUITAR FRAGMENTS — not a strumming guitar; think snippets
// caught by a sampler. Stays short and percussive on purpose.
const guitar = note(
  \`<
    [d4 ~ ~ a3]
    [~ f4 ~ ~]
    [g3 ~ d4 ~]
    [~ e4 ~ a3]
  >\`
)
  .sound('square')
  .release(0.12)
  .hpf(300)
  .lpf(1900)
  .gain(0.16)
  .room(0.3)
  .delay(0.15)
  .orbit(4);

// COUNTERLINE — intentionally absent most of the time; in a vocal song
// the singer would occupy this perceptual area. A little sustain gives
// it body without turning it into a full pad.
const counter = n(
  \`<
    [~ 4 ~ 3]
    [2 ~ ~ 4]
    [~ 1 2 ~]
    [3 ~ 1 ~]
  >\`
)
  .scale('D4:minor')
  .sound('sine')
  .attack(0.08)
  .sustain(0.5)
  .release(0.6)
  .phaser(0.4)
  .gain(0.11)
  .room(0.55)
  .orbit(1);

// SECTIONS
// 8 bars: intriguing, before the rhythmic identity becomes obvious.
const intro = stack(air, chords, memory);
// 16 bars: establish the actual track.
const bodyA = stack(air, chords, bass, breakbeat, memory);
// 8 bars: brighten the spectrum rather than changing the whole song.
const lift = stack(air, chords, chordsOpen, bass, breakbeatOpen, memory, memoryGhost, guitar);
// 16 bars: same universe, slightly more internal motion.
const bodyB = stack(air, chords, bass, breakbeat, memory, guitar, counter);
// 8 bars: take the floor away — the listener should notice how much the drums mattered.
const breakdown = stack(air, chords, memoryGhost, guitar);
// 16 bars: the biggest version — wider + brighter + denser, not just louder.
const returnFull = stack(
  air,
  chords,
  chordsOpen,
  bass,
  breakbeatOpen,
  memory,
  memoryGhost,
  guitar,
  counter
);
// 8 bars: leave the artefact behind after the groove disappears.
const outro = stack(air, chords, memory);

// ARRANGEMENT — 80 bars, matching the original sketch's structure exactly.
return arrange(
  [8, intro],
  [16, bodyA],
  [8, lift],
  [16, bodyB],
  [8, breakdown],
  [16, returnFull],
  [8, outro]
);`
};
