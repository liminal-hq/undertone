# M6: JS bridge

## Objective

`@liminal-hq/undertone` is rebuilt as a TypeScript bridge over a WebAssembly build of the Rust, keeping the JavaScript names and behaviour of 0.4.0, and it passes the reused TypeScript test suite and the corpus.

**Depends on:** M5 for the Rust API groups the bridge wraps (the bridge for a group can start as soon as that group's Rust is green) and on M2's R2 to R5 results (they fix the bridge's shape, loading, and size strategy). **Done when:** the TypeScript suite and the corpus pass on the WASM package.

## Work packages

### RF-24. `undertone-wasm`: the control bindings

- **Naming:** this is the real WebAssembly Undertone: the build of the full Rust API from which the npm package is built. It is not the lab's `undertone-wasm`, which is that repository's demo bindings.
- **Owner:** A. **Size:** L. **Depends on:** RF-09, RF-10, RF-11, RF-13 (and grows as M3 to M5 land).
- **Objective:** a `wasm-bindgen` crate exposing patterns as handles, controls, constructors, signals, scheduling as booking operations, and rendering, with no generics across the boundary.
- **Steps:** (1) `crates/undertone-wasm` with `wasm-bindgen` pinned exactly (take the newest at the time and pin it), `weak-refs` on; (2) one exported function per bridge method, generated from the same control table as RF-14 where possible; (3) data types (`VoiceParams`, `ScoreEvent`, options) crossing as plain objects through `serde-wasm-bindgen`, with TypeScript declarations from `ts-rs` or `tsify` (D-11); (4) a `scripts/build-wasm.sh` that checks the `wasm-bindgen` CLI version against the pin, builds with the release profile from R4, runs `wasm-opt -Oz`, and writes into `packages/undertone/wasm/`; (5) size budgets (D-07) as a failing CI check; (6) **documentation:** rustdoc on the crate (it is `publish = false`, but `cargo doc` still covers it).
- **Decision needed first:** D-06 (accept the bridge's breaks) before this package starts.
- **Acceptance:** the module builds in CI under budget; every exported function is reached by a test in RF-27.
- **From M2 ([DESIGN-ADJUSTMENTS.md](../results/DESIGN-ADJUSTMENTS.md)):** a list argument (`seq`, `cat`, `stack`, `timecat`, `arrange`, `choose`) must be built with borrowing `push` calls, never as an array of exported handles, because `wasm-bindgen` moves an exported struct out of a JavaScript array and nulls its JavaScript object (R5); `new Pattern(query, sample)` must carry its sampler (R5); the build runs `wasm-opt -Oz -all` (R4: the `binaryen` npm package works; D-22); budgets per D-07 (R4); `serde_json` never enters the control module (+16.3 KB), `serde-wasm-bindgen` stays (+7.2 KB).

### RF-25. The bridge package: wrappers, loading, the kept extras

- **Owner:** A. **Size:** L. **Depends on:** RF-24, RF-12.
- **Objective:** `packages/undertone/`, the TypeScript bridge published as `@liminal-hq/undertone`, exporting the same names as 0.4.0 with the same behaviour, over the WASM core.
- **Steps:** (1) `Pattern` class wrapping a handle; every method returns a new wrapper; `instanceof Pattern` holds; (2) `every` and `jux` call the JavaScript function once with a wrapper of the receiver, as `pattern.ts` does; (3) `.query` stays a public property returning `Hap` objects with JavaScript `Fraction` objects; (4) `new Pattern(query)`, `fmap(fn)`, and `signal(fn)` with JavaScript functions become foreign leaves (a pattern with one runs on the thread that made it; the worklet backend refuses it with a diagnostic), unless D-06 drops them; (5) loading per D-17 (top-level `await` in the entry by default); (6) error messages word for word (the corpus records them); (7) the breaks D-06 accepted are documented in the package's `CHANGELOG.md`; (8) the API report check (RF-06) runs against the package's `.d.ts`; (9) **documentation:** TypeDoc is re-pointed at `packages/undertone` (`typedoc.json`; `bun run docs:api` regenerates the API reference from the package), and the package's `README.md` covers installation and loading.
- **Files:** `packages/undertone/{package.json,tsconfig.json,src/**,wasm/}`, root `package.json` (workspaces), `typedoc.json`, CI.
- **Acceptance:** the API report matches 0.4.0's, or every difference is a break listed in D-06; the R3 checks pass on the package; `bun run docs:api` and `bun run docs:build` are green against the package.
- **From M2 ([DESIGN-ADJUSTMENTS.md](../results/DESIGN-ADJUSTMENTS.md)):** the wrapper `Pattern` gets an opt-in `free()` and `[Symbol.dispose]()`, with a test that builds and drops a million handles with and without it (R2: the collector cannot see WebAssembly memory, so dead handles can stay for seconds, and nothing leaks); document that long loops that build patterns should call `free()` or use `using`. Entry shape per D-17: top-level `await` in `.`, a `./init` subpath as the explicit-init escape hatch (the two are separate WebAssembly instances, so a program uses one), a synchronous `node` export condition, and a `build.target` install note for Vite 5 (R3). JavaScript-side validation messages (`add() needs a number...`) stay in the TypeScript wrapper and are tested against the corpus (R5); a bare `toThrow()` must not be trusted before the export exists.

### RF-26. The Web Audio backend

- **Owner:** A. **Size:** M. **Depends on:** RF-25, RF-18.
- **Objective:** playing on the caller's `AudioContextLike` works as today: the engine's booking operations (the `Graph` calls) are replayed by the bridge as the same `AudioContextLike` calls, in the same order, so the recorded graph on the fake context is byte-identical and a context missing optional factories degrades with the same warnings. This keeps the browser's own convolver and compressor and is the browser default (D-09).
- **Steps:** (1) a `Graph` implementation in `undertone-wasm` that records operations into a compact buffer; (2) the bridge's replayer (`packages/undertone/src/webaudio.ts`) that turns the buffer into context calls; (3) `playParams`, `.play`, `.loop`, `createMasterBus`, `getOrbitBus`, `createMonoFold`, `buildImpulseResponse` on the caller's context.
- **Acceptance:** every recorded-graph test classified "public API" in R5 passes against the bridge with the fake context.
- **From M2 ([DESIGN-ADJUSTMENTS.md](../results/DESIGN-ADJUSTMENTS.md)):** the replay sends operations, not objects: a flat `Float64Array` of fixed-width records worked and is cheap to replay, and the Rust booking must call Web Audio in the TypeScript engine's order so the node numbering matches (graphs diff by creation order); `replay` needs the destination and the channel-merger setup (R3).

### RF-27. The TypeScript suite and the corpus on the bridge

- **Owner:** A. **Size:** M. **Depends on:** RF-26.
- **Objective:** the TypeScript test suite is reused against the bridge: the tests classified **public API** in `conformance/test-classes.json` run unchanged against the package; **internal** tests have Rust unit tests that cover the same behaviour (listed one to one in the classification file); **Web Audio** tests run against the Web Audio backend. The documentation snippets (`docSnippets.test.ts`) run against the package too.
- **Steps:** (1) copy the public-API and Web Audio test files into `packages/undertone/test/`, changing only the import (`../src/index` to the package entry) and the fake context's import; (2) a corpus runner in Vitest that runs layers 1 to 3 against the package; (3) for each internal test, name the Rust test that replaces it; (4) **documentation:** runtime notes for the package (Node 20, Bun 1.2, Deno, browsers: loading, bundler config, `free()` on engines and players), added to the guide as `docs/guide/runtimes.md` (and the guide sidebar), with the minimum runtimes from D-08; update `README.md`'s API tables and the package README for anything the bridge changed.
- **Acceptance:** 100% of public-API and Web Audio tests pass (or each failure is a break accepted in D-06, with the test changed to the new behaviour and the change listed); corpus layers 1 to 3 green on the package; doc snippets green.
- **From M2 ([DESIGN-ADJUSTMENTS.md](../results/DESIGN-ADJUSTMENTS.md)):** the suite is **813 tests in 31 files**, not 753, and `conformance/test-classes.json` (kept, with `bun run test-classes:check` in CI) classifies every one: 724 public API (330 alias, 394 need a named translation), 68 internal (53 become Rust unit tests, 15 stay TypeScript), 21 Web Audio. Step (1) is therefore not "change only the import": 306 public tests need `resetWarnings` (4 also `seedContext`) and 93 use `playVoice`/`playVoices` (to become `playParams`), none exported from `src/index.ts`. D-24 proposes a `@liminal-hq/undertone/testing` entry, kept out of the API report. `conformance/recorder/test-classes.ts`, `spikes/r5-suite/classify.mjs`, and `report.mjs` may be reused.

## Planned stack

Four pull requests, one work package each.

| #   | Branch                          | Pull request title                                                       | Work package |
| --- | ------------------------------- | ------------------------------------------------------------------------ | ------------ |
| 1   | `feat/wasm-control-bindings`    | Expose the Rust API to JavaScript through WebAssembly                    | RF-24        |
| 2   | `feat/bridge-package`           | Add the `@liminal-hq/undertone` bridge package over the WebAssembly core | RF-25        |
| 3   | `feat/bridge-web-audio-backend` | Replay booked voices on the caller's Web Audio context                   | RF-26        |
| 4   | `test/bridge-suite-and-corpus`  | Run the TypeScript suite and the corpus against the bridge               | RF-27        |

## Documentation in this milestone

- **JavaScript API docs:** TypeDoc re-pointed at `packages/undertone` (RF-25), so `docs/api/` describes the package.
- **Runtime notes:** Node, Bun, Deno, and browser loading, with the bundler config line R3 settles (RF-27); WASI, the worklet, and native notes follow in M7.
- `README.md` API tables updated for the package; a draft of the "Moving from 0.3" notes started in `packages/undertone/CHANGELOG.md` (RF-25) for RF-33 to finish.
- `bun run typecheck:docs` and `bun run docs:build` run whenever the theme, playground, or `typedoc.json` changes.

## Agent assignments

The orchestrator assigns Sonnet agents. The four packages are sequential in the main; RF-24 and the first part of RF-25 can overlap once D-06 is answered. At most 2 Rust-building agents at once.

## Status log

| Date       | Entry       |
| ---------- | ----------- |
| 2026-11-18 | Not started |
