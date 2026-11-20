# @liminal-hq/undertone

A small procedural synth engine for game sound effects and pattern-based music: Web Audio, mini-notation, euclidean rhythms. This package is Undertone 0.4 rebuilt as a TypeScript bridge over a Rust core compiled to WebAssembly. It keeps 0.4.0's JavaScript names and behaviour; the breaks are listed in [CHANGELOG.md](./CHANGELOG.md).

**Status: unreleased, and part of the way there.** `package.json` says `"private": true` so that `npm publish` refuses until the release work package (RF-33) flips it. The package core is in: `Fraction`, `Pattern` and its queries and transforms, the constructors, the signals and seeded randomness, and the pitch helpers. The control methods (`.gain()`, `.lpf()`, `.pan()`, ...), `note()`/`sound()`/`chord()`, scores, drift, instruments, samples, the engine, rendering, and the scheduler arrive with the next parts of the Rust bindings; `bun run package:api` in the repository lists exactly which names are still pending.

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

### Vite 5, and bundler targets

Top-level `await` needs a build target of ES2022 or later. **Vite 5's default build target does not allow it**, so a Vite 5 build (VitePress 1 included) fails with `Top-level await is not available in the configured target environment`. Set the target:

```ts
// vite.config.ts
export default { build: { target: 'esnext' } };
```

(`['chrome89', 'firefox89', 'safari15']` also works.) Vite 6 and later need nothing. Or use the `./init` entry, which builds at Vite 5's default target. `bun run package:load` in the repository checks all three cases against the packed tarball.

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

A freed pattern cannot be used again (it throws `this pattern was freed and cannot be used again`); patterns made from it are unaffected.

## What is pending

Everything the reference 0.4.0 exports that this package does not yet: the 53 control methods and `voice`, `scale`, `voicing`; `Pattern.play`, `.loop`, and `.render`; `note`, `n`, `s`, `sound`, `chord`; `resolveParams`, `playParams`; `score`; `drift`; `fmVoice`, `fmPresets`, `layer`; the sample registry; `renderToBuffer` and `encodeWav`; `setcpm`; the surround helpers; and their types. The list is `conformance/api/package-pending.txt`, and CI fails when it and the package disagree. The `./testing` entry (D-28) exists with `resetWarnings`, and `seedContext`, `playVoice`, and `playVoices` that say what they wait for.

## Differences from the reference

See [CHANGELOG.md](./CHANGELOG.md): _Moving from 0.3_.
