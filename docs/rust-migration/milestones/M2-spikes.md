# M2: Spikes

## Objective

Six time-boxed spikes retire the technical risks that decide the design: the pattern core and signals (R1), closures and handles across WebAssembly (R2), loading (R3), size (R4), the reuse of the TypeScript suite (R5), and maths determinism (R9). They are de-risking, not approval gates: a failure changes the design and this plan, and the work continues.

**Depends on:** M1 (the corpus recorder, the Rust CI, the workspace). **Gates:** R1 and R9 gate M3. R2 to R5 gate M6. **Done when:** every spike has `results/R<n>.md` and `results/DESIGN-ADJUSTMENTS.md` lists what changed.

The design's other spikes became acceptance checks inside work packages: R6 (the worklet on weak hardware) is RF-29's acceptance, R7 (`cpal`) is RF-28's, R8 (no browser) is RF-30, R10 (the 0.4.0 engine features) is RF-18, the signals-off-the-main-thread check is in RF-16, the API report is RF-06, and the CI cost measurement is RF-04's step 3. The numbering R1 to R10 is kept from the original design so the two documents can be read side by side.

Spike code lives on `chore/spike-r<n>-<short-description>` branches and does not merge as is; code that passes review may be kept as the start of the package it belongs to (the result says which). Nothing is pushed or merged without following the working model in [README.md](../README.md#working-model).

## The result file

Each spike ends with `docs/rust-migration/results/R<n>.md`, with these headings:

- **Verdict:** pass, fail, or pass with conditions (each named).
- **What was run:** commit SHAs, machine, toolchain, browser and runtime versions.
- **Measurements:** a table of numbers against the thresholds below.
- **What failed and why**, and the fallback taken.
- **What it changes** in this plan, [ARCHITECTURE.md](../ARCHITECTURE.md), or [API-MAPPING.md](../API-MAPPING.md).
- **What was not verified**, and whether anything was listened to (say plainly when nothing was).

When all six are done, `results/DESIGN-ADJUSTMENTS.md` collects the changes and the plan files are updated in the same pull request.

## Order

| Days (from the start of M2) | Spike | Needs                             |
| --------------------------- | ----- | --------------------------------- |
| 1 to 5                      | R1    | RF-05's 300-program subset        |
| 1 to 2 (beside R1)          | R9    | RF-04                             |
| 4 to 6                      | R2    | R1's first nodes (`Rev`, `Every`) |
| 7 to 9                      | R3    | R2's binding                      |
| 7 to 8 (beside R3)          | R4    | R2's binding                      |
| 10 to 14                    | R5    | R3's bridge skeleton              |

M3 may start when R1 and R9 have results; M6 when R2, R3, R4, and R5 have. Spike builds and size experiments run one at a time (resource watch), so "beside" means in the same week, not at the same moment.

## Work packages

### RF-07. Spike R1: the pattern and signals core

- **Owner:** A. **Box:** 5 days for the node-tree question, plus the base types below (the earlier plan assumed they already existed; they are now written here, so the orchestrator should expect the spike to run longer and say so in the result). **Depends on:** RF-05's 300-program subset.
- **Question:** can a node-tree pattern crate (`undertone-pattern`, built here from the TypeScript reference) reproduce 0.4.0's pattern semantics, signals included, exactly, with no closures in the tree except the two escape hatches?
- **Setup (nothing is inherited):** `crates/undertone-pattern` starts empty. The spike first writes the base: `Fraction` on `i128` (D-13), `Span`, `Hap`, a `Pattern<T>` over an `Arc` node tree with `Silence`, `Pure`, `Stack`, `Cat`, `Compress`, `Fast`, `Slow`; the constructors `silence`, `pure`, `stack`, `cat`, `timecat`, `seq`, `fast`, `slow`, `euclid` (with a `bjorklund` helper); a mini-notation `parse` taking the leaf rule; and a `js` module of the JavaScript number and string behaviour the reference depends on (`Math.round` ties, number formatting for seed keys, UTF-16 positions). The corpus subset from RF-05 supplies the oracle: 300 programs recorded at `452f782` covering `rev`, `every`, `jux`, `arrange`, `fmap` (as a named map only), `withControlPattern` with five controls (`gain`, `lpf`, `pan`, `attack`, `n`), `note`, `n().scale()`, and the signals (`sine`, `cosine`, `saw`, `isaw`, `tri`, `square`, their `…2` forms, `rand`, `rand2`, `irand`, `choose`, `brand`, `brandBy`, `perlin`, `.seed`, `.segment`, `.range`, `.range2`, `.rangex`, `add`, `sub`, `mul`, `div`, `round`, `floor`) as exported from `src/index.ts` and implemented in `src/signal.ts` and `src/pattern.ts`. The lab's `undertone-mini` may be read for ideas; it is not copied or imported.
- **Steps:** (1) write the base above, read from the TypeScript; (2) add the nodes `Rev`, `Every`, `Arrange`, `WithControl`, `Signal`, `Sample`, `Segment`, `Map`; (3) give every node `query(span)` and `sample(t)` from one pass-through table (the TypeScript's sampler passes through `fast`, `slow`, `rev`, `range`, `fmap`, `cat`, `seq`, `timecat`, `stack`, `arrange`, `every`); (4) a corpus runner (`crates/undertone-pattern/tests/corpus.rs`) and the interpreter that turns a program into calls; run the 300 programs; (5) a `proptest` of query-window independence over 10,000 random programs of depth at most 5 ([CONFORMANCE.md](../CONFORMANCE.md#query-window-independence-and-property-tests)); (6) print a tree, hash a tree, and send a tree to another thread (`Send + Sync`).
- **Measure:** programs equal (exact fractions); property failures; closure nodes in the tree outside `Foreign` and `Custom` (must be zero).
- **Pass:** all 300 equal; 10,000 property cases pass; no closure outside the escape hatches.
- **Fail changes:** failures confined to one area: that node is redesigned in RF-13 or RF-16 (+3 days). Signals cannot be built-in nodes: the planner's position is dropped for an `Arc<dyn Fn>` signal leaf, which pins signal patterns to the thread that built them and removes querying in a worklet from RF-16 and RF-29; tell the person.
- **Files:** `crates/undertone-pattern/src/**`, `crates/undertone-pattern/tests/corpus.rs`, `docs/rust-migration/results/R1.md`.
- **Acceptance:** `results/R1.md` committed with the verdict.
- **Hand-off:** the tree design to RF-13 and RF-16.

### RF-08. Spike R9: maths determinism

- **Owner:** A. **Box:** 2 days. **Depends on:** RF-04.
- **Question:** does the engine use the C library natively and `libm` in WASM, or `libm` everywhere?
- **Setup:** the reference's recorded graphs were made by JavaScriptCore on Linux, so the engine's maths must match it. In `undertone-engine`, write a small `math` module (`sin`, `cos`, `exp`, `pow` through the C library, and the same through the `libm` crate behind a feature), and a function that builds the periodic-wave tables as `src/waves.ts` and `src/engine.ts` do. Build for `wasm32-unknown-unknown` with `libm` and natively with the C library; compute the wave tables and the graph numbers of a few layer 3 corpus cases both ways, and compare with the corpus.
- **Pass:** recorded numbers identical (they round to nine significant digits); renders within 1e-6 RMS of each other.
- **Fail changes:** `libm` everywhere, with the Rust cases checked against it; the TypeScript reference stays on JavaScriptCore, so corpus layer 4 compares with tolerances ([CONFORMANCE.md](../CONFORMANCE.md#golden-renders-and-tolerances)) rather than bits.
- **Files:** `crates/undertone-engine/src/math.rs` (kept if it passes review), `docs/rust-migration/results/R9.md`.
- **Acceptance:** `results/R9.md`; the decision written into [CONFORMANCE.md](../CONFORMANCE.md)'s tolerance table.

### RF-09. Spike R2: closures and handles across WebAssembly

- **Owner:** A. **Box:** 3 days. **Depends on:** RF-07's first nodes (`Rev`, `Every`).
- **Question:** do `every(n, fn)`, `jux(fn)`, `fmap(fn)`, and `new Pattern(query)` cost what the design says across the boundary, and are pattern handles freed by the garbage collector in every target runtime? (This includes the former R12.)
- **Setup:** R1's crate behind a throwaway `wasm-bindgen` crate (pin the version exactly, `--target web`, `weak-refs` on) and a 100-line TypeScript wrapper with a `Pattern` class holding a handle.
- **Steps:** (1) `note('c4 e4').every(2, p => p.rev())` and `.jux(rev)`: count JavaScript calls during 1,000 queries (a counter in the wrapper); (2) `fmap(v => v + 1)` as a foreign leaf: median time of a 32-hap query over 10,000 runs in Node 20 and Chromium; (3) build and drop one million patterns in chains of ten with an `await` every 10,000, in Chromium, Firefox, WebKit (Playwright), Node 20 (`--expose-gc`), Bun 1.2, and Deno; sample `WebAssembly.Memory.buffer.byteLength` and the live-handle count every 100,000.
- **Pass:** zero JavaScript calls during queries of closure-at-construction chains; a 32-hap foreign leaf under 20 µs median; live handles back within 1% of the start within ten seconds of the loop ending in every runtime, and no monotonic memory climb over three repeats.
- **Fail changes:** foreign leaves too slow: patterns with a foreign leaf are queried entirely in JavaScript by a small interpreter in the bridge (RF-25, +1 week), or D-06 drops `new Pattern(query)` and per-query `fmap`. Handles not freed: an opt-in `free()` and a `Symbol.dispose` method on patterns (an addition, not a break), documented; the garbage-collected path stays the default. Engines, players, and loop handles keep an explicit `free()` (or `stop()` then `free()`) either way.
- **Acceptance:** `results/R2.md`.

### RF-10. Spike R3: loading and the bridge skeleton

- **Owner:** A. **Box:** 3 days. **Depends on:** RF-09. **Decides:** D-17.
- **Question:** can a WASM-backed `@liminal-hq/undertone` be used right after `import`, as today (`import { note } from '@liminal-hq/undertone'`, then `note('c4').play()`), and how do its recorded graphs compare?
- **Setup:** R2's wrapper grown into a skeleton bridge with an entry that instantiates the module with top-level `await`; packed with `bun pm pack` (never published). Scratch apps: a Vite app at Vite 5's default build target with a static import; a Vite app at this repository's Vite (8); a dynamic `import()` in a browser page; Node 20 and Bun 1.2 scripts; this repository's playground, which evaluates code with `new Function` over every export.
- **Steps:** (1) build each scratch app; (2) at Vite 5's default target, try: no config, `build.target: 'esnext'`, and an explicit `await init()` export as the alternative; (3) record the fake-context graph of five 0.4.0 programs through a stub replay and diff it against the TypeScript's; (4) time from import resolution to the first `play()` booking.
- **Pass:** every scratch app builds and runs with at most one documented config line; the five graphs equal the TypeScript's byte for byte; the first `play()` after import is booked on time.
- **Fail changes:** top-level `await` refused by a common bundler target: D-17 becomes an explicit `await init()` (a documented break, listed in D-06), or lazy instantiation where calls before readiness are recorded and replayed; the person picks. Graphs differ: a defect in the replay design, fixed in RF-26's design before it starts.
- **Acceptance:** `results/R3.md`; **stop (D-17)** and ask the person if R3 fails or is marginal.

### RF-11. Spike R4: size and build time

- **Owner:** A. **Box:** 2 days. **Depends on:** RF-09.
- **Setup:** R2's control module and a minimal worklet module (raw C ABI, the engine and pure booking only); release profile `opt-level = "z"`, `lto = true`, `panic = "abort"`, `codegen-units = 1`, `strip = true`; `wasm-opt -Oz`. Extrapolate the control module to the whole API by adding the engine and every control method stubbed through (the method table from RF-14).
- **Measure:** raw, gzip -9, and Brotli 11 sizes of each module; the minified and Brotli size of the 0.4.0 TypeScript package (`bun build dist/index.js --minify`) for comparison; an incremental `cargo build` of the control crate after touching one file; a clean release build of both modules on the person's machine. Run one build at a time (disk and memory).
- **Pass:** control at most 150 KB and worklet at most 200 KB after Brotli (D-07), together under 300 KB; incremental build under 30 s; clean build under 2 minutes.
- **Fail changes:** scales, chords, and signals become cargo features and optional sub-modules; `serde_json` leaves the control module; if still over, the person sets new budgets (D-07).
- **Acceptance:** `results/R4.md`; the budgets (D-07) become failing CI checks in RF-24.

### RF-12. Spike R5: the TypeScript suite against the bridge

- **Owner:** A. **Box:** 5 days. **Depends on:** RF-10.
- **Setup:** the reference's suite at `452f782` (#44 reports 753 tests; recount with `bun run test` at the start) and R3's skeleton bridge. A Vitest config (`packages/undertone/vitest.config.ts` or a spike config) whose alias resolves `./index`, `../src/index`, and every public module path the tests import to the bridge.
- **Steps:** (1) classify every test file and every `it` as **public API** (patterns, haps, controls, recorded fake-context graphs, rendering results), **internal** (private functions; to be replaced by Rust unit tests), or **Web Audio** (the scheduler's timer, context quirks; to run against the Web Audio backend); write `conformance/test-classes.json` (`{ file, test, class, covers, note }`); (2) run the public-API tests against the skeleton; (3) list every failure with a cause.
- **Pass:** at least 90% of the public-API tests in the areas the skeleton covers pass, each failure caused; the denominator stated.
- **Fail changes:** below 90% or uncaused failures: the bridge or the Rust API layer has a design fault, found and fixed before M6.
- **Acceptance:** `results/R5.md` with the classification table committed as `conformance/test-classes.json`. RF-27 then executes it.

### The M2 exit: design adjustments

`results/DESIGN-ADJUSTMENTS.md` lists every change the spikes made to this plan (packages resized, added, or removed; decisions forced), and the plan files ([ARCHITECTURE.md](../ARCHITECTURE.md), [API-MAPPING.md](../API-MAPPING.md), the milestone documents) are updated to match in the same pull request. The orchestrator tells the person in one message what changed.

## Planned stack

Six pull requests. Each spike's code stays on its spike branch unless the result says a part is kept; what lands on `main` through the stack is the result file and any code that passed review. R2 and R3 share a pull request because R3's skeleton is R2's wrapper grown (split them if the combined diff is too large to review).

| #   | Branch                                  | Pull request title                                                 | Work package |
| --- | --------------------------------------- | ------------------------------------------------------------------ | ------------ |
| 1   | `chore/spike-r1-pattern-core`           | Prove the pattern and signals core against the corpus              | RF-07        |
| 2   | `chore/spike-r9-maths-determinism`      | Check that the engine's maths agree between native and WebAssembly | RF-08        |
| 3   | `chore/spike-r2-r3-handles-and-loading` | Measure handles, closures, and loading across WebAssembly          | RF-09, RF-10 |
| 4   | `chore/spike-r4-size-and-build-time`    | Measure the WebAssembly size and build time against the budgets    | RF-11        |
| 5   | `chore/spike-r5-suite-against-bridge`   | Classify the TypeScript suite and run it against a bridge skeleton | RF-12        |
| 6   | `docs/spike-design-adjustments`         | Record what the spikes changed in the plan                         | M2 exit      |

## Documentation in this milestone

- The result files (`results/R<n>.md`) and `DESIGN-ADJUSTMENTS.md`.
- Rustdoc on every public item of the spike code that is kept (`missing_docs` stays on).
- Updates to [ARCHITECTURE.md](../ARCHITECTURE.md), [API-MAPPING.md](../API-MAPPING.md), and the milestone documents where a spike changes them.

## Agent assignments

The orchestrator assigns Sonnet agents. R1 and R9 first (R9 is small); R2 after R1's first nodes; R3 and R4 after R2; R5 after R3. At most 2 Rust-building agents at once, and R4's size builds run alone.

## Status log

| Date       | Entry                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Started: R1 (RF-07) and R9 (RF-08) assigned to two agents                                                                                                                                                                                                                                                                                 |
| 2026-11-18 | R9 (RF-08) done on `chore/spike-r9-maths-determinism`: pass with conditions; decision D-23, `libm` everywhere (C library behind `--no-default-features`); see [R9.md](../results/R9.md)                                                                                                                                                   |
| 2026-11-18 | R1 (RF-07) done on `chore/spike-r1-pattern-core`: pass with conditions. 308 of 309 layer 1 programs equal (chord and voicing not covered), 70,000 property cases pass, no closure outside the two escape hatches. Result: [R1.md](../results/R1.md)                                                                                       |
| 2026-11-18 | R2 (RF-09) done on `chore/spike-r2-handles-and-closures`: pass with conditions. 0 JavaScript calls during closure-chain queries; foreign leaf adds 3 to 8 µs but a 32-hap query is 65 to 470 µs (core speed); handles lag the collector, so opt-in `free()` and `Symbol.dispose` added; WebKit not run. Result: [R2.md](../results/R2.md) |
| 2026-11-18 | R4 (RF-11) done on `chore/spike-r4-size-and-build-time`: pass with conditions. Control 83.7 KB and worklet 75.8 KB after Brotli; clean build 9.2 s. Whole-API estimate: control 148 KB, pair 293 KB (222 KB if the worklet has no pattern core). Result: [R4.md](../results/R4.md)                                                        |
