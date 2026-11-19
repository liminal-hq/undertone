# Design adjustments from the M2 spikes

Six spikes retired the risks that decide the design. None blocked the plan; each changed something. This file collects the changes, the decisions they forced, and the work packages they touch. The plan files were updated in the same pull request.

## The verdicts

| Spike | Work package | Verdict                            | One line                                                                                                                                                                                     |
| ----- | ------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1    | RF-07        | Pass with conditions               | The node-tree pattern core reproduces 308 of 309 layer 1 programs (303 exactly, 5 within one unit in the last place), with no closure outside the two escape hatches; chords are the one gap |
| R9    | RF-08        | Pass with conditions               | Native and WebAssembly maths agree to one unit in the last place; decision D-23 puts `libm` everywhere                                                                                       |
| R2    | RF-09        | Pass with conditions               | Closure chains make no calls into JavaScript at query time; handles need an opt-in `free()` and `[Symbol.dispose]()` because the collector cannot see WebAssembly memory                     |
| R3    | RF-10        | Pass as written, marginal for D-17 | A WebAssembly-backed package works after a plain `import` everywhere, except at Vite 5's default build target; D-17 decided                                                                  |
| R4    | RF-11        | Pass with conditions               | 84 KB control and 76 KB worklet after Brotli, a lower bound; the whole API extrapolates to about 148 KB for the control module; D-07 decided                                                 |
| R5    | RF-12        | Pass with conditions               | The suite (813 tests, not 753) is classified; the thin binding passes 174 of 192 public-API tests in the covered area (90.6%)                                                                |

## Decisions made

- **D-23: `libm` everywhere (R9).** The engine and the pattern crate use the pure-Rust `libm` by default on every target, so the same numbers come out on any CPU and C library. Consequences: layer 1 and 2 floats compare within 1e-14 relative (1e-15 absolute near zero), layer 3 maths compares at nine digits with a 1e-15 floor, `undertone-pattern` builds `no_std + alloc` (D-18 holds), and CI runs the Rust tests on ARM64 and checks the build for FreeBSD.
- **D-17: top-level `await` with a `./init` escape hatch (R3).**
- **D-07: 150 KB and 200 KB per module (R4),** with the combined limit conditional on whether the worklet carries the pattern core.
- **D-24, open, with a default: a `@liminal-hq/undertone/testing` entry (R5).**

## Changes to work packages

| Package | Change                                                                                                                                                                                                                                                                                | From       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| RF-13   | Start from the R1 crate. Profile `Pattern::query` natively and in WebAssembly first (about 2 µs a hap is the largest part of a 32-hap query); a typed fast path for small fractions is the likely fix                                                                                 | R1, R2     |
| RF-14   | Control methods are `control(Control, ControlArg)` today; the full table generates the named ones. A three-export dispatcher is as cheap as 53 named exports (0.6 KB), so the bridge may use either                                                                                   | R1, R4     |
| RF-15   | `chord()` and `voicing()` are the one uncovered layer 1 program and 7 of the 18 R5 failures                                                                                                                                                                                           | R1, R5     |
| RF-24   | Lists are built with borrowing `push` calls, never arrays of handles; `new Pattern(query, sample)` carries its sampler; build with `wasm-opt -Oz -all` (add `binaryen` to the CI job's tools, D-22); budgets per D-07 as failing checks; `serde_json` stays out of the control module | R4, R5     |
| RF-25   | `free()` and `[Symbol.dispose]()` on the wrapper `Pattern`, with a million-handle test; the entry shape of D-17 (`.` with top-level `await`, `./init`, a synchronous `node` condition, a `build.target` install note for Vite 5); validation messages stay in TypeScript              | R2, R3, R5 |
| RF-26   | Replay sends flat operation records, not objects, and the Rust booking calls Web Audio in the TypeScript engine's order so node numbering matches                                                                                                                                     | R3         |
| RF-27   | Not "change only the import": 330 tests alias, 395 need a named translation, 52 internal tests become Rust unit tests, 21 run on the Web Audio backend, 15 stay TypeScript. The classification is `conformance/test-classes.json`, checked in CI                                      | R5         |
| RF-29   | Decide before RF-24 fixes the combined budget whether the worklet queries patterns or only plays booked voices (about 70 KB)                                                                                                                                                          | R4         |

## Corrections to the plan's facts

- **The suite is 813 tests in 31 files,** not 753 (29 `src` files, the recorder's property tests, and the playground's `importScript.test.ts`).
- **JavaScriptCore computes `x ** -0.5` as `1 / sqrt(x)`,** so `2 ** -0.5` is `0.7071067811865475` there and `…476` in glibc; `undertone-pattern`'s `js::pow` copies the rule (R1).
- **The spikes ran on Node 22.21.1, Bun 1.4.4, and Deno 2.9.8,** not the Node 20 and Bun 1.2 minimums, and WebKit could not run on this machine (missing system libraries). RF-25 and RF-27 should run the minimums in CI.
- **The stack order differs from the plan's table:** R2 and R3 are separate pull requests, and the size spike (R4) sits between them.

## Shared-image requests

`liminal-hq/.github` #52 (a wasm-capable tier, now also asking for `wasm-opt` and `brotli`) and #53 (what `ci-rust` contains).

## What the spikes did not show

- **Nothing was listened to.** Every figure is a number or a recorded graph.
- **Platforms:** every measurement came from one AMD x86-64 machine; the ARM64 job (green) and the FreeBSD build check are the first checks on others. WebKit and Safari were never run.
- **Sizes are a lower bound,** because the voice graph, chords, and 49 of the 53 controls are not in Rust yet.
- **Lazy instantiation** (D-17's fourth option) was not built.
