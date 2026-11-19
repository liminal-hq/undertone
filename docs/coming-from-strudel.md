---
title: Coming from Strudel
---

# Coming from Strudel

If you write Strudel, most of your muscle memory works here: `note('c3 [e3 g3] <a3 b3>')`, `stack()`, `jux(rev)`, `.every(4, rev)`, euclidean `(3,8)` rhythms, chord symbols, scale names, `setcpm()`. What follows is the honest list of differences — the places where undertone deliberately behaves differently, has a smaller surface, or adds something Strudel doesn't have.

One thing to know up front: undertone is a clean-room, MIT-licensed implementation built from the published TidalCycles papers, standard music theory, and Strudel's public documentation and observable behaviour — never from Strudel's AGPL source, sample manifests, soundfont data, voicing dictionaries, or impulse responses. That's why it exists as a separate library (AGPL is a non-starter inside most shipped games), and it's also why several of the differences below are differences.

## It's a library, not a live-coding environment

Undertone is something you `import` into a game or app. There's no REPL, no `$:` lines, no `hush()` — you hold patterns in variables, and `loop()` returns a handle:

```ts
const handle = pattern.loop({ bpm: 120 });
// ...later:
handle.stop(); // stops scheduling; already-scheduled voices (~0.3 s lookahead) ring out
```

The flip side is `.play()`, which has no Strudel equivalent: it schedules **one cycle, once**, with percussive envelopes — the game-SFX path. A consequence worth internalizing: `.play()` runs cycle zero only, so a `<a b c>` alternation in a one-shot always plays its first option. Alternation is a looping construct.

## Numbers in `note()` are Hz, not MIDI

`note(60)` in Strudel is middle C. In undertone, a bare number is a **frequency in hertz** — `note(440)` is concert A, `note(60)` is a 60 Hz rumble. Use note names (`'c4'`, `'f#3'`, `'bb2'`) when you mean pitches; `noteToMidi`/`midiToFrequency` are exported if you need to convert.

Relatedly, `n()` means exactly one thing here: scale degrees, resolved by `.scale('D5:minor')`. It never selects a sample variant — there is no `s("bd").n(2)`-style sample indexing, and no chainable `.n()` at all. One name per sample; `.bank()` handles kit-prefix lookup.

## Patterned parameters and signals: point-sampled at each onset

Every numeric control (`gain`, `lpf`, `pan`, envelope stages, effect sends, ...) accepts a number, a mini-notation string or a pattern, and the signals (`sine`, `saw`, `rand`, `perlin`, ...) are patterns: `.lpf(sine.range(400, 4000))` and `.pan(sine2)` work as they do in Strudel (see [Signals](/guide/signals)). A few controls stay plain values (`orbit`, `cut`, `panlaw`, `channels`, `surround`, `fmenv`, `fmwave`, `autopanshape`, `panpath()` and `pitchsteps()`). For motion inside a note, Undertone has its own controls as well (see below). The differences to know when you port a patch:

- **Pan is -1 to 1**, so a unipolar signal only reaches one side: `.pan(sine2)` or `.pan(sine.range(-1, 1))` sweeps the field, where Strudel's `.pan(sine)` already does. A value outside the range is clamped, with one warning.
- **Events are never fragmented.** A signal never splits an event, and each event reads one value at its onset.
- **`late` and `early` are in seconds**, not cycles, so they do not shift a signal in cycle time.
- **`euclid` on a signal acts as a struct**: the rhythm's events, each holding the signal's value at its onset.
- **Random values are Undertone's own.** The same seed never gives Strudel's numbers, and `.seed(n)` goes directly on the random signal (`rand.seed(7).range(200, 2000)`).

The combination rule is simple and worth stating precisely, because it's the semantics everything else follows from:

