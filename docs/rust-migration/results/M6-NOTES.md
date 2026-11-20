# M6 notes: what the bridge taught us

M6 built `@liminal-hq/undertone` as a TypeScript bridge over two WebAssembly modules built from the Rust, and ran the TypeScript suite and the corpus against it. Nothing was listened to: every figure here comes from recorded node graphs, rendered numbers, byte comparisons, or sizes. The stack is held unmerged until the person's go.

## What was built, per pull request

The stack is #99, #103, #100, #105, #107, #109, and #111, in that order.

| PR   | Branch                        | What it delivered                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #98  | (before the stack)            | Renamed the root package so the bridge can take the public name `@liminal-hq/undertone`                                                                                                                                                                                                     |
| #99  | `feat/wasm-control-bindings`  | RF-24 part 1: `crates/undertone-wasm`, the boundary rules ([M6-BOUNDARY.md](M6-BOUNDARY.md)), groups 1 to 6, 9, 16, and 18, the controls table, the build script, the size check, and the `wasm-bridge` CI job                                                                              |
| #103 | `feat/wasm-controls-bindings` | RF-24 part 2a: groups 7, 8, 10 to 14, 17, the data half of 15, and the reference's control warnings printed once per key; corpus layers 1 and 2 through the module                                                                                                                          |
| #100 | `feat/bridge-package`         | RF-25a and RF-25b: `packages/undertone` as a workspace member, the loading entries of D-17, `Fraction`, `Pattern` over a handle, the 56 control methods generated from the controls table, `note`, `sound`, `chord`, `drift`, `score`, the instruments, the API diff, and the ported suites |
| #105 | `feat/wasm-engine-bindings`   | RF-24 part 2b: the second module (`crates/undertone-wasm-render`, loaded lazily), the engine's booking on a recorder of fixed-width records, the scheduler exports, the sample registry, and numbers printed and parsed by JavaScript (D-43)                                                |
| #107 | `feat/bridge-engine`          | RF-25c and RF-26: the Web Audio replayer, `play`, `loop`, `render`, `renderToBuffer`, the samples, the master bus and effects, TypeDoc over the package, and the ported engine, scheduler, render, WAV, and sample suites with corpus layers 3 and 4 and WAV                                |
| #109 | `feat/bridge-followups`       | RF-25d: `encodeWav` in TypeScript, decoding a sample when a voice first names it, and the onset-order break B11 (the three decisions of [M6-BOUNDARY.md](M6-BOUNDARY.md) section 15)                                                                                                        |
| #111 | `fix/bridge-review-findings`  | The six findings of the review of the whole stack, each reproduced with a failing test first                                                                                                                                                                                                |

RF-27 (the suite and the corpus on the bridge) was delivered inside #100, #107, and #109 rather than as a pull request of its own: the tests were ported as each export landed.

## Where it stands

| Check                                    | Result                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpus layer 1 through the modules       | 1,121 of 1,121 equal                                                                                                                                  |
| Corpus layer 2                           | 335 of 335 equal                                                                                                                                      |
| Corpus layer 3 (replayed)                | 337 of 337 equal (11 only within the 1e-15 floor, the same 11 as in Rust)                                                                             |
| Corpus layer 4                           | 20 of 20 within the tolerances                                                                                                                        |
| WAV                                      | 34 of 34 byte for byte                                                                                                                                |
| Booking checks against the reference     | 11 checks                                                                                                                                             |
| Negative controls                        | A setpoint moved by 1e-9 fails 305 of the 337 layer 3 cases; a render 10% quieter fails all 20 layer 4 cases; a moved first sample fails 28 of 34 WAV |
| Package API diff (`bun run package:api`) | 381 present, 0 pending, 0 missing, 0 different                                                                                                        |
| Package tests                            | 798                                                                                                                                                   |
| Root tests                               | 1,790                                                                                                                                                 |
| Rust                                     | 623 tests                                                                                                                                             |

| Size after Brotli 11 | Measured | Limit                                        |
| -------------------- | -------- | -------------------------------------------- |
| Main module          | 148.3 KB | Budget 150 KB; 13 KB over the 135 KB warning |
| Render module        | 97.3 KB  | Budget 120 KB; warning at 108 KB             |
| Main glue            | 14.4 KB  |                                              |
| Render glue          | 5.5 KB   |                                              |

## What changed or was found

- **One module did not fit, so there are two (D-43).** Part 2a left 22.9 KB under the budget for the engine, booking, rendering, and the scheduler. The rendering went into a lazily loaded module, and printing and parsing numbers in JavaScript saved 22.6 KB.
- **A raw C-ABI render module would save about 17 KB and was refused (D-45):** 72.9 KB with no glue against 84.4 KB plus 5.5 KB of glue, and it needs `unsafe`.
- **There is an eleventh break (D-44).** B11 is the onset order of stacked voices: the Rust scheduler books by onset, where 0.3 booked layer by layer; start times and sound are unchanged.
- **The engine records, the wrapper replays.** The engine records Web Audio calls as fixed-width numeric records and the wrapper replays them on the caller's context, so the recorded graph on the fake context equals the reference's and a context missing optional factories degrades with the same warnings.
- **The review of the whole stack found six real defects, all fixed in #111:** a sparse JavaScript array of length 0xffffffff reached `Vec::with_capacity` and stopped the instance (arrays are now limited to 4,194,304 items and reserve at most 1,024 first); a Web Audio call that threw mid-batch dropped the rest of its records (the replayer now applies every record that does not name what the context failed to make, then rethrows the first error); a sample registered again under a name kept its old PCM, and decoded PCM was not kept per registration and per context with its own sample rate; a voice's own periodic waves (autopan phases) were never released; and a failed `init()` was cached. Each has a test that failed first.
- **`sideEffects` had to list the entries,** because `false` made Vite drop the module's initialisation.

## Decisions made in M6

D-40 to D-42 at the start (the ten breaks, the bridge CI job, the minimum runtimes), and D-43 to D-46 at the end (two modules, the extra breaks and B11, no `unsafe` render module, and the TypeScript WAV encoder with on-demand sample decoding and an unminified wrapper), in [DECISIONS.md](../DECISIONS.md).

## What was NOT verified

- **Nothing was listened to.** The tests assert the Web Audio node graph, automation timing, byte equality, and rendered numbers, not perceived sound.
- **No real browser and no real `AudioContext` ran the package.** Everything ran against the hand-written fake context, or under Node, Bun, and Deno.
- **The Vite 5 bundles run only under Node with stand-ins,** not in a browser.
- **The CI and Pages changes have not run on a runner** until the stack is pushed and green.

## Known differences kept

- **A sample decoded on one context plays on every context.** The registry is one per module instance. Decoding is still per context, and a `url` or `data` sample is decoded when a voice first names it, as in 0.3.
- The other differences are the breaks in the [package changelog](../../../packages/undertone/CHANGELOG.md): B1 to B11 and the odd-input list accepted in D-44.

## Risks carried to M7

- **The AudioWorklet reuses the render module** by passing a compiled `WebAssembly.Module` to the worklet, which makes the instance there.
- **Avoid `TextDecoder` in the worklet.**
- **The zero-allocation booking tick is still deferred (D-34).**

## Follow-ups

- **`liminal-hq/.github#52`:** a wasm tier in the shared CI images; the bridge job installs its tools until then (D-41).
- **`liminal-hq/.github#54`:** `libasound` for the docs audio render.
- **Example gain staging in the Layered tune** is deferred by the person until after the port: the live examples are loud because of the examples' own gains, not an engine regression.
