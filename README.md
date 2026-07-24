<p align="center">
  <img src="assets/hero.svg" alt="Undertone — procedural one-shot sound effects for games" width="100%">
</p>

Undertone is a small, dependency-free procedural synth engine for one-shot game sound effects — oscillator/noise voices shaped by amplitude and filter envelopes, layered together, built directly on the Web Audio API.

## Features

- **Zero runtime dependencies.** Pure TypeScript on top of `AudioContext`/`OscillatorNode`/`GainNode`/`BiquadFilterNode`/`AudioBufferSourceNode`.
- **Chainable, immutable voice builder** — `note('c2').sound('triangle').attack(0.001).decay(0.1)...` — every call returns a new `Voice`, so a partially-built voice is always safe to branch or reuse.
- **Amplitude and filter envelopes**, both with independent attack/decay/sustain/release shaping.
- **Pitch glide** (`.slide()`) for percussive downward "thunk" sounds.
- **Oscillator waveforms** (sine, triangle, square, sawtooth) and **noise sources** (white, pink, brown) behind the same chainable API.
- **`stack()`** to layer multiple voices — each with its own `.nudge()` start-time offset — into a single sound effect.
- **Fully unit-tested**, including the actual Web Audio node graph and automation timing, against a hand-written fake `AudioContext`.

## Why not Strudel?

The API is deliberately Strudel-flavoured (`note()`, `.sound()`, ADSR methods, `stack()`) because that's a genuinely pleasant way to describe a synth voice. But [Strudel](https://strudel.cc) itself is AGPL-3.0-or-later licensed, which conflicts with permissively-licensed projects that want to bundle it into a shipped client. Undertone is a clean-room reimplementation of just the one-shot voice-builder vocabulary — not Strudel's pattern/cycle engine (no mini-notation, no euclidean rhythms, no `jux`/`rev`) — since one-shot game SFX need parallel voice layering, not temporal patterning.

## Installation

Not yet published to npm. Until then, install directly from GitHub:

```bash
bun add github:liminal-hq/undertone
# or: npm install github:liminal-hq/undertone
```

## Usage

```ts
import { note, sound, stack } from '@liminal-hq/undertone';

const placeBuilding = stack(
  note('c2')
    .sound('triangle')
    .attack(0.001)
    .decay(0.1)
    .sustain(0)
    .release(0.05)
    .gain(0.9)
    .lpf(220)
    .lpenv(5)
    .lpa(0.001)
    .lpd(0.08)
    .lps(0)
    .lpr(0.05)
    .slide(0.07),
  note('c6')
    .sound('sine')
    .attack(0.001)
    .decay(0.15)
    .sustain(0)
    .release(0.1)
    .gain(0.3)
    .lpf(2000)
    .lpenv(8)
    .lpa(0.001)
    .lpd(0.06)
    .lps(0)
    .lpr(0.1)
    .nudge(0.02),
  sound('white').attack(0).decay(0.02).sustain(0).release(0.01).gain(0.4).lpf(4000)
);

// Later, on a user gesture (autoplay policy):
placeBuilding.play();
```

See `demo/` for a runnable local playground (`bun run demo`), or the deployed version at
[liminal-hq.github.io/undertone](https://liminal-hq.github.io/undertone/).

## API

| Call                                                     | What it does                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `note(pitch)`                                            | Starts a pitched voice (default sound: sine). `pitch` is a note name (`"c2"`, `"a4"`, `"f#3"`) or a raw Hz number.                         |
| `sound(type)`                                            | Starts a voice with no pitch — the entry point for noise voices (clicks, hits).                                                            |
| `.sound(type)`                                           | Sets/overrides the oscillator waveform or noise type: `'sine' \| 'triangle' \| 'square' \| 'sawtooth' \| 'white' \| 'pink' \| 'brown'`.    |
| `.attack(s)` `.decay(s)` `.sustain(level)` `.release(s)` | Amplitude envelope. Percussive shape: attack → decay → release, no held plateau — `sustain` is the level (0-1) the decay stage settles to. |
| `.gain(level)`                                           | Peak amplitude (0-1).                                                                                                                      |
| `.lpf(hz)`                                               | Base lowpass filter cutoff. Omit entirely to skip filtering.                                                                               |
| `.lpenv(hz)` `.lpa(s)` `.lpd(s)` `.lps(level)` `.lpr(s)` | Filter envelope — same shape as the amplitude envelope, ranging between `lpf` and `lpf + lpenv`.                                           |
| `.slide(s)`                                              | Pitch glide: starts an octave above the target note and slides down over `s` seconds.                                                      |
| `.nudge(s)`                                              | Start-time offset within a `stack()`.                                                                                                      |
| `stack(...voices)`                                       | Layers voices into one `SoundEffect`.                                                                                                      |
| `soundEffect.play(ctx?, when?)`                          | Plays every voice, starting at `when` (default: now). Creates and reuses a shared `AudioContext` when none is passed.                      |

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
