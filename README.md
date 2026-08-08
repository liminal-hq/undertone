<p align="center">
  <img src="assets/hero.svg" alt="Undertone — procedural one-shot sound effects for games" width="100%">
</p>

Undertone is a procedural synth engine for games and music, built directly on the Web Audio API — one-shot sound effects, looped grooves, and full multi-section songs, all from the same pattern. Everything is a pattern: a UI blip is a pattern you play once, a melody is a pattern you loop, a whole track is patterns arranged end to end.

## Features

- **Zero required runtime dependencies.** Pure TypeScript on top of the Web Audio API. Sample playback optionally does a plain `fetch()`, but only when you register a sample with a URL — nothing is bundled or fetched by default.
- **Mini-notation** — `note('c3 [e3 g3] <a3 b3> ~')` — sequences, subdivision, per-cycle alternation, rests, chords, replication, elongation, and euclidean rhythms in one string.
- **Pattern combinators**: `fast`, `slow`, `rev`, `every`, `euclid`, `jux`, `stack`, `seq`, `cat`, `arrange` — all immutable, all composable, with exact rational cycle time underneath (triplets never drift).
- **Scales and chords** — `n('0 2 4').scale('D5:minor')` for scale-degree melodies, `chord('Dm9').voicing()` for chord symbols expanded to real pitches — no bundled music-theory data, just the maths.
- **Sample playback, bring-your-own-assets** — `s('bd sd hh')` plays registered samples the same way `sound()` plays synth voices; see Samples below.
- **Chainable, immutable voice controls** — ADSR, `.gain()`, lowpass + highpass filters with envelopes, a 4-stage phaser, reverb/delay sends, `.slide()`, `.nudge()` — every one of them accepts a mini-notation string to pattern it, not just a scalar.
- **Polyphony everywhere**: chords via `[c3,e3,g3]` or `.voicing()`, layers via `stack()`, overlapping voices each get their own node graph.
- **One-shot or looped**: `pattern.play()` fires a single cycle (percussive envelopes, exactly right for game SFX); `pattern.loop({ bpm })` runs a lookahead cycle scheduler where each note's envelope is gated by its event length.
- **Stereo and up-to-7.1 placement**: `.pan(-1..1)`, `.channels([...])` per-speaker gains, `.surround(angle)` equal-power placement on the speaker ring — with automatic stereo fold-down on plain hardware.
- **Fully unit-tested**, including the actual Web Audio node graph, envelope automation timing, and the loop scheduler, against a hand-written fake `AudioContext`.

## Provenance

Undertone's vocabulary is Strudel-flavoured — `note()`, mini-notation, `stack()`, `jux(rev)`, chord symbols, scale names — because it's a genuinely pleasant way to describe both a synth voice and a musical pattern, and a good foundation worth building on. From there, undertone is its own project: a clean-room, MIT-licensed implementation built from the published TidalCycles papers, standard music theory, and Strudel's own published documentation and behaviour — never from its source, sample manifests, soundfont data, voicing dictionaries, or impulse-response data. ([Strudel](https://strudel.cc) itself is AGPL-3.0-or-later, which is why undertone couldn't just depend on it directly.) Samples stay bring-your-own-assets rather than a bundled or CDN-hosted library: nothing is fetched until you explicitly register one.

## Installation

```bash
bun add @liminal-hq/undertone
# or: npm install @liminal-hq/undertone
```

## Usage

A one-shot game sound effect (percussive, fire-and-forget):

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

// Later, on a user gesture (autoplay policy):
placeBuilding.play();
```

Looped, polyphonic music from mini-notation:

```ts
import { note, rev, stack } from '@liminal-hq/undertone';

const music = stack(
  note('<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>') // one chord per cycle
    .sound('sine')
    .sustain(0.8),
  note('c5 [e5 g5] <b5 a5> ~').sound('triangle').every(2, rev).jux(rev).gain(0.4),
  note('c2(3,8)').sound('square').lpf(400) // euclidean bassline
);

