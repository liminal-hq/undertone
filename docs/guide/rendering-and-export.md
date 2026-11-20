---
title: Rendering & Export
---

# Rendering and WAV export

`renderToBuffer(pattern, options?)` plays a pattern on an `OfflineAudioContext` with no real-time clock and resolves with the finished audio. `pattern.render(options?)` is the same call as a method, and `score(...).render()` renders one pass of a cue at its own tempo. Pass the result to `encodeWav` to get the bytes of a `.wav` file.

```ts standalone audio=rendering-wav
import { encodeWav, note } from '@liminal-hq/undertone';

const loop = note('c3 [e3 g3] <b3 a3> ~').sound('triangle').release(0.4);

// Four cycles at 110 bpm, plus a second of tail so the last release rings out.
const buffer = await loop.render({ cycles: 4, bpm: 110, tail: 1 });

const bytes = encodeWav(buffer, { bitDepth: 24 });
const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
```

## Options

- **Length:** `cycles` (whole cycles, default 1) or `seconds`, not both. Tempo is `bpm` or `cps`, falling back to `setcpm()` and then the default tempo, exactly as `loop()` resolves it.
- **Format:** `sampleRate` (default 48000) and `channels` (1, 2, 4, 6 or 8). More than two channels uses discrete multichannel output and skips the limiter, as live playback does.
- **Tail:** `tail` adds seconds after the pattern so releases and reverb can ring out. By default the file is exactly `pattern + tail` long.
- **Seamless loops:** `wrap: true` folds the tail back onto the start, so the file is exactly one pass long and loops without a gap or a cut-off tail. The folded tail was limited separately from the start, so the sum can exceed the limiter's threshold. A master `ceiling` still holds: after folding, every sample is clamped to it, so the file never passes the ceiling even where the tail and the start overlap.
- **Gating:** notes are gated by their event length like `loop()`. Pass `gated: false` for a percussive one-shot like `play()`.
- **Master bus:** the render goes through the same limiter as `createMasterBus`, so the file matches what a listener hears. Pass `master: false` for the raw mix, or an object to tune it. The limiter's 3 ms attack lets a sharp transient pass it, so a loud render can still peak above full scale; `master: { ceiling: -0.3 }` adds a final clip that no sample passes (see the master bus recipe).
- **Booking in windows:** `bookingWindow: seconds` books the voices a window at a time instead of all before the render starts. See below. Off by default.

## Booking in windows

By default every voice is booked on the offline context before the render starts. That is the simplest thing and it is what a browser is built for, but some renderers process every node from the moment it is made, whether or not it has started yet, so their cost grows with the number of notes times the length of the piece. `bookingWindow` books the score in windows of that many seconds instead:

```ts standalone audio=rendering-booking-window
import { note } from '@liminal-hq/undertone';

const song = note('c3 [e3 g3] <b3 a3> ~').sound('triangle').release(0.4);

// Eight cycles at the default 120 bpm is sixteen seconds, booked a second at a time.
const buffer = await song.render({ cycles: 8, tail: 2, bookingWindow: 1 });
```

- **How:** the voices are split by onset (nudge included) into windows of `bookingWindow` seconds. Windows 0 and 1 are booked before the render starts. The render then pauses with `suspend()` at the start of each window k − 1, books window k (a whole window ahead, so a pause rounded to the next render quantum is still early), and calls `resume()`. A voice nudged past the end of the render is booked at the last pause.
- **Same audio:** voices are booked in the same order with the same parameters, so the graph is the one booking up front builds. One thing is done for you: each orbit's reverb gets the last room size booked on it from the start, which is what booking up front ends with, rather than changing part way through.
- **Window size:** at least two render quanta (256 frames, about 5 ms at 48 kHz); a second or so is a good start.
- **Fallback:** on a context without `suspend()` and `resume()`, everything is booked up front, with a warning, and the render is otherwise unchanged.
- **Errors:** if the context refuses a pause, or booking a window throws, the render still runs to the end and then rejects with that error.

What was measured, so you can judge it for your own renderer:

