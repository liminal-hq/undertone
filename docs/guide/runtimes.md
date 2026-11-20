---
title: Runtimes and Loading
---

# Runtimes and loading

From 0.4, `@liminal-hq/undertone` is a TypeScript layer over a Rust core compiled to WebAssembly. The JavaScript API is 0.3's; what is new is that a WebAssembly module has to be instantiated before the API works. This page says how that happens in each runtime and bundler, and what to watch for.

::: warning The constants are `undefined` before `init()` with the `./init` entry
`CHANNEL_ORDER`, `MAX_CHANNELS`, `SHAPED_WAVE_TYPES`, and `fmPresets` are read from the module when it is instantiated. With the default entry that happens during the import, so they are always set. **With `@liminal-hq/undertone/init` they are `undefined` until `await init()` has finished**, and so is every call into the API (a call throws until then). Read them after `init()`, not at the top level of a module that imports `./init`.
:::

## Minimum runtimes

Node 22 or later, Bun 1.2 or later, current Deno, and browsers with WebAssembly, top-level `await`, and `FinalizationRegistry`: Chromium and Edge 89+, Firefox 89+, Safari 15+ (D-42). Node 20 is not supported. The package is ESM only.

## The entries

| Import                          | What it does                                                                                                                                               | Use it when                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `@liminal-hq/undertone`         | Instantiates the module during the import (top-level `await` in a browser; a synchronous read from disk under Node, Bun, and Deno). The API works at once. | Almost always.                                             |
| `@liminal-hq/undertone/init`    | Imports without instantiating anything. Call `await init()` once before using the API; calling it again returns the same promise.                          | Your build target or loader cannot take top-level `await`. |
| `@liminal-hq/undertone/testing` | `resetWarnings`, `seedContext`, `playVoice`, and `playVoices`, for tests of code that uses Undertone.                                                      | In test files.                                             |
| `@liminal-hq/undertone/wasm`    | The raw `wasm-bindgen` glue of the main module.                                                                                                            | Tools that load WebAssembly themselves.                    |
| `@liminal-hq/undertone/worklet` | `createWorkletOutput(context)`: plays patterns in an `AudioWorklet` instead of replaying them on the context. Opt-in; see below.                           | You want the sound made off the main thread.               |

`.` and `./init` are two separate loads of the module, each with its own memory and its own once-only warnings: a program uses one of them, not both.

```ts
import { init, note, CHANNEL_ORDER } from '@liminal-hq/undertone/init';

await init();
console.log(CHANNEL_ORDER.length); // 8, now that the module is loaded
note('c3 e3 g3').play();
```

## Two modules: playing and rendering

The package ships two WebAssembly modules:

- **The main module** (`wasm/undertone_wasm_bg.wasm`, about 147 KB after Brotli) holds patterns, controls, chords, instruments, scores, and the engine and scheduler that `play()` and `loop()` book with. It loads with the entry.
- **The render module** (`wasm/render/undertone_wasm_render_bg.wasm`, about 100 KB after Brotli) holds offline rendering. It loads the first time it is needed, so a game that only plays sounds never downloads it. WAV encoding (`encodeWav()`) is TypeScript in the package and does not need the render module, so it works as soon as the main module has loaded.
- **The worklet module** (`wasm/worklet/undertone_worklet_bg.wasm`, about 118 KB after Brotli) is the render module's crate built a second time for speed, and only the `./worklet` entry loads it. See _Two builds of the render crate_ below.

How the render module loads depends on the runtime:

- **In a browser** (both entries), the first `renderToBuffer()`, `pattern.render()`, or `score().render()` imports its glue with a dynamic `import()` and fetches the module.
- **Under Node, Bun, and Deno**, the module is read from disk and instantiated synchronously the first time a render needs it.

A render without `context` runs in the render module. A render with `context` books its voices on your `OfflineAudioContext` instead, so the browser's own convolver and compressor make the sound, as 0.3 always did.

## Node, Bun, and Deno

Import the package by name. The `node` export condition (which Node, Bun, and Deno all use) reads both modules from the package directory with `readFileSync` and instantiates them synchronously, so nothing needs to be awaited and the API works right after the import.