const handle = music.loop({ bpm: 110 });
// ... later:
handle.stop();
```

See `demo/` for a runnable local playground with a live pattern editor (`bun run demo`), or the deployed version at [liminalhq.ca/undertone](https://liminalhq.ca/undertone/).

## Mini-notation

`note()` and `sound()` accept a mini-notation string. Within one cycle:

| Notation    | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `a b c`     | Sequence: the cycle is divided equally between the steps.                |
| `~`         | Rest.                                                                    |
| `[a b]`     | Subdivision: a nested sequence inside one step.                          |
| `<a b>`     | Alternation: a different child each cycle.                               |
| `a,b`       | Parallel: both play at once (chords, layers).                            |
| `a*2` `a/2` | Speed the step up / slow it down.                                        |
| `a!3`       | Replicate the step (same as writing it three times).                     |
| `a@3`       | Elongate: the step takes 3 shares of the cycle.                          |
| `a(3,8)`    | Euclidean rhythm: 3 onsets spread over 8 slots; `a(3,8,1)` rotates by 1. |

## Scales

`n(input)` starts a scale-degree pattern — `input` is a raw integer, or a mini-notation string of
them (`"0 2 4 <1 3>"`), just like `note()`. Chain `.scale("D5:minor")` to resolve those degrees
into real pitches: the root is a note name + octave, the name is one of `major`/`ionian`,
`minor`/`aeolian`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `locrian`, `harmonicMinor`,
`melodicMinor`, `majorPentatonic`, `minorPentatonic`, `chromatic` (case-insensitive, spaces/hyphens
ignored). Degrees beyond the scale's own length carry the octave (`n('7').scale('c4:major')` is
`c5`); negative degrees descend the same way. Events built with `note()` (already pitched) pass
through `.scale()` unchanged, so `n()` and `note()` can be freely mixed in a `stack()`.

## Chords

`chord(input)` starts a chord-symbol pattern — `input` is a mini-notation string of chord symbols
like `"<Dm9 BbM7 Gm9 A7sus>"`. Chain `.voicing()` to expand each chord into simultaneous notes
(one chord onset becomes N notes sharing the same span, exactly like a `[c3,e3,g3]` chord written
directly in mini-notation). Supported qualities: `''` (major), `m`, `6`, `m6`, `7`, `maj7`/`M7`,
`m7`, `9`, `maj9`/`M9`, `m9`, `add9`, `madd9`, `sus2`, `sus4`, `7sus`/`7sus4`, `dim`, `dim7`, `aug`,
`m7b5` — case matters (`M7` is a major seventh, `m7` is a minor seventh). Voicing is a stateless,
deterministic function of the symbol (and an optional `{ anchor }` pitch, default middle C) — an
approximation of voice-leading, not real voice-leading: same-root chord changes (`Dm` → `Dm7`)
share common tones automatically, but there's no guarantee across different roots. Events built
with `note()`/`n()` (already pitched) pass through `.voicing()` unchanged.

## Samples

Undertone ships **no bundled samples** — synthesis stays zero-dependency and small. Sample
playback is entirely bring-your-own-assets: `registerSample(name, source)` (or `registerSamples({
...})` for many at once) points a name at a URL, an already-fetched `ArrayBuffer`, an
already-decoded `AudioBuffer`, or `{ url?, data?, buffer?, baseNote? }` for more control (`baseNote`
is the pitch the recording actually sounds at, default `"c4"`, used to compute playback rate for
pitched samples). Nothing is fetched until you ask: call `await loadSamples(ctx)` up front to
preload and decode everything registered (or pass specific names), or just start playing — a
sample that isn't decoded yet is silently skipped for that one onset (with a once-per-name
console warning) and picked up by later onsets once decoding finishes.

`s(input)` (and the chainable `.s(name)`) work like `sound()`, except any word that isn't one of
the seven synth types becomes a sample name instead of throwing — `s("bd sd hh")`,
`note('c3').s('gm_acoustic_bass')`. `.bank(name)` is a lookup convention, not a loader: it tries
`` `${name}_${sampleName}` `` before falling back to the bare sample name, so registering
`registerSample('RolandTR707_bd', ...)` lets `s('bd').bank('RolandTR707')` find it.

**You are responsible for the legal status of whatever you register.** Undertone doesn't fetch,
bundle, or point at any sample library (Strudel's own CDN/soundfonts included) by default — bring
audio you have the rights to use.

## Effects

Beyond `.lpf()`, voices can chain a static highpass (`.hpf(hz)`) and a 4-stage allpass phaser
(`.phaser(rateHz)`), plus reverb and delay sends: `.room(level)`/`.roomsize(size)` and
`.delay(level)`/`.delaytime(s)`/`.delayfeedback(amount)`. All of these accept a mini-notation
string like every other numeric control (see Patterned parameters above).

Reverb and delay are **shared per-orbit buses**, not one node per voice — `.orbit(n)` (default 0,
integer, not patternable) picks which bus a voice's room/delay sends target. Every voice sending
to the same orbit shares one reverb (an impulse response procedurally generated from `roomsize`,
regenerated only when that orbit's size actually changes) and one delay line; give a voice its own
orbit number when it needs a distinct room size or delay time from its neighbours — that's exactly
why a track with several different reverb characters gives each one its own orbit.

## API

| Call                                                     | What it does                                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `note(input)`                                            | Pattern of pitched voices (default sound: sine). `input` is a note name (`"c2"`, `"f#3"`), a raw Hz number, or a mini-notation string of them.       |
| `sound(input)`                                           | Pattern of unpitched voices — the entry point for noise (`'white' \| 'pink' \| 'brown'`), also accepts mini-notation.                                |
| `n(input)` `.scale(spec)`                                | Scale-degree pattern (`n('0 2 4')`) resolved into real pitches by `.scale("D5:minor")`. `spec` is `"<root><octave>:<name>"`; see Scales below.       |
| `chord(input)` `.voicing(options?)`                      | Chord-symbol pattern (`chord('<Dm9 BbM7>')`) expanded into simultaneous notes by `.voicing()`. `options?: { anchor? }`; see Chords below.            |
| `s(input)` `.s(name)` `.bank(name)`                      | Synth voice or registered sample (`s('bd sd')`); non-synth words become sample names. `.bank()` is a lookup prefix; see Samples below.               |
| `registerSample(name, source)` `registerSamples(map)`    | Registers a sample — `source` is a URL, `ArrayBuffer`, `AudioBuffer`, or `{ url?, data?, buffer?, baseNote? }`. See Samples below.                   |
| `loadSamples(ctx, names?)`                               | Preloads and decodes registered samples (all, or just `names`) against `ctx`. Returns a `Promise<void>`.                                             |
| `.hpf(hz)` `.phaser(rateHz)`                             | Static highpass, in series after `.lpf()`; and a 4-stage allpass phaser. Neither creates a node when omitted.                                        |
| `.room(level)` `.roomsize(size)`                         | Reverb send (0-1) to the voice's orbit bus, and the shared bus's decay character (~1-10). See Effects below.                                         |
| `.delay(level)` `.delaytime(s)` `.delayfeedback(amount)` | Delay send (0-1) to the voice's orbit bus, and the shared bus's time/feedback. See Effects below.                                                    |
| `.orbit(n)`                                              | Which shared reverb/delay bus (`getOrbitBus`) the voice's sends target. Default 0, non-negative integer, not patternable.                            |
| `stack(...pats)` `seq(...pats)` `cat(...pats)`           | Combine patterns: simultaneously / sequentially within a cycle / one per cycle.                                                                      |
| `arrange([cycles, pat], ...)`                            | Plays each pattern for its own span of whole cycles, looping the whole arrangement once the total is reached — the backbone of a multi-section song. |
| `.fast(n)` `.slow(n)`                                    | Speed the whole pattern up or down.                                                                                                                  |
| `.rev()`                                                 | Reverse each cycle (also exported standalone as `rev` for `jux(rev)`).                                                                               |
| `.every(n, fn)`                                          | Apply `fn` to the pattern every nth cycle.                                                                                                           |
| `.euclid(pulses, steps, rot?)`                           | Distribute the pattern over a euclidean rhythm.                                                                                                      |
| `.jux(fn)`                                               | Original hard left, `fn(pattern)` hard right.                                                                                                        |
| `.sound(type)`                                           | Waveform or noise type: `'sine' \| 'triangle' \| 'square' \| 'sawtooth' \| 'white' \| 'pink' \| 'brown'`.                                            |
| `.attack(s)` `.decay(s)` `.sustain(level)` `.release(s)` | Amplitude envelope. One-shots are percussive; in `loop()` the envelope holds at `sustain` until the event's gate ends.                               |
| `.gain(level)`                                           | Peak amplitude (0-1).                                                                                                                                |
| `.lpf(hz)`                                               | Base lowpass filter cutoff. Omit entirely to skip filtering.                                                                                         |
| `.lpenv(hz)` `.lpa(s)` `.lpd(s)` `.lps(level)` `.lpr(s)` | Filter envelope — same shape as the amplitude envelope, ranging between `lpf` and `lpf + lpenv`.                                                     |
| `.slide(s)`                                              | Pitch glide: starts an octave above the target note and slides down over `s` seconds.                                                                |
| `.nudge(s)` `.late(s)` `.early(s)`                       | Start-time offset in seconds for every event (`late`/`early` are signed aliases of `nudge`).                                                         |
| `.pan(p)`                                                | Stereo position, -1 (left) to 1 (right).                                                                                                             |
| `.channels(gains)` `.surround(angle)`                    | Multichannel placement (up to 7.1): raw per-speaker gains in FL, FR, C, LFE, SL, SR, RL, RR order, or an angle on the speaker ring.                  |
| `.play(options?)`                                        | One-shot: schedules one cycle's worth of events. `{ ctx?, bpm?, when? }`.                                                                            |
| `.loop(options?)`                                        | Loops with a lookahead scheduler; returns a handle with `stop()`. `{ ctx?, bpm?, timer? }`.                                                          |
| `setcpm(cyclesPerMinute)` `resetTempo()`                 | Sets/clears a default tempo for `play()`/`loop()` calls that omit `bpm` — see the tempo note below the table.                                        |
| `enableMultichannel(ctx)`                                | Opts the context's destination into its full hardware channel count (call once); without it, multichannel voices fold down to stereo.                |
| `mini(source, leaf)` `pure(v)` `silence` `timecat(...)`  | Lower-level pattern building blocks, exported for power users.                                                                                       |

Tempo: `bpm` counts four beats per cycle; the default 120 bpm means 2-second cycles. `setcpm(cyclesPerMinute)` sets a default tempo used whenever a `play()`/`loop()` call omits `bpm` (an explicit `bpm` always wins) — the top-of-file "set it once" style some scripts prefer over passing `{ bpm }` everywhere; `resetTempo()` clears it back to the plain 120 bpm default. When no `ctx` is passed, a shared `AudioContext` is created lazily on first use — trigger the first `play()`/`loop()` from a user gesture (autoplay policy).

**Patterned parameters:** every numeric control above (`attack`, `decay`, `sustain`, `release`, `gain`, `lpf`, `lpenv`, `lpa`, `lpd`, `lps`, `lpr`, `slide`, `nudge`/`late`/`early`, `pan`) also accepts a mini-notation string instead of a plain number — `.gain(".1 .2 .3 .4")`, `.pan("<.25 .75>")`. Structure comes from the pattern it's called on: at each event's onset, whichever control step covers that instant supplies the value, and a rest (`~`) in the control leaves that event's value unset.

## Development

```bash
bun install
bun run test          # vitest
bun run lint           # eslint
bun run build          # tsc -> dist/
bun run demo            # local playground at http://localhost:5173
```

## License

MIT
