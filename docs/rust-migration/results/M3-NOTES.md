# M3 notes: what the pattern core taught us

M3 built `undertone-pattern` and the `VoiceParams` half of `undertone-engine` against the corpus. Layer 1 and layer 2 are fully covered on Rust, with nothing left in either runner's not-covered list. This file collects what changed in the plan, what the bridge and the later milestones must know, and what was not shown.

## Where it stands

| Corpus     | Result                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Layer 1    | `core` 44/44, `combinators` 60/60, `mini` 359/359, `scales` 130/130, `chords` 123/123, `controls` 58/58, `signals` 104/104, `notes` 43/43, `random` 103/103, `drift` 97/97; the float tolerance is needed only by three `signals` programs |
| Layer 2    | `controls` 58/58 (410 resolved objects), `notes` 43/43, `signals` 20/20, `chords` 71/71, `drift` 81/81; the 879 resolved `VoiceParams` objects round-trip                                                                                  |
| Properties | seven properties at 10,000 cases on `main` (1,000 on pull requests), no failures                                                                                                                                                           |
| Builds     | `wasm32-unknown-unknown`, `thumbv7em-none-eabi` (`no_std + alloc`), ARM64 tests, FreeBSD `cargo check`                                                                                                                                     |

## What changed

- **Queries are about eight times faster** (a 32-hap `seq` from 31 µs to 4 µs natively): four fifths of the time was `i128` gcd on every fraction operation, so operations below 2^31 use `i64` with a binary gcd, general arithmetic stays checked `i128` (it panics on overflow, never wraps), and a query appends into one vector. R2's figure for WebAssembly (about 2 µs a hap) was not re-measured.
- **`pow` is correctly rounded (D-25).** One bit of a pitch changes a `drift` random stream, so `libm`'s one-unit error was not tolerable. This is a refinement of D-23 and a finding for R9: the engine's own `pow` calls (pitch ratios in the voice graph) should use the same function in M4.
- **One controls table** (`CONTROLS` in `controls.rs`) drives the `Control` enum, the 39 generated methods, the dynamic `Pattern::control` dispatcher, the rustdoc, and the name-map test; 14 controls are hand-written under the same table. The bridge reads the same table (R4: a three-export dispatcher costs the same size as 53 named exports).
- **`Value`, `ControlMap`, `Hap`:** `Value` gained `List` and `Undefined` (`.s("bd")` sets `soundType` to `undefined` on purpose); `ControlMap` is an alias for `Value`; the node-side `ControlInput<T>` became `ControlSource<T>`. `Hap` has no `context` because the reference has none.
- **Pattern trees can cross a thread.** `Pattern::serialize` writes a deterministic text form (`ut1`, `no_std + alloc`, no serde); a tree holding a `Custom` closure or a `Foreign` host callback is refused. 120 signals trees and 217 chords, drift, and notes trees were rebuilt on another thread and answered about 5.6 million haps identically. This answers RF-29's question for the worklet: it can query patterns when the tree has no foreign leaf.
- **Fallible patterns:** a bad `voicing` anchor fails only when a chord is voiced, so `Pattern::try_query` carries the error through the combinators and `query` leaves the failing event out.

## For the bridge (RF-24 and RF-25)

- The drift options in the reference accept any JavaScript value (the corpus holds `null` and strings such as `'2'` and `'x'` in error messages), so the bridge coerces them the same way before building a typed `DriftOptions`; a missing seed is the word `undefined`.
- A string with a lone surrogate cannot cross a `wasm-bindgen` boundary (`DriftOptions::seed_utf16` exists for the one corpus case that needs it), and a Rust `String` cannot hold the lone surrogate in a mini-notation emoji error message, so `Error::message` shows U+FFFD with the exact position.
- The reference's once-only warnings for bad pattern values stay with the host: the Rust crate prints nothing.
- Lists are built with borrowing `push` calls, never as arrays of handles (R5), and `Foreign` is the registry the bridge fills (`ForeignHost`, with `ForeignTable` behind the `std` feature).
- A chord quality named after an `Object.prototype` property (`Cconstructor`, `C__proto__`) gives a JavaScript `TypeError` in the reference; Rust reports the unknown-quality error, and no corpus case covers it.

## For the site (M8)

The guide lists all 53 controls in prose, but 17 of them never appear in a code example: `autopanphase`, `autopanshape`, `bank`, `channels`, `cut`, `duration`, `early`, `fmattack`, `fmenv`, `fmi`, `fmrelease`, `hpf`, `late`, `legato`, `pattack`, `phaser`, and `pitchsteps`. The reference's mini-notation also has less than the guide might suggest: no `?`, no `_` or `.` elongation, and no patterned euclid arguments.

## What was not shown

- **Nothing was listened to.** Every figure is a number or a recorded value.
- **The WebAssembly speed-up** from the fraction fast path was not measured, and the signal benchmark was not re-run after the stack was assembled.
- **The corpus is one machine's recording** (Bun on JavaScriptCore); the ARM64 and FreeBSD jobs are the first checks on other platforms, and the rest of the CI matrix (Apple silicon, Windows) is planned for M7 and M8.
- **Gaps in the reference's own behaviour** that the corpus drops: engine-specific error text and type coercions such as `anchor: null` were left out of the corpus on purpose.
