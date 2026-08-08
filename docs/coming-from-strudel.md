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

## Patterned parameters: point-sampled at each onset, strings only

Every numeric control (`gain`, `lpf`, `pan`, envelope stages, effect sends, ...) accepts a mini-notation string, but the input is only ever a number or a string — you can't pass an arbitrary `Pattern`, and there are no continuous signals (`sine`, `saw`, `rand`, `perlin` don't exist).

The combination rule is simple and worth stating precisely, because it's the semantics everything else follows from:

- **Structure always comes from the pattern being controlled.** A four-step `.gain('.5 .2 .35 .2')` on a two-note pattern never creates extra events.
- **The control is sampled at each event's onset.** The control string divides the cycle its own way; at each event's onset instant, whichever control step covers that instant supplies the value.
- **A rest (`~`) in the control leaves the value unset** for that event — the default (or an earlier chained call's value) applies. `.lpf('400 ~')` gives the second event _no filter_, not a cutoff of 0.

Also: every control value is validated eagerly when the pattern is built — a typo'd note name, an out-of-range pan, or a malformed number in a control string throws at construction time, not mid-performance. There is no randomness anywhere in the pattern engine (no `degradeBy`, no `sometimes`, no `?`); the only nondeterminism in the whole library is the noise oscillators' sample data.

## `.voicing()` is a deterministic approximation, not voice-leading

Strudel voices chords through voicing dictionaries. Undertone's `.voicing()` is a stateless, pure function of the chord symbol and an optional anchor:

- The root lands within a half-octave of the anchor (default middle C; `.voicing({ anchor: 'g4' })` to taste).
- Every other tone stacks directly on top by its interval, so extensions like a 9th land an octave up rather than folding down next to the root.
- Because it's a pure function, chords sharing a root and overlapping intervals (`Dm` then `Dm7`) automatically land their common tones on the same pitches — an **approximation of voice-leading, with no guarantee across different roots**. `Dm` to `G7` may leap where a dictionary voicing would glide.

There's no `mode`, no `dict`, no voicing-dictionary system — `{ anchor }` is the entire options surface. Same input, same pitches, every time, which is exactly what you want when a sound has to be identical across every player's machine.

## Samples: strictly bring-your-own-assets

Strudel gives you a default sample map and soundfonts from its CDN. Undertone ships **nothing** and fetches **nothing** by default — not Strudel's CDN, not anyone's:

```ts
registerSamples({ bd: '/audio/kick.wav', sd: '/audio/snare.wav' });
const ctx = new AudioContext();
await loadSamples(ctx); // optional preload; otherwise decode happens on demand
s('bd sd').loop({ ctx, bpm: 120 });
```

`registerSample(name, source)` takes a URL, an `ArrayBuffer`, an `AudioBuffer`, or `{ url?, data?, buffer?, baseNote? }` (`baseNote` being the recording's actual pitch, for pitched playback via `note(...).s('mySample')`). A sample that isn't decoded yet is skipped for that onset — with a once-per-name console warning — rather than throwing mid-loop. You're responsible for the rights to whatever you register.

## Effects live on shared orbit buses

Reverb and delay are sends to per-orbit buses, not per-voice inserts — undertone builds a fresh node graph per onset, and a convolver per voice would be unshippable. `.room(level)`/`.delay(level)` set the send; `.roomsize()`, `.delaytime()`, `.delayfeedback()` configure the _shared bus_, last-writer-wins across every voice on that orbit. When two layers need genuinely different rooms, give them different orbits:

```ts
const pad = chord('<Dm9 Gm9>').voicing().sound('sine').sustain(0.8).room(0.5).roomsize(8).orbit(1);
const pluck = n('0 4 2 7').scale('d4:minor').delay(0.3).delaytime(0.25).orbit(2);
```

Unlike Strudel's `orbit` control, undertone's `.orbit(n)` takes a plain non-negative integer and is the one voice control that is **not patternable** — it selects a bus rather than shaping a value. The reverb's impulse response is procedurally generated from `roomsize` (no IR files), regenerated only when that orbit's size actually changes.

The per-voice effect roster is intentionally small: lowpass with a full ADSR filter envelope (`lpf`/`lpenv`/`lpa`/`lpd`/`lps`/`lpr`), static highpass (`hpf`), a 4-stage phaser, pitch `slide`, and the orbit sends. No distortion, bit-crush, vowel filter, `chop`, or the rest of the superdough rack.

## `.pan()` runs −1..1, not 0..1

Strudel pans from 0 (left) to 1 (right) with 0.5 centre. Undertone uses the Web Audio convention: **−1 left, 0 centre, 1 right**, validated at build time. Porting a Strudel pan value means `pan(2 * x - 1)`. This is also what `jux` does under the hood — original at `pan(-1)`, transformed copy at `pan(1)`.

Beyond stereo, undertone adds placement Strudel doesn't have: `.channels([...])` for raw per-speaker gains up to 7.1, `.surround(angleDegrees)` for equal-power placement on the speaker ring, and `enableMultichannel(ctx)` to opt into real surround hardware (everything folds down to stereo otherwise).

## The mini-notation subset

Supported, with Strudel-compatible meaning: sequences, `~` rests, `[a b]` subdivision, `<a b>` alternation, `a,b` parallel, `a*2`/`a/2`, `a!3` replication, `a@3` elongation, and `a(3,8,rot?)` euclidean rhythms.

Not supported: `?` (degrade), `|` (random choice), `{a b c}%n` (polymeter), and the `.` grouping shorthand — the random ones deliberately (the engine is deterministic), the rest simply not yet. A string using them throws at parse time, so ported patterns fail loudly rather than silently drifting.

## Tempo

`play()`/`loop()` take `{ bpm }`, counting four beats per cycle — the default 120 bpm means 2-second cycles, which lands at the same speed as Strudel's default (0.5 cycles per second). `setcpm(cyclesPerMinute)` sets a default for calls that omit `bpm` (an explicit `bpm` always wins), and `resetTempo()` clears it. There's no `.cps()` or per-pattern tempo — tempo belongs to the `play()`/`loop()` call, not the pattern.

## The shape of what's missing

Undertone's transform vocabulary is the core set: `fast`, `slow`, `rev`, `every`, `euclid`, `jux`, plus `stack`/`seq`/`cat`/`arrange` and the lower-level `mini`/`pure`/`silence`/`timecat`. If your Strudel style leans on `sometimes`, `off`, `ply`, `chunk`, `add`, or signal modulation, you'll be reformulating rather than porting. Synth sources are four oscillator waveforms plus three noise colours (`sine`, `triangle`, `square`, `sawtooth`, `white`, `pink`, `brown`) — no soundfonts, no wavetables, no ZzFX.

What you get in trade: a dependency-free, tree-shakeable MIT library with exact rational timing, eager validation, first-class one-shots, surround placement, and a [fully unit-tested](https://github.com/liminal-hq/undertone) audio graph — built to be shipped inside something, not performed in. Start with [getting started](/guide/getting-started), or go straight to the [recipes](/recipes) and the [API reference](/api/).
