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
- **The render module** (`wasm/render/undertone_wasm_render_bg.wasm`, about 97 KB after Brotli) holds offline rendering. It loads the first time it is needed, so a game that only plays sounds never downloads it. WAV encoding (`encodeWav()`) is TypeScript in the package and does not need the render module, so it works as soon as the main module has loaded.

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
