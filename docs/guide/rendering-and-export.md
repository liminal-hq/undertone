---
title: Rendering & Export
---

# Rendering and WAV export

`renderToBuffer(pattern, options?)` plays a pattern on an `OfflineAudioContext` with no real-time clock and resolves with the finished audio. `pattern.render(options?)` is the same call as a method, and `score(...).render()` renders one pass of a cue at its own tempo. Pass the result to `encodeWav` to get the bytes of a `.wav` file.

```ts
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
- **Seamless loops:** `wrap: true` folds the tail back onto the start, so the file is exactly one pass long and loops without a gap or a cut-off tail. The folded tail was limited separately from the start, so the sum can exceed the limiter's ceiling.
- **Gating:** notes are gated by their event length like `loop()`. Pass `gated: false` for a percussive one-shot like `play()`.
- **Master bus:** the render goes through the same limiter as `createMasterBus`, so the file matches what a listener hears. Pass `master: false` for the raw mix, or an object to tune it.

## Reproducible renders

Noise and reverb impulse responses are random, so unseeded renders differ slightly each time. A render is seeded with `seed` (default `0`), so rendering the same pattern, tempo, sample rate and seed again gives the same samples **on the same browser engine**. Different browsers and versions implement the compressor, convolver and filters differently, so bit-identical output across them is not promised. Live playback keeps using `Math.random`.

## Limits

- **Room size is fixed per orbit.** A reverb's impulse response cannot be scheduled, so when a pattern changes `.room` size over time, the last one booked on each orbit applies to the whole render.
- **Samples are decoded for you.** Registered samples a pattern uses are decoded on the offline context before the render starts. Sample-rate differences between a file and the render are resampled by the browser.
- **Memory.** The whole render lives in memory, and every event is booked up front. A stereo render is about 23 MB per minute at 48 kHz in 32-bit float, before the nodes the events create. Long pieces may need to be rendered in sections.
- **It blocks the page.** Web Audio is not available in Workers, so a heavy render runs on the page that asks for it.
- **Outside a browser.** There is no built-in `OfflineAudioContext` in Node. Pass a `context` factory (for example one built on a Web Audio implementation you choose) that takes `{ numberOfChannels, length, sampleRate }`. Undertone adds no dependency for this.

## WAV files

`encodeWav(source, options?)` takes the rendered buffer (or `{ sampleRate, channels }` with one `Float32Array` per channel) and returns a `Uint8Array`.

- **Bit depth:** 16-bit (default), 24-bit, or 32-bit float. 16-bit adds seeded TPDF dither by default so quiet tails do not turn into rounding noise; pass `dither: false` to turn it off. The `seed` makes the dither, and so the bytes, repeatable.
- **Channels:** one to eight. Three or more use the extensible header with a speaker mask. 7.1 is reordered into WAV's channel order, so Undertone's surround layout plays on the right speakers in a player.
- **Size:** the data chunk is limited to 4 GiB. Larger audio throws.

## Not covered

WAV is the only format. Compressed formats such as OGG or MP3 need an encoder, which is separate work. The browser's own `MediaRecorder` is the practical route in the meantime.
