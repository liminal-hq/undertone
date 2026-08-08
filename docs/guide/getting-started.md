---
title: Getting Started
---

# Getting Started

You've skimmed the feature list — now let's actually write some undertone code. Everything below is runnable; keep the [API reference](/api/) open alongside for the definitive one-entry-per-call listing once you're past the basics.

## The mental model: everything is a pattern

Undertone has exactly one central idea. A `Pattern` is a description of events laid out across _cycles_ of abstract time — it doesn't make sound, hold audio nodes, or know about the clock. Every constructor (`note()`, `sound()`, `n()`, `chord()`, `s()`) returns a pattern; every chained method (`.gain()`, `.lpf()`, `.fast()`, `.every()`) returns a _new_ pattern wrapping the old one, so patterns are immutable and always safe to branch, reuse, and combine.

Sound happens only at the very end, in one of two ways:

- `.play()` fires **one cycle, once** — the events are realized as percussive voices and forgotten. This is the game-SFX path: a click, a thunk, a fanfare.
- `.loop({ bpm })` runs the pattern **forever** on a lookahead scheduler — each event's envelope is _gated_ by the event's length, which is what turns the same pattern machinery into held notes and grooves. It returns a handle whose `stop()` ends the loop.

Once you hold onto this, the rest of the API is just vocabulary: mini-notation describes _when_ events happen within a cycle, the chainable controls describe _what_ each voice sounds like, and the combinators (`stack`, `seq`, `cat`, `arrange`) glue patterns into bigger patterns. A UI blip, a bassline, and an entire multi-section song are all the same kind of object.

## Your first sound

```ts
import { note } from '@liminal-hq/undertone';

// Call this from a click handler or other user gesture:
note('c5').sound('triangle').decay(0.1).gain(0.5).play();
```

Line by line:

- `note('c5')` builds a pattern containing a single pitched event per cycle — C in the fifth octave. Note names are letter + optional `#`/`b` accidental + octave (`'c2'`, `'f#3'`, `'bb3'`); a raw Hz number works too (`note(440)`).
- `.sound('triangle')` picks the oscillator waveform. The choices are `'sine'` (the default), `'triangle'`, `'square'`, `'sawtooth'`, plus three noise colours `'white' | 'pink' | 'brown'`.
- `.decay(0.1)` shapes the amplitude envelope. The defaults are already percussive (fast attack, short decay, sustain 0), so a one-shot sounds like a blip without any envelope calls at all — this just shortens it.
- `.gain(0.5)` sets peak amplitude, 0 to 1.
- `.play()` schedules one cycle's worth of events on an `AudioContext` and returns immediately.

The one environmental catch: when you don't pass your own context, undertone lazily creates a shared `AudioContext` on first use, and browsers refuse to start audio outside a user gesture (autoplay policy). Make sure the _first_ `play()` or `loop()` in your app happens inside a click/keypress/tap handler; after that, fire away from anywhere.

For a richer one-shot, layer voices with `stack()` — this is the placed-building sound from `demo/placeBuilding.ts`, a low thunk plus a high sparkle plus a noise click, all starting together:

```ts
import { note, sound, stack } from '@liminal-hq/undertone';

const placeBuilding = stack(
  note('c2')
    .sound('triangle')
    .attack(0.001)
    .decay(0.1)
    .release(0.05)
    .gain(0.9)
    .lpf(220)
    .slide(0.07),
  note('c6').sound('sine').attack(0.001).decay(0.15).gain(0.3).lpf(2000).nudge(0.02),
  sound('white').attack(0).decay(0.02).release(0.01).gain(0.4).lpf(4000)
);

placeBuilding.play();
```

`.nudge(0.02)` offsets a voice's start by seconds (great for arpeggiated one-shots), and `.slide(0.07)` glides the pitch down from an octave above — the classic downward "thunk".
