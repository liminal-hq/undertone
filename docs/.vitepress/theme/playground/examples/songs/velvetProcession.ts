// Playground example: Velvet Procession
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ComposerExample } from '../../exampleTypes';

export const velvetProcession: ComposerExample = {
  label: 'Velvet Procession',
  bpm: 72,
  code: `// "Velvet Procession II" — acoustic/orchestral/electronic trip-hop, 63 bars.
// Dry picked acoustic instruments up front, plucked orchestral transients,
// a sustained/wobbling string body behind them, a piano-synth pulse,
// resonant acoustic bass, restrained drums with transition hats, and very
// distant human/room colour. Most importantly: the arrangement starts
// building immediately, evolving every 1-2 bars instead of holding a
// static intro. A full port onto the real API — no samples ship with
// undertone, so every gm_* / drum-machine reference in the original
// sketch becomes a synthesized stand-in, and every held layer gets an
// explicit .sustain() so it actually rings through its note instead of
// the engine's percussive sustain:0 default cutting it short.

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
  RolandTR707_oh: { buffer: decayingNoiseBuffer(2500, 5) }
});

// AIR — almost subliminal. This isn't "noise texture"; it's just enough
// high-frequency room information to keep the recording from feeling
// digitally empty. Sustained so it's actually always there.
const air = s('pink').hpf(3400).lpf(7800).sustain(0.9).gain(0.0045).room(0.48).roomsize(5).orbit(30);

// PLUCKED STRING FRONT — short attack, but not completely dead
// afterwards. The upper voices share common tones, so the harmony
// changes underneath a related physical gesture: plucked != disconnected.
const pizz = note(
  \`<
    [a3 e4 a4 c5 e5 c5]
    [a3 e4 a4 c5 e5 a4]
    [g3 e4 g4 c5 e5 g4]
    [g3 d4 g4 a4 d5 a4]
  >\`
)
  .sound('triangle')
  .attack(0.002)
  .release(0.32)
  .hpf(180)
  .lpf(5000)
  .gain('.155 .12 .145 .12 .16 .115')
  .room(0.15)
  .orbit(1);

// PLUCK TONAL TAIL — the pizzicato provides the "TAK"; this provides the
// "taaah...". Quiet enough that the listener hears both as one
// complicated instrument, and a touch of sustain gives it an actual tail.
const pizzTail = note(
  \`<
    [a4 e5 c5 e5]
    [a4 e5 c5 e5]
    [g4 e5 c5 e5]
    [g4 d5 a4 d5]
  >\`
)
  .sound('triangle')
  .attack(0.008)
  .sustain(0.3)
  .release(0.48)
  .hpf(400)
  .lpf(2800)
  .gain(0.032)
  .room(0.46)
  .roomsize(4.5)
  .orbit(31);

// PLUCK ROOM — a third component: a few plucks get a separate distant
// reflection, while the front transient stays articulate.
const pizzRoom = note(
  \`<
    [~ ~ a5 ~ ~ c5]
    [~ ~ ~ ~ e5 ~]
    [~ e5 ~ ~ ~ g5]
    [~ ~ g5 ~ d5 ~]
  >\`
)
  .sound('triangle')
  .attack(0.002)
  .release(0.65)
  .hpf(650)
  .lpf(4300)
  .gain(0.027)
  .room(0.86)
  .roomsize(8)
  .delay(0.12)
  .pan('<-0.5 0.44 -0.24 0.34>')
  .orbit(32);

// LOW PLUCK
const pizzLow = note(
  \`<
    [a2 ~ e3 ~]
    [f2 ~ c3 ~]
    [c3 ~ g2 ~]
    [g2 ~ d3 ~]
  >\`
)
  .sound('triangle')
  .attack(0.002)
  .release(0.38)
  .lpf(2200)
  .gain(0.1)
  .room(0.17)
  .orbit(2);

// WOBBLING VIOLIN BED — this is the important correction: the plucked
// strings aren't sitting alone. Behind them is an almost continuously
// breathing, slightly unstable ensemble filling the gaps between
// attacks. The phaser gives movement; the long attack and a real
// sustain keep it from fighting the plucks.
const violins = chord('<Amadd9 Fmaj7 C6 Gsus2>')
  .voicing()
  .sound('sawtooth')
  .attack(0.32)
  .sustain(0.85)
  .release(1.15)
  .lpf(2600)
  .gain(0.052)
  .phaser(1.6)
  .room(0.54)
  .roomsize(6)
  .orbit(3);

// WOBBLING SHADOW — a slightly delayed second ensemble. Tiny disagreement
// in timing and phase creates motion: rather than "STRINGS", something
// closer to "sssSTRRiiinnGGsss~~".
const violinsShadow = chord('<Amadd9 Fmaj7 C6 Gsus2>')
  .voicing()
  .sound('sawtooth')
  .attack(0.42)
  .sustain(0.85)
  .release(1.2)
  .hpf(420)
  .lpf(3400)
  .gain(0.02)
  .late(0.014)
  .phaser(0.9)
  .room(0.72)
  .roomsize(7.5)
  .pan('<-0.36 0.36>')
  .orbit(4);

// ACOUSTIC GUITAR — the human/wooden rhythmic element. Not as busy as it
// could be; it fits between the orchestral plucks.
const guitar = note(
  \`<
    [a3 ~ e4 ~ c4 e4]
    [f3 ~ c4 ~ a3 c4]
    [c4 ~ g3 ~ e4 g4]
    [g3 ~ d4 ~ b3 d4]
  >\`
)
  .sound('square')
  .attack(0.002)
  .release(0.24)
  .hpf(100)
  .lpf(5400)
  .gain(0.19)
  .room(0.09)
  .orbit(5);

// Guitar thumb/body.
const guitarBody = note(
  \`<
    [a2 ~ ~ e3]
    [f2 ~ ~ c3]
    [c3 ~ ~ g2]
    [g2 ~ d3 ~]
  >\`
)
  .sound('square')
  .attack(0.004)
  .release(0.38)
  .lpf(2300)
  .gain(0.09)
  .room(0.16)
  .orbit(5);

// FAKE PICK / STRING CONTACT NOISE — a tiny physical "tk/sk/chk" under
// selected guitar attacks. Very quiet.
const pickNoise = s(
  \`<
    [white ~ white ~ [white white] ~]
    [white ~ ~ white ~ white]
    [white ~ white ~ ~ white]
    [white ~ [white white] ~ white ~]
  >\`
)
  .attack(0.001)
  .decay(0.009)
  .sustain(0)
  .release(0.012)
  .hpf(4300)
  .lpf(8500)
  .gain('.010 .006 .012 .007')
  .pan('<-0.16 0.16 -0.08 0.08>')
  .orbit(33);

// GUITAR ROOM THROW
const guitarRoom = note(
  \`<
    ~
    [~ ~ ~ ~ c4 ~]
    ~
    [~ d4 ~ ~ ~ ~]
  >\`
)
  .sound('square')
  .attack(0.003)
  .release(0.62)
  .hpf(450)
  .lpf(3900)
  .gain(0.031)
  .room(0.89)
  .roomsize(8)
  .delay(0.15)
  .pan('<-0.46 0.46>')
  .orbit(34);

// PIANO-SYNTH PULSE — the layer that pulls the song along. Not a piano
// melody; a resonant rhythmic chord/object. Slight phase movement plus a
// real sustain lets one attack overlap the next acoustic events instead
// of just clicking and dying.
const pianoPulse = note(
  \`<
    [a3 ~ e4 ~]
    [f3 ~ c4 ~]
    [c4 ~ g3 ~]
    [g3 ~ d4 ~]
  >\`
)
  .sound('sine')
  .attack(0.008)
  .sustain(0.65)
  .release(0.62)
  .hpf(150)
  .lpf(3500)
  .gain(0.16)
  .phaser(0.7)
  .room(0.3)
  .roomsize(3.8)
  .orbit(6);

// PIANO UPPER SHIMMER — only a faint upper component, so the piano feels
// more like a processed sample than an obvious synth patch.
const pianoGlow = note(
  \`<
    [e5 ~ c5 ~]
    [e5 ~ c5 ~]
    [e5 ~ g4 ~]
    [d5 ~ a4 ~]
  >\`
)
  .sound('triangle')
  .attack(0.012)
  .sustain(0.4)
  .release(0.58)
  .hpf(800)
  .lpf(3900)
  .gain(0.025)
  .room(0.68)
  .roomsize(6)
  .delay(0.09)
  .orbit(35);

// ACOUSTIC/UPRIGHT BASS — enters early: the low end expands massively
// around 13-17 seconds in the original mix analysis. Long enough to
// resonate, active enough to pull the harmony forward.
const bass = note(
  \`<
    [a2 ~ e3 a2]
    [f2 ~ c3 a2]
    [c3 ~ g2 e3]
    [g2 d3 e3 g2]
  >\`
)
  .sound('sawtooth')
  .attack(0.009)
  .sustain(0.55)
  .release(0.68)
  .lpf(1550)
  .gain('.44 .39 .42 .37')
  .room(0.12)
  .orbit(7);

// BASS BODY
const bassBody = note('<a1 f1 c2 g1>')
  .sound('sine')
  .attack(0.035)
  .sustain(0.7)
  .release(1.35)
  .lpf(235)
  .gain(0.105)
  .room(0.23)
  .roomsize(4)
  .orbit(36);

// BASS ROOM HARMONICS — don't send the sub-bass into the hall; reverb
// mostly the upper body of the instrument. That's what gives depth
// without mud.
const bassRoom = note(
  \`<
    [a2 ~ ~ e3]
    [f2 ~ ~ c3]
    [c3 ~ ~ g2]
    [g2 ~ d3 ~]
  >\`
)
  .sound('sawtooth')
  .attack(0.01)
  .sustain(0.5)
  .release(0.82)
  .hpf(170)
  .lpf(1150)
  .gain(0.05)
  .room(0.62)
  .roomsize(6)
  .orbit(37);

// BASS TRANSITION
const bassTurn = note(
  \`<
    ~
    ~
    ~
    [~ d3 e3 g3]
  >\`
)
  .sound('sawtooth')
  .attack(0.008)
  .release(0.24)
  .lpf(1800)
  .gain(0.18)
  .room(0.14)
  .orbit(7);

// DRUMS — based more on what worked before: sparse, providing weight and
// transitions while guitar/pluck/piano carry the continuous movement.
const kick = s(
  \`<
    [bd ~ ~ ~]
    [bd ~ ~ bd]
    [bd ~ ~ ~]
    [bd ~ [~ bd] ~]
  >\`
)
  .bank('RolandTR707')
  .gain(0.48)
  .orbit(8);

const snare = s(
  \`<
    [~ sd ~ ~]
    [~ sd ~ ~]
    [~ sd ~ ~]
    [~ sd ~ sd]
  >\`
)
  .bank('RolandTR707')
  .gain(0.34)
  .hpf(520)
  .room(0.045)
  .orbit(8);

const snareRoom = s(
  \`<
    [~ sd ~ ~]
    [~ sd ~ ~]
    [~ sd ~ ~]
    [~ sd ~ sd]
  >\`
)
  .bank('RolandTR707')
  .gain(0.05)
  .hpf(850)
  .lpf(6100)
  .room(0.88)
  .roomsize(7.5)
  .orbit(38);

// Little human ghosts.
const drumGhost = s(
  \`<
    [~ ~ [sd ~] ~]
    [~ rim ~ ~]
    [~ ~ [sd ~] ~]
    [~ rim [~ sd] ~]
  >\`
)
  .bank('RolandTR707')
  .gain(0.065)
  .hpf(1150)
  .room(0.19)
  .orbit(9);

// Transition hi-hat — still deliberately not continuous. High-frequency
// energy appears near the phrase boundary, making the section feel as
// though it inhales.
const hats = s(
  \`<
    ~
    ~
    ~
    [~ hh [hh hh] oh]
  >\`
)
  .bank('RolandTR707')
  .gain('.065 .08 .055 .06')
  .hpf(4800)
  .room(0.19)
  .orbit(10);

// Drum turn.
const drumTurn = s(
  \`<
    ~
    ~
    ~
    [~ rim [sd rim] [sd sd]]
  >\`
)
  .bank('RolandTR707')
  .gain(0.092)
  .hpf(1050)
  .room(0.25)
  .roomsize(3)
  .orbit(11);

const drums = stack(kick, snare, snareRoom, drumGhost, hats, drumTurn);

// Slightly larger drum state — not "chorus drums", more like the room
// suddenly has a little more movement.
const drumsOpen = stack(
  kick,
  snare,
  snareRoom,
  drumGhost,
  hats,
  drumTurn,
  s(
    \`<
      ~
      [~ ~ rim ~]
      ~
      [~ rim ~ rim]
    >\`
  )
    .bank('RolandTR707')
    .gain(0.047)
    .hpf(1900)
    .pan('<-0.44 0.44>')
);

// HIGH PIZZICATO DETAIL — introduced later, makes the orchestration feel larger.
const pizzHigh = note(
  \`<
    [~ e5 ~ c5]
    [~ e5 ~ a4]
    [g5 ~ e5 ~]
    [~ d5 ~ a4]
  >\`
)
  .sound('triangle')
  .attack(0.002)
  .release(0.26)
  .hpf(650)
  .lpf(5800)
  .gain(0.06)
  .room(0.35)
  .pan('<0.4 -0.4 0.26 -0.26>')
  .orbit(12);

// STRING PHRASE LIFT — brief rather than a big orchestral melody: think
// the ensemble physically rising at the transition.
const stringLift = note(
  \`<
    ~
    ~
    ~
    [a4 c5 e5 a5]
  >\`
)
  .sound('sawtooth')
  .attack(0.1)
  .sustain(0.6)
  .release(0.72)
  .hpf(380)
  .lpf(4100)
  .gain(0.064)
  .room(0.69)
  .roomsize(7)
  .orbit(13);

// DISTANT "LA LA" SUBSTITUTE — human voice as soundscape. Strategically
// placed, not constant.
const ghostVox = note(
  \`<
    ~
    [~ e5 ~ a4]
    ~
    [~ d5 e5 ~]
  >\`
)
  .sound('sine')
  .attack(0.22)
  .sustain(0.75)
  .release(1.05)
  .hpf(520)
  .lpf(3100)
  .gain(0.029)
  .room(0.93)
  .roomsize(9)
  .delay(0.17)
  .pan('<0.4 -0.4 0.24 -0.24>')
  .orbit(14);

// A very distant vocal reflection.
const ghostVoxFar = note(
  \`<
    ~
    ~
    [~ ~ c6 ~]
    ~
  >\`
)
  .sound('sine')
  .attack(0.35)
  .sustain(0.75)
  .release(1.4)
  .hpf(900)
  .lpf(2900)
  .gain(0.01)
  .late(0.017)
  .room(0.97)
  .roomsize(10)
  .delay(0.29)
  .orbit(15);

// LITTLE ELECTRONIC DETAIL — still a 90s electronically constructed
// recording: one small synthetic object wandering through the room.
const glassTick = note(
  \`<
    ~
    [~ ~ ~ e6]
    ~
    [~ b5 ~ ~]
  >\`
)
  .sound('triangle')
  .decay(0.038)
  .sustain(0)
  .hpf(1700)
  .lpf(5100)
  .gain(0.022)
  .delay(0.19)
  .room(0.46)
  .pan('<-0.48 0.5>')
  .orbit(16);

// SECTIONS — the opening deliberately evolves every 1-2 bars, giving the
// listener the initial identity and then immediately starting to change it.

// Bar one, ~3.3 seconds: give the listener the initial identity.
const seed = stack(air, pizz, pizzTail, guitar, pickNoise);

// Bar two: already deeper.
const bloom = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins
);

// Bars 3-4: piano arrives, the wobble widens, still no full low end.
const pulse = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow
);

// Bars 5-8: low end arrives (matching the ~13s bass-energy jump in the
// original mix analysis); drums begin quietly.
const foundation = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  drums,
  glassTick
);

// Everything established becomes an actual groove, kept layered front-to-back.
const verseA = stack(
  air,
  pizz,
  pizzTail,
  pizzLow,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  pianoPulse,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drums,
  glassTick
);

// More high-frequency orchestral energy — not dramatically louder; new
// things happen in the back and upper midrange.
const liftA = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drumsOpen,
  stringLift,
  ghostVox,
  glassTick
);

// Pull high density back but retain memories of the lift — never
// return all the way to the original verse.
const verseB = stack(
  air,
  pizz,
  pizzTail,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  pianoPulse,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drums,
  ghostVoxFar,
  glassTick
);

// Second lift.
const liftB = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drumsOpen,
  stringLift,
  ghostVox,
  ghostVoxFar,
  glassTick
);

// Crucial: don't stop the song. Drums vanish, but piano/pluck/guitar
// remain in motion — the giant room becomes obvious.
const suspended = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  guitar,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bassBody,
  bassRoom,
  ghostVox,
  ghostVoxFar
);

// Bass attack + drums reappear. Nothing needs to be hugely louder —
// restoring transients creates the impact.
const returnSection = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drumsOpen,
  stringLift,
  ghostVox,
  glassTick
);

// Biggest soundscape: front (guitar/pluck/drums), middle (piano/bass/tails),
// back (violin wobble/reverb/voices).
const finalLift = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drumsOpen,
  stringLift,
  ghostVox,
  ghostVoxFar,
  glassTick
);

// Pull the obvious beat away; leave the room ringing.
const outro = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  guitar,
  pickNoise,
  guitarRoom,
  violinsShadow,
  pianoGlow,
  bassBody,
  bassRoom,
  ghostVoxFar
);

// ARRANGEMENT — 63 bars total.
return arrange(
  [1, seed],
  [1, bloom],
  [2, pulse],
  [4, foundation],
  [8, verseA],
  [8, liftA],
  [8, verseB],
  [8, liftB],
  [4, suspended],
  [8, returnSection],
  [8, finalLift],
  [3, outro]
);`
};