```ts
import { note, renderToBuffer, encodeWav } from '@liminal-hq/undertone';
import { writeFileSync } from 'node:fs';

const buffer = await renderToBuffer(note('c3 e3 g3'), { tail: 1 });
writeFileSync('arpeggio.wav', encodeWav(buffer));
```

There is no `AudioContext` outside a browser, so `play()` and `loop()` need a `ctx` (a library such as `node-web-audio-api`, or a fake one in tests); rendering needs nothing.

**Rendering with no browser is tested in all three.** CI renders five cases through the package in Node, Bun, and Deno and compares each WAV file byte for byte with the native Rust render (and the native build with a `wasm32-wasip1` build run under `wasmtime`); the files are identical. Locally, `bun run package:build`, then `scripts/check-wasi-render.sh` and `scripts/check-package-render.sh target/render-reference` do the same. CI runs Node 24 (the shared image's version), Bun 1.4.4, and Deno 2.9.8; Node 22, the floor, was run by hand and the checks pass there, and Node 20 is not supported (D-42). Deno needed no change: the `node` condition loads the package and its modules from disk as in Node. See [Rendering without a browser](/guide/rendering-and-export#rendering-without-a-browser).

## Browsers and bundlers

The default entry uses top-level `await`, which needs a build target of ES2022 or later.

- **Vite 6 and later:** nothing to configure. Each module is emitted as an asset and fetched next to its glue (`new URL('…_bg.wasm', import.meta.url)`), and the render module's glue becomes a chunk of its own. Another bundler needs top-level `await`, dynamic `import()`, and `new URL(…, import.meta.url)` assets; only Vite 5 is checked here.
- **Vite 5** (VitePress 1 included): its default build target refuses top-level `await` with `Top-level await is not available in the configured target environment`. Set the target, or use the `./init` entry, which builds at the default target:

```ts
// vite.config.ts
export default { build: { target: 'esnext' } };
```

(`['chrome89', 'firefox89', 'safari15']` also works.) The repository's `bun run package:load` builds both cases with Vite 5 and runs the bundles, a render included.

A bundler that tree-shakes by `sideEffects` keeps the entries' initialisation: the package lists its entry files (and the render module's glue) in `sideEffects`.

## The AudioWorklet backend (opt-in)

The default backend replays what the engine books onto your `AudioContext`, and the browser makes the sound. The `./worklet` entry is a second, separate way to play: the sound is made by Undertone's own renderer inside an `AudioWorklet`, with the same maths as `renderToBuffer`. It is off unless you ask for it, and nothing about `play()` and `loop()` changes (D-09).

```ts
import { note, stack, sound } from '@liminal-hq/undertone';
import { createWorkletOutput } from '@liminal-hq/undertone/worklet';

const context = new AudioContext();
const output = await createWorkletOutput(context, { channels: 2, seed: 'song' });

const song = stack(note('c2 g1').sound('sawtooth').lpf(500), sound('white*4').decay(0.03));
const loop = output.loop(song, { cycles: 4, bpm: 110 });

// later
loop.stop();
console.log(await output.stats());
output.close();
```

### What runs where

- **On the main thread:** patterns, JavaScript leaves, the tempo (`setcpm()`), and decoding samples. `output.play(pattern)` and `output.loop(pattern)` collect the voices the pattern gives, exactly as `renderToBuffer` does, so a pattern with a JavaScript leaf plays (the leaf is queried on the main thread, once per pass, never in the worklet). Bad options and a pattern that throws are reported to the caller at once.
- **In the worklet:** the worklet module's `WorkletEngine`. It receives the voices as plain numbers (a `Float64Array` and the strings they index) with the frame they start at, books each voice as the clock comes within 100 ms of it, and renders every 128-frame block. It never queries a pattern.
- **A loop goes on from cycle to cycle**, as the Web Audio backend's `loop()` does: with `cycles: 4` the first pass holds cycles 0 to 3, the next cycles 4 to 7, and `<c3 e3 g3>` keeps alternating. The main thread collects each pass (the main module's `startCycle`, an exact whole cycle number; it is not a public option) and posts it about four seconds before it is due, looking every 100 ms; the worklet's clock puts every pass at its exact frame, worked out from the pass number so rounding never builds up. The cost is that the main thread must keep supplying passes: it can stall for about four seconds before a loop gaps, where a pass the worklet repeated on its own would have gone on. A pass that cannot be collected or decoded ends the loop and is reported to `output.onerror`; what was posted plays out.
- **`stop()`** stops a loop from booking more, and cancels the passes that have not played out. What the worklet booked already, up to about 100 ms ahead, plays out, and so do the releases of notes already sounding.

