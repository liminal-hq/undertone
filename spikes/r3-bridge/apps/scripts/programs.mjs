// The five 0.4.0 programs of spike R3, each with the layer 3 case it must equal
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/** Each program is written the way a user writes it; `cycleSeconds` 0.5 makes the event 0.5 s long, as in the corpus. */
export const programs = [
  {
    id: 'placement-off-plain',
    source: "note('a3').sound('triangle').gain(0.3).sustain(0.5).release(0.2)",
    build: (note) => note('a3').sound('triangle').gain(0.3).sustain(0.5).release(0.2)
  },
  {
    id: 'placement-pan-default',
    source: "note('a3').sound('triangle').gain(0.3).sustain(0.5).release(0.2).pan(0.5)",
    build: (note) => note('a3').sound('triangle').gain(0.3).sustain(0.5).release(0.2).pan(0.5)
  },
  {
    id: 'placement-off-filter-envelope',
    source:
      "note('a3').sound('sawtooth').gain(0.3).sustain(0.5).release(0.2).lpf(600).lpenv(1200).lpd(0.2)",
    build: (note) =>
      note('a3').sound('sawtooth').gain(0.3).sustain(0.5).release(0.2).lpf(600).lpenv(1200).lpd(0.2)
  },
  {
    id: 'placement-pan-law-minus6',
    source: "note('a3').sound('triangle').gain(0.3).sustain(0.5).release(0.2).pan(0.5).panlaw(-6)",
    build: (note) =>
      note('a3').sound('triangle').gain(0.3).sustain(0.5).release(0.2).pan(0.5).panlaw(-6)
  },
  {
    id: 'placement-pan-path-ramp',
    source:
      "note('a3').sound('triangle').gain(0.3).sustain(0.5).release(0.2).panpath([{ pan: 1, time: 0 }, { pan: -1, time: 0.5 }])",
    build: (note) =>
      note('a3')
        .sound('triangle')
        .gain(0.3)
        .sustain(0.5)
        .release(0.2)
        .panpath([
          { pan: 1, time: 0 },
          { pan: -1, time: 0.5 }
        ])
  }
];
