---
title: Patterned Parameters
---

# Patterned parameters

Almost every numeric control accepts a number, a mini-notation string or a pattern, such as a [signal](/guide/signals) — a number applies to every event, a string is a little pattern of its own, and a pattern is read at each event's onset. `attack`, `decay`, `sustain`, `release`, `gain`, `lpf`, `lpenv`, `lpa`, `lpd`, `lps`, `lpr`, `hpf`, `phaser`, `room`, `roomsize`, `delay`, `delaytime`, `delayfeedback`, `slide`, `fm`/`fmi`, `fmh`, `fmattack`, `fmdecay`, `fmsustain`, `fmrelease`, `penv`, `pattack`, `pdecay`, `nudge`/`late`/`early`, `duration`, `legato`, `velocity`, and `pan` and `autopanphase` all do (the start of `panslide`, `autopan` and `autopandepth` too). The control string is its own little pattern: at each event's onset, whichever control step covers that instant supplies the value.

Before — a flat hi-hat line:

```ts
s('hh*8').gain(0.4).loop({ bpm: 120 });
```

After — the same events, with gain and pan varying per step:

```ts
s('hh*8').gain('[.5 .2 .35 .2]*2').pan('<-0.6 0.6>').loop({ bpm: 120 });
```

The gain string is a four-step curve sped up twice, lining up one value per hat — a strong accent on beats one and three, quieter offbeats in between — and the whole line alternates left/right each cycle via the `<>` in `pan`. The control string divides the cycle its own way and each event samples it at its own onset: without the `*2`, the four gain steps would each cover a quarter of the cycle, so consecutive pairs of hats would share a value. Structure always comes from the pattern being controlled, never from the control string — `.gain('.5 .2 .35 .2')` on a two-note pattern doesn't create extra notes.

A rest in a control string leaves that event's value _unset_ — the engine default (or whatever an earlier chained call set) applies, rather than zero. `.lpf('400 ~ 1600 ~')` gives the second and fourth events no lowpass at all, not a cutoff of 0.

## Patterns and signals as controls

Instead of a string you can pass any pattern of numbers. A signal is read at each event's onset, so `.pan(sine2)` gives every hat the sine at its own moment, and `.lpf(perlin.range(300, 3000))` is a slow random walk of the filter. The same events and the same sound come from `.gain(0.4)`, `.gain('0.4')` and `.gain(pure(0.4))`.

```ts live
import { perlin, rand, sine2, sound } from '@liminal-hq/undertone';

// Hats drifting across the stereo field, a wandering filter and a random accent on each.
sound('white*8')
  .attack(0.001)
  .decay(0.03)
  .pan(sine2.slow(4))
  .lpf(perlin.range(3000, 9000))
  .velocity(rand.seed(3).range(0.4, 1))
  .loop({ bpm: 120 });
```

A pattern is never allowed to stop the music. A bounded control clamps what a pattern gives it (`pan` and the start of `panslide` to -1 to 1, `autopandepth` and `autopanphase` to 0 to 1), an open bound leaves the control unset (`autopan` and `fmh` at or below 0, a negative `fm`, `duration`, `legato` or `velocity`, or a negative time such as `attack`, `decay`, `release`, `lpa`, `slide` or `delaytime`), and NaN, Infinity or a missing value leave it unset like a rest. Each case warns once in the console. The [Signals guide](/guide/signals#what-a-control-does-with-a-bad-value) has the table. A few controls only take plain values and throw if given a pattern: `fmenv`, `fmwave`, `autopanshape`, `cut`, `orbit`, `panlaw`, `channels`, `surround`, `panpath()` and `pitchsteps()`.

## Cheap motion

This is the cheapest way to add motion: `.lpf('400 800 1600 3200')` for a filter walk, `.slide('<0 .1>')` for a glide on alternating cycles, `.gain()` for accents. All number and string values are validated eagerly when the pattern is built, so a typo throws at construction time, not mid-song.