### Two builds of the render crate

The worklet runs the same Rust crate as offline rendering (`undertone-wasm-render`, no source fork), built twice. Offline rendering and everything else load the size-optimised render module (`opt-level = "z"`, `wasm-opt -Oz`, 100.1 KB after Brotli). The `./worklet` entry loads a second build of the crate for speed (`--profile wasm-fast`: `opt-level = 3`, `wasm-opt -O3`, written to `wasm/worklet/undertone_worklet_bg.wasm`, 118.0 KB after Brotli), because `process` has 2.67 ms to render 128 frames at 48 kHz and the size build used 41% of that in a smoke run where the speed build used 9%. Both are held to 120 KB after Brotli; the worklet module is over the 108 KB warning line (98% of the budget), which is expected. It is a different file with a different name so the two cannot be mistaken for each other, and a page that never uses the worklet never downloads it. The two builds give the same samples to the last bit (the maths is deterministic, D-23): a test renders the same voices through both and compares them.

### Loading, and what a bundler must do

The main thread compiles the worklet module once and posts the `WebAssembly.Module` to the worklet, which instantiates it synchronously (D-47). The module added to the worklet is made at run time, as a `blob:` URL, from three pieces: a small `TextDecoder` and `TextEncoder` shim (the worklet scope has neither), the worklet module's glue text, and the processor. The glue and the module are found next to the package's own files with `new URL('…', import.meta.url)`, which Vite and webpack copy as assets, so a bundler that supports that needs nothing more. Where it does not, or the page's policy refuses `blob:` URLs, give them yourself:

| Option                  | What it is                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `wasm`                  | The worklet module: a compiled `WebAssembly.Module`, its bytes, a `Response`, or a URL.                 |
| `glueUrl` or `glueText` | The worklet module's glue (`@liminal-hq/undertone/wasm/worklet/undertone_worklet.js`) as a URL or text. |
| `moduleUrl`             | A module you host (build it with `workletModuleSource(glueText)` and serve it), instead of a blob.      |

An `AudioWorklet` needs a secure context (https or `localhost`). A browser that cannot send a compiled module to a worklet gets the module's bytes, and the processor compiles them.

### Cross-origin isolation, and the message port

Voices travel over the processor's `MessagePort`, which is always available; the numbers are transferred, not copied. A ring over a `SharedArrayBuffer` for cross-origin isolated pages was not built: the port's cost is what the harness measures first (see below). `output.crossOriginIsolated` says whether the page is isolated.

### Samples

The worklet keeps its own sample registry, fed from the package's: every sample registered, decoded, or cleared on the main thread is sent over as PCM (copied, once). A pass that names a sample that has not been decoded waits until it has (`playback.ready` resolves when the pass has been posted); preload with `loadSamples(context)` to avoid the wait. Decoding itself stays on the main thread, because a worklet cannot decode audio.

### Statistics

`await output.stats()` answers from the worklet: `blocks`, the time of each `process` call as `processMs` (`mean`, `p50`, `p99`, `p999`, `max`, in milliseconds, against `budgetMs`, which is 128 frames at the sample rate), `overruns` (blocks that took longer than the budget), `skippedBlocks` (blocks the host never asked for), `driftFrames` (how far the engine's clock has fallen behind the host's, zero when none was skipped), `lateStarts` (passes that arrived after their start frame), `liveNodes`, and the errors the worklet reported. `output.onerror` receives them as they happen. A voice that fails to book is skipped and the sound goes on.

