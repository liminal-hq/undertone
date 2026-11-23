// The patterns the worklet harness plays, as functions of the entry's names so a test can build them under Node as well
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * Builds the harness patterns from the package's names (`note`, `sound`, `stack`). Each is four cycles long, so a loop of it
 * repeats every four cycles; the voices and sends are the load: `representative` is a small song, `heavy` is about twice that
 * with a reverb and delay send on most of it, `light` is two voices a cycle.
 *
 * @param {{ note: Function, sound: Function, stack: Function }} api
 */
export function harnessPatterns({ note, sound, stack }) {
  const drums = stack(
    note('c1*4').sound('sine').penv(18).pdecay(0.06).decay(0.22).gain(0.9),
    sound('white*8').decay(0.03).gain(0.25).lpf(9000),
    sound('~ white ~ white').decay(0.12).gain(0.35).lpf(5000)
  );
  const bass = note('c2 [c2 eb2] g1 [bb1 c2]')
    .sound('sawtooth')
    .lpf(380)
    .lpenv(1800)
    .lpd(0.14)
    .decay(0.18)
    .gain(0.5);
  const chords = note('<[c4,eb4,g4,bb4] [ab3,c4,eb4,g4] [f3,ab3,c4,eb4] [g3,b3,d4,f4]>')
    .sound('triangle')
    .attack(0.02)
    .release(0.5)
    .gain(0.35)
    .room(0.5)
    .delay(0.3);
  const lead = note('g4 bb4 d5 c5 [eb5 d5] c5 bb4 g4')
    .sound('sine')
    .fm(2)
    .fmh(2)
    .decay(0.2)
    .gain(0.3)
    .room(0.3)
    .delay(0.4);
  return {
    representative: stack(drums, bass, chords, lead),
    heavy: stack(
      drums,
      note('c1*8').sound('sine').penv(12).pdecay(0.04).decay(0.12).gain(0.4),
      sound('white*16').decay(0.02).gain(0.2).lpf(11000).room(0.2),
      bass.room(0.2),
      chords,
      note('c3 eb3 g3 bb3 c4 eb4 g4 bb4')
        .sound('square')
        .lpf(1400)
        .decay(0.12)
        .gain(0.2)
        .room(0.4)
        .delay(0.35),
      lead,
      lead.late(0.125).gain(0.2)
    ),
    light: stack(
      note('c2 g1').sound('sawtooth').lpf(500).decay(0.3).gain(0.5),
      sound('white*4').decay(0.03).gain(0.2)
    )
  };
}
