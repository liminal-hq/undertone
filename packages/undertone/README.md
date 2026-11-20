# @liminal-hq/undertone

A small procedural synth engine for game sound effects and pattern-based music: Web Audio, mini-notation, euclidean rhythms. This package is Undertone 0.4 rebuilt as a TypeScript bridge over a Rust core compiled to WebAssembly. It keeps 0.4.0's JavaScript names and behaviour; the breaks are listed in [CHANGELOG.md](./CHANGELOG.md).

**Status: unreleased.** `package.json` says `"private": true` so that `npm publish` refuses until the release work package (RF-33) flips it. The whole 0.4.0 API is in: patterns, controls, notes, chords, scales, instruments, scores, signals, `play()`, `loop()`, `playParams`, `setcpm`, the sample registry, the master bus, orbit buses, multichannel output, offline rendering, and WAV encoding. `bun run package:api` in the repository compares the package's exports with the 0.4.0 API report: every name is present with the same declaration.

## Install

```sh
npm install @liminal-hq/undertone
```

Node 22 or later, Bun 1.2 or later, current Deno, and browsers with WebAssembly and top-level `await`. The package is ESM only.

## Loading

The WebAssembly module has to be instantiated before the API works. Three entries cover every setup (D-17):

- **`@liminal-hq/undertone`** instantiates the module with top-level `await`, so the API works right after the import. Under Node, Bun, and Deno the `node` export condition reads the module from disk and instantiates it synchronously instead, so nothing is awaited at all.
- **`@liminal-hq/undertone/init`** does not await anything on import: call `await init()` once before using the API (calling it again returns the same promise). Use it where top-level `await` is not available. Under Node, Bun, and Deno `init()` has nothing left to do.
- **`@liminal-hq/undertone/wasm`** is the raw `wasm-bindgen` glue, and `@liminal-hq/undertone/wasm/undertone_wasm_bg.wasm` the module, for tools that load WebAssembly themselves.

The first two are separate loads of the module: a program uses one of them, not both.

> **With `./init`, the constants are `undefined` until `init()` has finished.** `CHANNEL_ORDER`, `MAX_CHANNELS`, `SHAPED_WAVE_TYPES`, and `fmPresets` are read from the module when it loads, so with the `./init` entry they are `undefined` (and every call throws) until `await init()` resolves. Read them after `init()`, not at the top level of a module. The default entry has them set as soon as the import finishes.

### Rendering loads a second module

Offline rendering and WAV encoding are in a second module, `wasm/render/`, which loads the first time it is needed, so a program that only plays never downloads it. In a browser the first `renderToBuffer()`, `.render()`, or `score().render()` imports and fetches it; **`encodeWav()` returns its bytes synchronously, so in a browser call it after a render** (before any render it throws, saying so). Under Node, Bun, and Deno both modules are read from disk on first use, and `encodeWav()` works at any time.

### Vite 5, and bundler targets

Top-level `await` needs a build target of ES2022 or later. **Vite 5's default build target does not allow it**, so a Vite 5 build (VitePress 1 included) fails with `Top-level await is not available in the configured target environment`. Set the target:

```ts
// vite.config.ts
export default { build: { target: 'esnext' } };
```

(`['chrome89', 'firefox89', 'safari15']` also works.) Vite 6 and later need nothing. Or use the `./init` entry, which builds at Vite 5's default target. `bun run package:load` in the repository checks all three cases against the packed tarball, a render included.

The guide's [Runtimes and loading](https://liminalhq.ca/undertone/guide/runtimes) page has the details for each runtime.

## Freeing patterns

A `Pattern` holds a handle to a tree in WebAssembly memory. The garbage collector frees it eventually, but it cannot see that memory, so dead handles can wait for seconds. Nothing leaks, but **a long loop that builds many patterns should free them**:

```ts
for (const part of parts) {
  using pattern = mini(part, (word) => word).fast(2); // freed at the end of each pass
  render(pattern.query(span));
}

const once = mini('a b', (word) => word);
once.free(); // or by hand; calling free() twice is safe
```

A freed pattern cannot be used again (it throws `this pattern was freed and cannot be used again`); patterns made from it are unaffected. Engines need nothing of the kind: one is made per audio context on first use, and the nodes of finished voices are released as new ones are booked.

## Testing your own code

`@liminal-hq/undertone/testing` (D-28) has `resetWarnings` (clears every once-only warning, so a test sees one again; the modules print with `console.warn`, so `vi.spyOn(console, 'warn')` sees them), `seedContext(ctx, seed)`, `playVoice(ctx, params, startTime, options?)`, and `playVoices(ctx, voices, when, options?)`.

## Differences from the reference

See [CHANGELOG.md](./CHANGELOG.md): _Moving from 0.3_.