::: warning Chromium's worklet scope has no `performance.now()`
A headless Chromium check found that `AudioWorkletGlobalScope` has no `performance`, so the processor cannot time itself the way the acceptance names. `createWorkletOutput(context, { clock: 'spin' })` works around it: a worker on the page counts in a `SharedArrayBuffer`, the processor reads the counter around each `process` call, and the page measures the counter's speed against `performance.now()`. It needs a cross-origin isolated page (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`) and spends a core's worth of the device while it runs, which a small phone may feel. Without it `output.timing` is `'none'` and the statistics have no times (the counts of skipped blocks and drift still work). `output.timing` and `output.timingNote` say what you got. Other browsers' worklet scopes were not checked.
:::

### Booking allocates

Booking a voice builds nodes and, for a reverb, an impulse response, so it allocates inside the worklet. That is accepted for this opt-in backend (D-34 stands); the queue books a few voices a block, not a pass at once, and the statistics' `queueMs` and `processMs` show what it costs.

### The harness, and what was measured

`packages/undertone/harness/` holds a page for the acceptance checks of RF-29: a pattern looped for five minutes (representative, heavy, or light), with underruns, the 99th percentile of `process` against its budget, and drift shown and marked against the three limits (no underrun, p99 at most 40% of the budget, drift of zero frames). Build the package, run `bun packages/undertone/harness/serve.ts`, and open the page it prints; on a phone, `adb reverse tcp:8080 tcp:8080` and open `localhost:8080/harness/`. `check.ts` in the same folder opens the worklet in headless Chromium (through Playwright's core library, which is not a dependency) and compares what it renders with `renderToBuffer`.

What has been run, and what has not:

- **Headless Chromium 156 on a Linux desktop, offline context:** a worklet pass of the representative pattern, stereo and mono, equals the offline render to within 1.8e-7 (a few ulps; the light pattern is bit for bit equal). This shows the worklet loads (the shim, the glue, and the module in a real `AudioWorkletGlobalScope`), books, and renders. It is a correctness check, not a performance or listening result.
- **Not run:** the phone, the Steam Deck, and throttled Chromium (the person's, N-3 in `HANDOFFS.md`); a five-minute run on any machine; Firefox and Safari; and anything with a real audio device. Nothing was listened to.
- **A smoke observation, not a result:** 20-second real-time runs of the harness in headless Chromium with no audio device, on a 16-thread desktop, with the spin clock's worker running. With the size-optimised build (`opt-level = "z"`, `wasm-opt -Oz`) the representative pattern's `process` had a mean of 0.62 ms and a 99th percentile of 1.09 ms for a block budget of 2.67 ms (41%), with no overruns and no drift. The worklet module the package now ships (the speed build above, 118.0 KB) measured a mean of 0.11 ms and a 99th percentile of 0.24 ms (9%, two runs: 0.24 and 0.25 ms, in 5 microsecond buckets), no overruns, no drift, the loop's four passes posted as the context clock moved. The comparison with `renderToBuffer` passes with the same differences as before (the representative pattern within 1.8e-7, the light patterns exact). A headless desktop with no audio device is not a phone, a Steam Deck, or throttled Chromium, and none of it is the acceptance.

## Memory: `free()` on patterns

A `Pattern` holds a handle to a tree in WebAssembly memory. The garbage collector frees it eventually, but it cannot see that memory, so dead handles can wait for seconds. Nothing leaks, but a long loop that builds many patterns should free them, with `free()` or `using`:

```ts
for (const part of parts) {
  using pattern = note(part).fast(2); // freed at the end of each pass
  pattern.play({ ctx });
}
```

Engines and players need nothing of the kind: one engine is made per audio context the first time you play on it and lives as long as the context, and the nodes of finished voices are released as new ones are booked, so a loop that runs for hours keeps its memory where it was.

## What a context needs

Playing uses the context's standard factories. Four members are optional, and without them the package degrades as 0.3 did, each with one warning:

- no `createPeriodicWave`: a shaped wave (`halfsine`, `abssine`, `pulsesine`) plays as a sine, and an autopan phase is ignored;
- no `createDynamicsCompressor`: the master bus has no limiter;
- no `createWaveShaper`: the master bus has no ceiling;
- a param without `cancelScheduledValues` (or `setTargetAtTime`): an early `stop()` cuts the voice hard (or fades it with a straight ramp).
