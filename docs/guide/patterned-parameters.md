---
title: Patterned Parameters
---

# Patterned parameters

Almost every numeric control accepts a mini-notation string instead of a scalar — `attack`, `decay`, `sustain`, `release`, `gain`, `lpf`, `lpenv`, `lpa`, `lpd`, `lps`, `lpr`, `hpf`, `phaser`, `room`, `roomsize`, `delay`, `delaytime`, `delayfeedback`, `slide`, `nudge`/`late`/`early`, and `pan` all do. The control string is its own little pattern: at each event's onset, whichever control step covers that instant supplies the value.

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

This is the cheapest way to add motion: `.lpf('400 800 1600 3200')` for a filter walk, `.slide('<0 .1>')` for a glide on alternating cycles, `.gain()` for accents. All values are validated eagerly when the pattern is built, so a typo throws at construction time, not mid-song.
