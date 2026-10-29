---
title: Instruments & Scores
---

# Instruments and scores

Once a sound is worth keeping, you want to define it once and reuse it across a whole cue. These tools keep an instrument as plain data, thicken it with layers, write music with explicit timing instead of a grid, and add repeatable human variation. None of them need anything beyond the controls in the rest of the guide.

## Instruments as data

`fmVoice()` takes a definition shaped like Tone.js's `FMSynth` and returns a plain object of controls. Apply it to any pattern with `.voice()`:

```ts
import { fmVoice, fmPresets, note } from '@liminal-hq/undertone';

const bell = fmVoice({
  harmonicity: 3.5,
  modulationIndex: 5,
  envelope: { attack: 0.002, decay: 0.7, sustain: 0, release: 0.9 },
  modulationEnvelope: { decay: 0.35, release: 0.2 },
  level: 0.3
});

note('e5 g5 b5 a5').voice(bell).loop({ bpm: 100 });

// Or start from a preset and change one thing.
note('e2 ~ e2 b1')
  .voice({ ...fmPresets.roundBass, gainLevel: 0.6 })
  .loop({ bpm: 100 });
```

The result is JSON-safe, so an in-game sound editor can store and reload it. Because Tone's `modulationIndex` is relative to the carrier and Undertone's `.fm()` is relative to the modulator, `fmVoice()` divides it by the harmonicity for you. Controls chained after `.voice()` win, so `.gain(0.2)` turns a preset down without touching the rest. The presets (`glassBell`, `roundBass`, `softPad`, `pluck`, `lead`) are readable starting points more than finished instruments.

## Layering

A pluck and a sustained partner on the same notes sound far fuller than either alone. `layer()` stacks voices on one pattern, with a small start stagger, a level balance and opposite pans:

```ts
import { fmPresets, layer, note } from '@liminal-hq/undertone';

layer(note('e5 g5 b5 a5'), [fmPresets.pluck, fmPresets.softPad], {
  stagger: 0.002, // the second layer starts 2ms later: width, not an echo
  levels: [1, 0.6], // the pluck leads, the pad fills in
  pans: [-0.3, 0.3]
}).loop({ bpm: 100 });
```

Layering composes with the notes you give it. The stagger adds to any `nudge` they already carry (so `layer(drift(...), ...)` keeps its humanising), and `levels` multiply each note's own `velocity` (so scored accents survive). A `pans` entry replaces the notes' pan. A layer voice also keeps any control the notes carry that its own patch leaves unset, such as a waveform or filter from the incoming pattern, so put those in the voice patch.

## Scores with exact timing

A pattern is built on a grid of equal steps. Music played in by hand is not, and quantising it loses much of the feel. `score()` takes events at whole **ticks** (any rate you choose, such as AdLib's 560 per second) and compiles them to a pattern that keeps every event exactly where you put it:

```ts
import { fmPresets, score } from '@liminal-hq/undertone';

const cue = score({
  ticksPerSecond: 560,
  lengthTicks: 2240, // four seconds, including the quiet tail at the end
  events: [
    { tick: 0, note: 'e4', gate: 140, voice: fmPresets.lead },
    { tick: 211, note: 'g4', gate: 140, level: 0.7, voice: fmPresets.lead },
    { tick: 1120, midi: 52, gate: 280, voice: fmPresets.roundBass, pan: -0.1 }
  ]
});

const handle = cue.loop(); // plays at its own tempo; each pass lands exactly on the audio clock
```

`lengthTicks` is the loop length, so a rest at the end is part of the loop. `gate` is how long the key is held, and the instrument's release rings on after it, which is how a one-to-three-tick gate on a fast-decaying voice becomes a drum. A note still held at the seam is cut there by default (`seam: 'cut'`); pass `seam: 'ring'` to let the gate run on past it.

## Repeatable variation

A loop that sounds exactly the same every pass wears thin. `drift()` adds small per-note differences in timing, level, pitch and pan, and a constant push or pull, all from a seed:

```ts
import { drift, note } from '@liminal-hq/undertone';

const groove = drift(note('c2 ~ c2 g1'), {
  seed: 'level-1-bass',
  timing: 0.006, // up to 6 ms either way
  level: 0.1, // up to 10% either way
  cents: 6
});

groove.loop({ bpm: 100 });
```

The same seed always gives the same notes on every device, and the seed advances with each pass of the loop, so pass 2 differs from pass 1 but always in the same way. It uses its own generator (`seededRandom()` is exported if you want one), never `Math.random()`, so it cannot disturb a game's seeded simulation. Keep it off menu and interface sounds. `cyclesPerPass` sets how many cycles make up a pass for longer material.

## Checking a mix in mono

Many phone speakers are mono. `createMonoFold(ctx)` returns a node that folds whatever plays into it down to one channel; pass it as the `output` of a pattern to hear how a natively stereo cue balances on one speaker. It uses the standard speakers down-mix, `0.5 × (L + R)`: a centred voice keeps its level and a voice panned fully to one side drops 6 dB.