- **On the test fake** (`src/render.test.ts`), a six-second cue booked with a one-second window pauses at 1, 2, 3 and 4 s, and at each pause exactly the voices starting before the next window ends have been made. The recorded graph (every node, connection, automation call, buffer, and the impulse response heard on each orbit) is identical to booking up front.
- **On `node-web-audio-api` 2.2.0** (a Rust implementation of Web Audio, under Bun on a 16-core Linux machine), a 75-second score of 2,325 FM, bass and noise voices with reverb and delay took 85.6 s booked up front and 8.7 s and 11.2 s with `bookingWindow: 1.2`. Peak and RMS agreed to four places; individual samples differed by at most 3 × 10⁻⁷ (about −130 dBFS), and by different amounts from run to run, which is that renderer's rounding when it sums inputs, not a change to the graph. Two renders booked up front were bit-identical.
- **Not measured:** any browser. How much a browser's `OfflineAudioContext` gains, if anything, is untested.

## Reproducible renders

Noise and reverb impulse responses are random, so unseeded renders differ slightly each time. A render is seeded with `seed` (default `0`), so rendering the same pattern, tempo, sample rate and seed again gives the same samples **on the same browser engine**. Different browsers and versions implement the compressor, convolver and filters differently, so bit-identical output across them is not promised. Live playback keeps using `Math.random`.

## Limits

- **Room size is fixed per orbit.** A reverb's impulse response cannot be scheduled, so when a pattern changes `.room` size over time, the last one booked on each orbit applies to the whole render.
- **Samples are decoded for you.** Registered samples a pattern uses are decoded on the offline context before the render starts. Sample-rate differences between a file and the render are resampled by the browser.
- **Memory.** The whole render lives in memory, and every event is booked up front unless `bookingWindow` is set. A stereo render is about 23 MB per minute at 48 kHz in 32-bit float, before the nodes the events create. Long pieces may need to be rendered in sections.
- **It blocks the page.** Web Audio is not available in Workers, so a heavy render runs on the page that asks for it.
- **Outside a browser.** From 0.4 a render needs no `OfflineAudioContext`: without a `context` factory it runs in the WebAssembly render module, so it works in Node, Bun, and Deno as it is (see [Rendering without a browser](#rendering-without-a-browser)). Pass a `context` factory only to book the voices on a Web Audio implementation of your own.

## WAV files

`encodeWav(source, options?)` takes the rendered buffer (or `{ sampleRate, channels }` with one `Float32Array` per channel) and returns a `Uint8Array`.

- **Bit depth:** 16-bit (default), 24-bit, or 32-bit float. 16-bit adds seeded TPDF dither by default so quiet tails do not turn into rounding noise; pass `dither: false` to turn it off. The `seed` makes the dither, and so the bytes, repeatable.
- **Channels:** one to eight. Three or more use the extensible header with a speaker mask. 7.1 is reordered into WAV's channel order, so Undertone's surround layout plays on the right speakers in a player.
- **Size:** the data chunk is limited to 4 GiB. Larger audio throws.

## Rendering without a browser

A render in 0.4 runs in the WebAssembly render module, and `encodeWav` is TypeScript, so a script in Node 22 or later, Bun, or Deno can write a WAV file with no `AudioContext`, no `OfflineAudioContext`, and no browser:

```js
// render.mjs
import { note, encodeWav } from '@liminal-hq/undertone';
import { writeFileSync } from 'node:fs';

const song = note('c3 [e3 g3] <b3 a3> ~').sound('triangle');
const audio = await song.render({ seconds: 1.5, bpm: 240, sampleRate: 22050, seed: 'level-1' });
writeFileSync('song.wav', encodeWav(audio, { seed: 'level-1' }));
```

```sh
node render.mjs
bun render.mjs
deno run -A render.mjs
```

The same engine is also a command line, `undertone-render` (in `crates/undertone-cli`), and it builds for `wasm32-wasip1`, so a WebAssembly runtime with WASI such as `wasmtime` can render with no JavaScript at all. See [Rust: rendering without a browser](/guide/rust-rendering-and-export#rendering-without-a-browser) for the commands.

**The files are the same bits.** The repository renders five cases (stereo, noise, mono 24-bit, 32-bit float, and six channels) natively, under `wasmtime`, and through the package in Node, Bun, and Deno, and compares the WAV files byte for byte: `scripts/check-wasi-render.sh` and `scripts/check-package-render.sh` do it, and CI runs them. They are identical on every runtime, because the maths is the pure-Rust `libm` everywhere and the dither is seeded. That holds for the maths of the package's render module; it says nothing about the sound, which nobody has listened to.

## Not covered

WAV is the only format. Compressed formats such as OGG or MP3 need an encoder, which is separate work. The browser's own `MediaRecorder` is the practical route in the meantime.
