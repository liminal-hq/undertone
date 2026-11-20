# M6 boundary: how the Rust API crosses into JavaScript

The conventions for every export of `crates/undertone-wasm` (RF-24, both pull requests) and for the TypeScript bridge that wraps it (`packages/undertone`, RF-25). Part 1 of RF-24 wrote this file before the bulk of its code and keeps it current; part 2 (the controls, chords, scales, drift, instruments, samples, engine, render, WAV, score, and scheduler) follows it, and changes it in the same commit when a rule has to move.

Every decision below names the measurement or the earlier result behind it. "Measured" figures come from this machine (AMD Ryzen 7 7700X, Linux 7.2.9), Node 22.21.1, Bun 1.4.4, Rust 1.98.0, `wasm-bindgen` 0.2.125, unless a row says otherwise. KB is 1,000 bytes, as in R4.

**Status: pending measurement** marks a rule whose number is still to be taken in part 1; it is replaced by the number in the commit that takes it.

## 1. Handles

- **One exported struct per Rust type that JavaScript holds.** `WasmPattern` wraps `Pattern<Value>`; part 2 adds `WasmEngine`, `WasmPlayer`, and so on, each named `Wasm` plus the Rust type. The JavaScript class names are the same (`WasmPattern`), never the bridge's public names, so the generated glue (`undertone_wasm.js`) and the wrapper (`packages/undertone/src/`) cannot be confused: the wrapper's `Pattern` holds a `WasmPattern` in a private field.
- **Every method returns a new handle,** as every TypeScript method returns a new `Pattern`. A method never mutates its receiver; the receiver is always borrowed (`&self`), so a handle can be used again after any call.
- **Freeing:** `wasm-bindgen --weak-refs` registers every handle with a `FinalizationRegistry`, so the garbage collector frees it eventually (R2: late, because the collector cannot see WebAssembly memory). `free()` frees it at once and is safe to call twice (wasm-bindgen zeroes the pointer on the first call; the second is a no-op). The wrapper's `free()` and `[Symbol.dispose]()` (RF-25) call it. A method called on a freed handle throws `Error: null pointer passed to rust` (wasm-bindgen's own message, not ours; the wrapper may catch it and say "this pattern was freed").
- **Lists are built with borrowing `push` calls, never as an array of handles.** wasm-bindgen moves an exported struct out of a JavaScript array (`Vec<WasmPattern>`) and nulls the JavaScript object (R5). So `seq`, `cat`, `stack`, `timecat`, and `arrange` take a `PatternList`: `new PatternList()`, then `push(handle)` or `pushWeighted(weight, handle)` per item (each borrows and clones the tree's `Arc`), then `seq(list)` and the others borrow the list. The list is reusable and the wrapper frees it straight after the call. `choose(...values)` takes plain values, not handles, so it takes an array (no exported struct is inside it; see section 3 for what a value may be).
- **No generics cross.** Every export is monomorphic (`Pattern<Value>`); `Pattern<f64>` and `Pattern<bool>` never cross.

## 2. JavaScript functions

There are three kinds, and each has one rule.

- **Called once, at construction:** `every(n, fn)`, `jux(fn)`, and the leaf rule of `mini(source, leaf)`. Rust runs the function during the call that builds the pattern, and the tree keeps only the result (the closure-at-construction rule of the pattern crate). For `every` and `jux` the wrapper passes a **thunk** that takes no argument, calls the user's function with the wrapper's own receiver (`() => fn(this).handle.clone()`, so `fn` sees the same `Pattern` object as in `pattern.ts`), and returns a fresh handle that Rust takes ownership of (a clone made for the purpose, so nothing the user holds is nulled). Rust calls the thunk from inside the pattern crate's own `every` or `jux`, so the order of checks is the reference's: `every(0, fn)` fails with the cycle-count message before `fn` runs. An exception thrown by the user's function is rethrown unchanged (same object, same class), after the pattern crate returns.
- **Called during every query: the foreign leaves.** `new Pattern(query, sampler?)`, `fmap(fn)`, and `signal(fn)` become a `Node::Foreign` leaf. The host is `JsLeaf`, one per leaf, holding only its `ForeignId` (a `u32`), so it is `Send + Sync` without `unsafe`: the JavaScript functions themselves live in a thread-local table in the bridge (`foreign.rs`), keyed by the id. When the last tree holding the leaf is dropped, `JsLeaf`'s `Drop` removes the table entry, which releases the functions. On any other thread the table is empty, so the leaf is silence there, and `Pattern::serialize` refuses the tree with an error naming the foreign node (RF-16), which is the diagnostic the worklet backend reports (D-40, B4 and B5).
  - `new Pattern(query, sampler?)`: Rust calls `query(beginN, beginD, endN, endD)`; the wrapper builds the `TimeSpan`, calls the user's query, and returns the haps in the encoding of section 3 (`[Float64Array, values]`). The sampler is `sample(n, d)` returning the value or `undefined`, and it is carried (R5: a sampler lost on a derived pattern failed about 20 tests).
  - `fmap(fn)`: the leaf holds the child pattern and one function. Rust queries the child, then calls the function **once per query** with the array of the haps' values, and expects the array of mapped values back (the wrapper passes `(values) => values.map(fn)`), so a query crosses the boundary once, not once per hap. A child with a sampler keeps it: a sample calls the same function with a one-element array.
  - `signal(fn)`: Rust calls `fn(t)` with the cycle time as a number, as `continuous` does in `signal.ts` (a query returns one hap with no whole and the value at the span's begin; the sampler is `fn(t)`).
  - **A function that throws during a query:** the leaf records the exception and answers nothing; when the query returns to the export, the export rethrows the first recorded exception unchanged. So an exception in a user's query or map reaches the caller of `.query`, as in the reference. A query inside the callback (a JavaScript query that queries another pattern) is allowed: the table is never borrowed while a callback runs.
- **Never stored as a closure in Rust.** No export takes a JavaScript function into a `Custom` node; a `Custom` node is Rust-only.

## 3. Query results

**Status: pending measurement** (the choice of encoding, from a 1,000-hap query in Node and Bun).

The candidate encodings:

- **Flat:** `query` returns `[times, values, big]`: `times` is a `Float64Array` of nine numbers per hap (part begin n, d, part end n, d, whole begin n, d, whole end n, d, value index), `values` an array of the values (by index), and `big` an array of fraction texts or `undefined`.
- **Objects:** an array of plain `{ whole?, part, value }` objects through `serde-wasm-bindgen`, with fractions as `{ n, d }`.

Rules that hold for either:

- **Fractions cross as two numbers when both fit a JavaScript safe integer** (|x| ≤ 2^53 − 1), which is every fraction of every corpus case. A fraction that does not fit (B3, D-13: Rust's `i128` goes beyond 2^53) crosses as its exact text `n/d`: in the flat encoding its numerator slot is `NaN` and its denominator slot is the index of the text in `big`. A text, not a `BigInt`, because it costs no `BigInt` glue and the wrapper parses it with `BigInt(...)` only in that rare case; a numerator is never `NaN` otherwise, so the marker is unambiguous. A hap with no `whole` has `0` in the whole's denominator slots (a denominator is never 0).
- **Spans go in the same way:** `query(beginN, beginD, endN, endD)` takes four numbers, each an integer within the safe range and a denominator that is not 0, or it throws; `queryRatio(begin, end)` takes two texts (`"1/3"`, `"4"`) for the tail. `sampleAt(n, d)` and `sampleAtRatio(text)` likewise.
- **Values** (`Value`: number, string, boolean, map, list, `undefined`) leave Rust through `serde-wasm-bindgen` (`Serializer::json_compatible()`: maps become plain objects), and come in through a hand-written conversion (`convert.rs`), not `serde-wasm-bindgen`'s deserialiser, because its `deserialize_any` reads every safe integer as an `i64` and so turns `-0` into `0` (checked in its source, 0.6.5, `de.rs`).
  - **Numbers** cross as JavaScript numbers in both directions, bit for bit: `NaN`, `Infinity`, `-Infinity`, and `-0` keep their identity.
  - **`undefined`** is `Value::Undefined` both ways; a map field set to `undefined` is a key present with the value `undefined`, as `{ ...defaults, soundType: undefined }` makes it.
  - **`null`** has no `Value`, and **class instances, functions, symbols, and `BigInt`s** cannot be held either: putting one into a pattern (`pure(null)`, `choose(new Fraction(1, 2))`, a leaf rule or a map returning one) throws `Error: a pattern value must be a number, a string, a boolean, undefined, an array, or a plain object, got <String(value)>`. Plain objects are those whose prototype is `Object.prototype` or `null`. This is narrower than the reference, which holds any JavaScript value; it is listed for D-06 under "Decisions for review".
  - **Object identity:** every hap of a query has its own value object (B9). Two haps never share one, even when the reference's `pure(object)` would give the same object to both.

## 4. Errors and panics

- **A Rust error becomes a thrown JavaScript `Error` whose `message` is the Rust message word for word** (`js_sys::Error::new(message)`), so the corpus's recorded messages compare equal (B10, D-40). The class stays `Error`: no subclass, no `name` change, no extra fields.
- **A JavaScript exception from a user's function passes through unchanged** (section 2), so its class and fields survive.
- **Validation that the reference does in JavaScript stays in JavaScript** (R5): `add() needs a number or a pattern of numbers` is the wrapper's, because only the wrapper can tell a `Pattern` from anything else. The export takes the two shapes as two methods (`arith(op, number)` and `arithPattern(op, handle)`).
- **No panic is meant to cross the boundary,** and the exports are written so that none can on any input JavaScript can give: numbers are checked before they become fractions, the foreign table is borrowed with `try_borrow` and never across a callback, and nothing calls `unwrap` on a value JavaScript chose.
- **If one does happen, the instance is dead.** The module is built with `panic = "abort"` (R4's profile; it is also the only panic strategy `wasm32-unknown-unknown` supports on stable Rust), so a panic is a WebAssembly trap: the call throws `RuntimeError: unreachable` and no Rust destructor runs. The linear memory can be left mid-update (a `RefCell` borrowed, a list half built), so the wrapper must treat that instance as unusable; the remedy is a new instance (a page reload, or RF-25's `./init` path). There is no panic hook: `console_error_panic_hook` would add an import and the panic message's formatting for a case that is a bug by definition. One known way to reach a panic remains: the pattern crate's `Fraction` panics on `i128` overflow (`Fraction overflow`), so a pattern whose times outgrow `i128` (for example `fast` by 2^53 three times over, then a query) traps. In 0.3 such a pattern silently lost precision instead. A checked query in the pattern crate (returning an error) would close it; it is not part of RF-24.

## 5. Naming

- **JavaScript names are camelCase through `js_name`, matching `src/index.ts`** wherever an export carries a reference name: `midiToFrequency`, `noteToMidi`, `noteToFrequency`, `seededRandom`'s generator, `brandBy`, `sampleAt`, `hasSampler`. A Rust method name that is already one word keeps it (`fast`, `rev`, `euclid`).
- **An export the wrapper uses but the reference does not have** is named for what it does, in camelCase: `queryRatio`, `sampleAtRatio`, `arithPattern`, `pushWeighted`, `signalNamed`, `controlTable`.
- **The signals are one export, `signalNamed(name)`,** over the pattern crate's `signal::by_name` (the names are the reference's: `sine`, `saw2`, `rand`, `perlin`, `brand`, and the rest). The wrapper builds its constants (`export const sine = ...`) from it once at load. Twenty separate exports would cost glue for no gain.
- **Rust names** follow the crate's: `WasmPattern::every`, `foreign.rs`, `encode.rs`.

## 6. The controls table

The wrapper (RF-25) generates its control methods from the table instead of writing 53 by hand, and the bridge has one dispatcher.

- **`controlTable()`** (part 1) returns `undertone_pattern::CONTROLS` as an array of plain `ControlRow` objects: `jsName`, `rustName`, `fields` (the `VoiceParams` JSON names), `arg` (the argument kind: `patternable`, `patternableWithTime`, `integer`, `number`, `choice`, `text`, `numberList`, `path`), `scalarOnly`, `messageName`, `choices`, `range`, and `summary`. The wrapper reads it once at load and installs one method per row on `Pattern.prototype`; the TypeScript declarations for those methods stay hand-written (the API report checks them, RF-06), and a test in RF-25 checks the generated set against them.
- **`control(name, input)` and the per-kind methods are part 2.** One patternable dispatcher (`control(name, number | string)` and `controlPattern(name, handle)`, the two shapes because a handle cannot be read out of an untyped value, section 1), plus a method each for the argument kinds that are not patternable (`panpath`, `pitchsteps`, `channels`, and the rest), as the pattern crate's `Pattern::control` and its hand-written methods are.
- **Why a table and a dispatcher, not 53 exports:** R4 measured the two: the 53 named exports cost 614 bytes more after Brotli in the module and 32 KB more of unminified glue (606 bytes after Brotli), and the table cannot drift from the generated methods. Not re-measured here; part 2 measures the real dispatcher.

## 7. Typings

- **Hand-written `.d.ts` for the handle classes** and for everything the wrapper alone sees (D-11): the wasm-bindgen glue already writes a `.d.ts` for every export (`undertone_wasm.d.ts`), with the argument and return types of the Rust signatures, and the wrapper's public types are the 0.4.0 ones, written by hand and checked by the API report.
- **`ts-rs` for the data types that cross as plain objects** (D-11). ts-rs 12.0.1 (MIT; `cargo deny` passes) is a **dev-dependency only**: the types derive `TS` under `#[cfg(test)]`, a unit test renders each declaration and compares it with the committed file under `crates/undertone-wasm/bindings/` (run with `UNDERTONE_UPDATE_BINDINGS=1` to rewrite them), and RF-25 copies or imports them. So ts-rs adds nothing to the module. Part 1's one data type is `ControlRow`; part 2 adds `VoiceParams`, `ScoreEvent`, `RenderOptions`, `PlayOptions`, and the other option bags. `tsify` was not taken: it would put its derive and `wasm-bindgen` attributes into the build of the module itself.
- **The value type** (`Value`) is not generated: in TypeScript it is the reference's `unknown` (a hap's value) or `ControlPatch`, already declared.

## 8. Testing and diagnostics hooks (part 2 and RF-25)

D-28 ships `@liminal-hq/undertone/testing` with `resetWarnings`, `seedContext`, and `playVoice`/`playVoices`. What the Rust side must give it, none of which exists in part 1:

- **`resetWarnings()`** clears the once-only set of every warning the bridge has given. The engine keeps its warnings per `Engine` (`Engine::warnings`, `undertone-engine/src/warn.rs`) where the reference keeps one set per process, so the bridge needs one process-wide once-set over all its engines, and an export to clear it. **A gap to close in part 2:** the reference also warns when a pattern gives a control a bad value (`undertone: pan() got NaN from a pattern; left unset.`, `sanitiseControl` in `pattern.ts`), and the pattern crate's sanitising is silent (`controls.rs`, module documentation: "that stays with the host"). 165 tests in `controlSignals.test.ts` assert on those warnings, so part 2 needs a way for a query to report them (for example a warning sink the pattern crate calls, or the bridge rechecking each control's value after a query).
- **`seedContext(ctx, seed)`** seeds the noise and impulse-response randomness of one context. The bridge needs an export on its engine that sets that seed (the engine's random sources are `undertone-engine/src/random.rs`).
- **`playVoice(ctx, params, options)` and `playVoices`** become calls of `playParams` with a resolved `VoiceParams` (R5); the Rust side needs `Engine::play_params` exported with `VoiceParams` crossing as a plain object.
- **Diagnostics part 1 already has:** `liveHandles()` (handles alive now: made minus dropped) and `memoryBytes()` (the linear memory's size), used by the smoke test's memory check and available to RF-25's million-handle test. They are not part of the public API.

## 9. Build, size, and CI

- **Profile `wasm`** in the root `Cargo.toml` inherits `release` and sets `opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, and `strip = true`: R4's profile (R4 measured `"s"` 5% larger after Brotli than `"z"`). The `release` profile the native crates use is unchanged.
- **`scripts/build-wasm.sh`** checks that `wasm-bindgen --version` equals the crate's pin (and prints the install command if not), builds `--target wasm32-unknown-unknown --profile wasm -p undertone-wasm`, runs `wasm-bindgen --target web --weak-refs` into `packages/undertone/wasm/`, runs `wasm-opt -Oz -all` from the `binaryen` npm package (installed by `scripts/wasm-opt/`, see below), and prints the raw and Brotli sizes.
- **`scripts/check-wasm-size.ts`** (Bun) fails when the control module is over 150 KB after Brotli and warns over 90% (D-07), and writes the figures to the step summary.
- **`wasm-opt`:** `scripts/wasm-opt/package.json` pins `binaryen` 132.0.0 and its `bun.lock` carries the package's integrity hash, so `bun install --frozen-lockfile --cwd scripts/wasm-opt` installs exactly that build, outside the root package (the root `package.json` gains no dependency). It runs under Bun or Node.
- **CI:** the `wasm-bridge` job (section 10 of the report: commands and time).

## 10. Exports in part 1, by group

**Status: pending** (filled in with the final list when the exports are in).

## 11. Decisions for review

**Status: pending.**
