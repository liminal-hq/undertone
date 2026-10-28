---
title: FM Synthesis
---

# FM synthesis

A plain oscillator has a fixed timbre. **FM (frequency modulation)** gives it a second oscillator, the _modulator_, that wobbles the first one's frequency at audio rate. The result is a spectrum of extra overtones whose strength you control with a single number, and it is how a small two-oscillator voice can sound like a bell, a reed, a bass or a metallic hit. Undertone's FM controls follow Strudel's `fm`/`fmh` family, with the same two ideas behind them as Tone.js's `FMSynth`: a **harmonicity** (the modulator's frequency as a multiple of the note's) and a **modulation index** (how hard it pushes).

```ts
import { note } from '@liminal-hq/undertone';

// A glassy bell: an inharmonic ratio, a strong index, and a long ring-out.
note('e5 b5 g5 d6').fm(1.4).fmh(3.5).attack(0.002).decay(0.6).release(0.8).gain(0.3).play();
```

## The controls

| Call                                                             | What it does                                                                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.fm(index)` `.fmi(index)`                                       | Modulation index. The pitch swings by `index × modulator frequency`, so brightness follows the note you play. 0 or unset adds no FM at all.              |
| `.fmh(ratio)`                                                    | Harmonicity: modulator frequency ÷ note frequency. Whole numbers sound like a harmonic, richer note; fractions (3.5, 2.76) sound like bells and metal.   |
| `.fmattack(s)` `.fmdecay(s)` `.fmsustain(level)` `.fmrelease(s)` | An envelope on the modulator's depth, separate from the amplitude envelope: a quick-decaying modulator is a bright attack that settles into a soft tone. |
| `.fmenv('lin' \| 'exp')`                                         | Whether those envelope stages ramp exponentially (default, as in Strudel) or linearly.                                                                   |
| `.fmwave(type)`                                                  | The modulator's waveform: `sine` (default), `triangle`, `square` or `sawtooth`.                                                                          |

Every numeric FM control accepts a mini-notation string, like the rest of the controls, so `.fm('1 3 2 6')` changes the index per note. `.fmenv()` and `.fmwave()` are chosen once for the pattern.

The index is _relative_ to the modulator's frequency. Because of that, a bass note and a lead note with the same `.fm(2)` have the same character, rather than the bass sounding dull and the lead harsh. FM applies to the synth waveforms; noise and samples ignore it.

## The modulator envelope

By default the index is constant for the whole note. Set any of the four `fm` envelope stages and the depth follows its own attack, decay, sustain and release, the same shape as the amplitude envelope but applied to the modulation:

```ts
// A pluck: bright at the start, then mellowing to a soft tone.
note('a2 ~ a2 e2')
  .sound('sine')
  .fm(4)
  .fmh(1)
  .fmdecay(0.15)
  .fmsustain(0.15)
  .sustain(0.5)
  .release(0.2)
  .loop({ bpm: 100 });
```

A decay on its own falls toward silence, as in Strudel; add `.fmsustain()` to settle at a level instead, and set only an attack to hold the full index afterwards. In a looped pattern the modulator, like the amplitude, holds for the note's length and releases afterwards.

## Pitch curves reach the modulator too

`.slide()`, `.penv()` and `.pitchsteps()` shape the note's pitch over time, and the modulator follows exactly, keeping its ratio and its depth in step. A laser zap or a rising sweep with an FM edge is a single chain:

```ts
note('a3').fm(3).fmh(2).penv(-12).pdecay(0.25).decay(0.3).play();
```

## Where to go next

- A filter envelope is a cheaper stand-in for a decaying modulator; the [recipes](/recipes#richer-voices-with-the-controls-you-already-have) show when it is enough.
- [Gate, velocity and cut groups](/guide/patterned-parameters) keep one FM instrument consistent from soft notes to accents.
- If you are used to Tone.js, [coming from Strudel](/coming-from-strudel#fm-synthesis) has a table mapping `harmonicity`, `modulationIndex` and `modulationEnvelope` onto these controls.