- **Structure always comes from the pattern being controlled.** A four-step `.gain('.5 .2 .35 .2')` on a two-note pattern never creates extra events.
- **The control is sampled at each event's onset.** The control string divides the cycle its own way; at each event's onset instant, whichever control step covers that instant supplies the value.
- **A rest (`~`) in the control leaves the value unset** for that event — the default (or an earlier chained call's value) applies. `.lpf('400 ~')` gives the second event _no filter_, not a cutoff of 0.

Also: every number and string control value is validated eagerly when the pattern is built — a typo'd note name, an out-of-range pan, or a malformed number in a control string throws at construction time, not mid-performance. A pattern's values are checked as they are read instead, and never throw: they are clamped or left unset, with one warning. The pattern engine has no random event operators (no `degradeBy`, no `sometimes`, no `?`), but it does have random signals (`rand`, `perlin`, `irand`, `choose`, ...), which are deterministic functions of a seed and the exact time, so the only nondeterminism in the whole library is the noise oscillators' sample data.

## `.voicing()` is a deterministic approximation, not voice-leading

Strudel voices chords through voicing dictionaries. Undertone's `.voicing()` is a stateless, pure function of the chord symbol and an optional anchor:

- The root lands within a half-octave of the anchor (default middle C; `.voicing({ anchor: 'g4' })` to taste).
- Every other tone stacks directly on top by its interval, so extensions like a 9th land an octave up rather than folding down next to the root.
- Because it's a pure function, chords sharing a root and overlapping intervals (`Dm` then `Dm7`) automatically land their common tones on the same pitches — an **approximation of voice-leading, with no guarantee across different roots**. `Dm` to `G7` may leap where a dictionary voicing would glide.

There's no `mode`, no `dict`, no voicing-dictionary system — `{ anchor }` is the entire options surface. Same input, same pitches, every time, which is exactly what you want when a sound has to be identical across every player's machine.

## Samples: strictly bring-your-own-assets

Strudel gives you a default sample map and soundfonts from its CDN. Undertone ships **nothing** and fetches **nothing** by default — not Strudel's CDN, not anyone's:

```ts standalone
import { loadSamples, registerSamples, s } from '@liminal-hq/undertone';

registerSamples({ bd: '/audio/kick.wav', sd: '/audio/snare.wav' });
const ctx = new AudioContext();
await loadSamples(ctx); // optional preload; otherwise decode happens on demand
s('bd sd').loop({ ctx, bpm: 120 });
```

`registerSample(name, source)` takes a URL, an `ArrayBuffer`, an `AudioBuffer`, or `{ url?, data?, buffer?, baseNote? }` (`baseNote` being the recording's actual pitch, for pitched playback via `note(...).s('mySample')`). A sample that isn't decoded yet is skipped for that onset — with a once-per-name console warning — rather than throwing mid-loop. You're responsible for the rights to whatever you register.

## Effects live on shared orbit buses

Reverb and delay are sends to per-orbit buses, not per-voice inserts — undertone builds a fresh node graph per onset, and a convolver per voice would be unshippable. `.room(level)`/`.delay(level)` set the send; `.roomsize()`, `.delaytime()`, `.delayfeedback()` configure the _shared bus_, last-writer-wins across every voice on that orbit. When two layers need genuinely different rooms, give them different orbits:

```ts live
import { chord, n, stack } from '@liminal-hq/undertone';

const pad = chord('<Dm9 Gm9>').voicing().sound('sine').sustain(0.8).room(0.5).roomsize(8).orbit(1);
const pluck = n('0 4 2 7').scale('d4:minor').delay(0.3).delaytime(0.25).orbit(2);

stack(pad, pluck).loop({ bpm: 120 });
```

Unlike Strudel's `orbit` control, undertone's `.orbit(n)` takes a plain non-negative integer and is the one voice control that is **not patternable** — it selects a bus rather than shaping a value. The reverb's impulse response is procedurally generated from `roomsize` (no IR files), regenerated only when that orbit's size actually changes.

The per-voice effect roster is intentionally small: lowpass with a full ADSR filter envelope (`lpf`/`lpenv`/`lpa`/`lpd`/`lps`/`lpr`), static highpass (`hpf`), a 4-stage phaser, pitch `slide`/`penv`/`pitchsteps`, FM, and the orbit sends. No distortion, bit-crush, vowel filter, `chop`, or the rest of the superdough rack.

`.lpenv()` is an amount in Hz _added_ to `.lpf()` (the filter peaks at `lpf + lpenv`), so scale the value accordingly when porting an envelope depth from Strudel.

## FM synthesis

The FM controls use Strudel's names: `fm`/`fmi` (the modulation index) and `fmh` (the harmonicity), with `fmattack`/`fmdecay`/`fmsustain`/`fmrelease` for the modulator's own envelope, `fmenv` for its ramp shape and `fmwave` for its waveform. Gate and expression use `duration`, `legato` and `velocity`, a cut group uses `cut`, and a pitch envelope uses `penv`/`pattack`/`pdecay`. The FM envelope defaults match Strudel's (exponential ramps; a bare decay falls toward silence). Undertone's pitch envelope is simpler than Strudel's: it starts at the `penv` offset (after `pattack` seconds, if set) and returns to the note over `pdecay`, with no sustain or anchor stages. If you are coming from Tone.js instead, `FMSynth` maps like this:

| Tone.js `FMSynth`                  | Undertone                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `harmonicity`                      | `.fmh(ratio)`                                                                       |
| `modulationIndex`                  | `.fm(index)`; Tone's index is relative to the _carrier_, so divide by `harmonicity` |
| `modulationEnvelope`               | `.fmattack()` `.fmdecay()` `.fmsustain()` `.fmrelease()`                            |
| `oscillator.type`                  | `.sound(type)`                                                                      |
| `modulation.type`                  | `.fmwave(type)`                                                                     |
| `envelope`                         | `.attack()` `.decay()` `.sustain()` `.release()`                                    |
| `triggerAttackRelease(note, time)` | `.duration(time)` or `.legato(fraction)`                                            |

The one deliberate difference from Tone is the unit of the index, which follows Strudel: the pitch swings by `index × modulator frequency`. Undertone does not model operator feedback. See the [FM guide](/guide/fm-synthesis).

## `.pan()` runs −1..1, not 0..1

Strudel pans from 0 (left) to 1 (right) with 0.5 centre. Undertone uses the Web Audio convention: **−1 left, 0 centre, 1 right**, validated at build time (`.panpath()`, `.panslide()` and `.autopan()` use the same range). Porting a Strudel pan value means `pan(2 * x - 1)`. This is also what `jux` does under the hood — original at `pan(-1)`, transformed copy at `pan(1)`.

Beyond stereo, undertone adds placement Strudel doesn't have: `.channels([...])` for raw per-speaker gains up to 7.1, `.surround(angleDegrees)` for equal-power placement on the speaker ring, and `enableMultichannel(ctx)` to opt into real surround hardware (everything folds down to stereo otherwise).

## What is Strudel's vocabulary and what is Undertone's own

Most names come from Strudel or Tidal and keep their meaning: `note`, `s`, `n`, `stack`, `jux`, `every`, `lpf`/`lpenv`, `room`/`delay`/`orbit`, `fm`/`fmh`, `penv`, `slide`, `nudge`/`late`/`early`, `cut`, `legato`, `velocity`. Some are Undertone's own, for things a library that plays game audio needs and a live-coding environment does not:

- **`.pitchsteps([...], rateHz?)`**: a frame-stepped pitch curve, one semitone offset per frame (140 a second by default, the frame rate of classic AdLib effects). Strudel has no equivalent.
- **Pan motion inside a note**: `.panpath()` (a stepped array of pans or `{ time, pan }` ramps), `.panslide(from, seconds?)` (the pan's own `slide`), and `.autopan(hz)` with `.autopandepth()`, `.autopanshape()` and `.autopanphase()` (an LFO on the panner). Strudel moves pan by patterning it per event, or with a signal such as `pan(sine)`; Undertone does both too (`.pan(sine2)`), and these move it within a held note. `.panlaw(db)` sets the pan law, which Strudel does not expose.
- **Offline rendering and instruments as data**: `render()`, `encodeWav()`, `fmVoice()`/`layer()`, `score()` for tick-timed events, and `drift()` for seeded variation, all aimed at shipping sound inside something.

If you were using `sine` to sweep a pan once per event, `.pan(sine2)` does it. For a sweep inside a held note, use `.autopan()` for a steady one or `.panpath()` for a shaped one: they only move the pan, and run on the audio clock rather than at the onset.

## The mini-notation subset

Supported, with Strudel-compatible meaning: sequences, `~` rests, `[a b]` subdivision, `<a b>` alternation, `a,b` parallel, `a*2`/`a/2`, `a!3` replication, `a@3` elongation, and `a(3,8,rot?)` euclidean rhythms.

Not supported: `?` (degrade), `|` (random choice), `{a b c}%n` (polymeter), and the `.` grouping shorthand — the random ones deliberately (the engine is deterministic), the rest simply not yet. A string using them throws at parse time, so ported patterns fail loudly rather than silently drifting.

## Tempo

`play()`/`loop()` take `{ bpm }`, counting four beats per cycle — the default 120 bpm means 2-second cycles, which lands at the same speed as Strudel's default (0.5 cycles per second). `setcpm(cyclesPerMinute)` sets a default for calls that omit `bpm` (an explicit `bpm` always wins), and `resetTempo()` clears it. A running `loop()` without an explicit tempo follows later `setcpm()` calls. There's no per-pattern tempo — tempo belongs to the `play()`/`loop()` call, not the pattern (`{ cps }` sets cycles per second there directly, instead of `bpm`).

## The shape of what's missing

Undertone's transform vocabulary is the core set: `fast`, `slow`, `rev`, `every`, `euclid`, `jux`, plus `stack`/`seq`/`cat`/`arrange` and the lower-level `mini`/`pure`/`silence`/`timecat`. If your Strudel style leans on `sometimes`, `off`, `ply`, or `chunk`, you'll be reformulating rather than porting. Signal modulation works, with `.range()`, `.segment()` and arithmetic (`add`, `sub`, `mul`, `div`) on patterns of numbers. Synth sources are four oscillator waveforms, three shaped sines and three noise colours (`sine`, `triangle`, `square`, `sawtooth`, `halfsine`, `abssine`, `pulsesine`, `white`, `pink`, `brown`) — no soundfonts, no wavetables, no ZzFX.

What you get in trade: a dependency-free, tree-shakeable MIT library with exact rational timing, eager validation, first-class one-shots, surround placement, and a [fully unit-tested](https://github.com/liminal-hq/undertone) audio graph — built to be shipped inside something, not performed in. Start with [getting started](/guide/getting-started), or go straight to the [recipes](/recipes) and the [API reference](/api/).
