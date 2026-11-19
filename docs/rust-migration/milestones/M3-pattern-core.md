# M3: Pattern core

## Objective

`undertone-pattern` holds the whole pattern core of 0.4.0 and `undertone-engine` resolves controls to `VoiceParams`, both written here against the corpus: constructors and transforms, controls with `ControlInput`, notes, sounds, scales, chords, voicing, signals, seeded random, and `drift`.

**Depends on:** M2's R1 and R9 results (they fix the shape of the pattern tree and the maths module). **Done when:** corpus layers 1 and 2 are green on Rust.

Every package in this milestone follows the same rule: **a behaviour lands with its corpus cases.** Add the cases to the recorder (RF-05) first, regenerate from the TypeScript reference, then make Rust pass them. Rust names follow [API-MAPPING.md](../API-MAPPING.md). Every public item gets a doc comment (the crates warn on `missing_docs`) with an example that runs as a doc test where it is cheap.

## Work packages

### RF-13. Pattern core and combinators

- **Owner:** A. **Size:** M. **Depends on:** RF-07.
- **Objective:** `undertone-pattern` holds the whole pattern core of 0.4.0: the node tree (as R1 settled it), `Fraction`, `Span`, `Hap` with `context`, `Pattern<T>`, every constructor (`pure`, `silence`, `stack`, `seq`, `cat`, `timecat`, `arrange`, `mini`), and every transform (`fast`, `slow`, `rev`, `every`, `euclid`, `jux`, `fmap`), plus the two escape hatches (`Custom` for a Rust closure, `Foreign` for a host query). R1's spike code is kept and finished here where the result says so.
- **Steps:** (1) finish the nodes R1 started; (2) `arrange` and `rev` as nodes; `every(n, f)` and `jux(f)` call `f` once at construction and store both trees, as `pattern.ts` does; (3) `fmap` with a named map (`Map(MapFn)`) for the serialisable cases and `Custom` for a closure; (4) a `Query` trait and the `Foreign(ForeignId)` node with a host callback registry (the bridge fills it in RF-25); (5) `Pattern::describe()` (print a tree) and `Hash`; (6) the property tests of [CONFORMANCE.md](../CONFORMANCE.md#query-window-independence-and-property-tests) with `proptest`; (7) `no_std` + `alloc` if R1 kept it cheap (see D-18); (8) the full mini-notation corpus group `mini` (about 200 cases, recorded from the reference, including error cases with UTF-16 positions); (9) **documentation:** rustdoc for every public item, with runnable examples.
- **Files:** `crates/undertone-pattern/src/{fraction,span,hap,pattern,node,query,combinators,mini,js}.rs`, `tests/corpus.rs`, `tests/properties.rs`.
- **Acceptance:** corpus layer 1 green for every case in groups `core`, `combinators`, `mini`; the property tests pass at 10,000 cases; `cargo doc` clean.
- **Risks:** `Fraction` overflow (`i128` against JavaScript's doubles beyond 2^53: corpus cases at the edge, Rust's behaviour documented as the truth, D-13).
- **Hand-off:** none.
- **From M2 ([DESIGN-ADJUSTMENTS.md](../results/DESIGN-ADJUSTMENTS.md)):** start from the R1 crate (`undertone-pattern`, merged with the M2 stack): `Fraction`, `Span`, `Hap`, `Pattern`, the nodes, `mini::parse`, the signals, and the `js` rules are there and pass 308 of 309 layer 1 programs. Profile `Pattern::query` natively and in WebAssembly first: R2 measured about 2 µs a hap, the largest part of a 32-hap query, and a typed fast path for small fractions is the likely fix (this does not block M3).

### RF-14. Controls, `ControlInput`, and `VoiceParams`

- **Owner:** A. **Size:** L. **Depends on:** RF-13.
- **Objective:** every control method of 0.4.0 on `Pattern<ControlMap>`, each taking a `ControlInput` (number, mini-notation string, or pattern), resolving to `VoiceParams` exactly as `resolveParams` does. `VoiceParams` is written here from `src/types.ts` and has its final name from the start.
- **Steps:** (1) `ControlInput` with `From<f64>`, `From<&str>` (parsed at the call, errors at the call), and `From<Pattern<f64>>`; (2) the `WithControl` node implementing `withControlPattern` (one control query over the span, sampled at each onset); (3) the full method list in [API-MAPPING.md](../API-MAPPING.md#controls-javascript-name-to-rust-name), generated from one table (`controls.rs`: JS name, Rust name, `VoiceParams` field, scalar-only or patternable) so the bridge and the name-map test read the same table; (4) the scalar-only controls refuse a pattern with the TypeScript's message (`fmenv`, `fmwave`, `autopanshape`, `cut`, `orbit`, `panlaw`, `channels`, `surround`, `panpath`, `pitchsteps`); (5) `VoiceParams` in `undertone-engine/src/params.rs` with every field of 0.4.0, including the eight new ones (`panPath`, `autopan`, `autopanDepth`, `autopanShape`, `autopanPhase`, `panSlideFrom`, `panSlideTime`, `panLaw`), with `#[serde(rename_all = "camelCase")]`, so the JSON form is the TypeScript's field names exactly; (6) a test that the serde names equal the field list read from `src/types.ts` at `452f782` (kept as `conformance/api/voice-params.json`); (7) **documentation:** rustdoc for every control (what it does, its range, its JavaScript name), and a check that the controls table covers every control the guide documents.
- **Files:** `crates/undertone-pattern/src/controls.rs` (methods and `ControlInput`), `crates/undertone-engine/src/params.rs` (`VoiceParams`, `resolve_params`), tests.
- **Acceptance:** corpus layer 2 (controls to resolved `VoiceParams`) green; the name-map test passes; the `VoiceParams` JSON round-trips every field name.
- **Risks:** where controls live: the method sits on `Pattern<ControlMap>` in `undertone-pattern`, but the resolution into `VoiceParams` is the engine's; keep the pattern crate free of the engine (the layering check enforces it) by making `ControlMap` the pattern crate's type and `resolve_params(&ControlMap)` the engine's.
- **Hand-off:** none.
- **From M2 ([DESIGN-ADJUSTMENTS.md](../results/DESIGN-ADJUSTMENTS.md)):** R1's control methods are `control(Control, ControlArg)` with four controls; the named methods (`gain`, `lpf`, and the rest) come from the full control table, and R4 measured that a three-export dispatcher costs the same size as 53 named exports (0.6 KB), so the bridge may generate either.

### RF-15. Notes, sounds, scales, chords, voicing, pitch

- **Owner:** A. **Size:** M. **Depends on:** RF-14.
- **Objective:** `note`, `sound`, `s` (with `.s`, `.bank`), `n` (with `.scale(spec)`, and `n` of a pattern that has events), `chord(input).voicing(options)`, the scale tables, `noteToMidi`, `noteToFrequency`, `midiToFrequency`.
- **Steps:** (1) the constructors with their leaf rules (the TypeScript's `control.ts`); (2) scale and chord tables as data, written from the TypeScript reference (`src/scale.ts`, `src/chord.ts`), never from Strudel or Tidal sources; (3) `Map(MapFn::Scale | Chord | Voicing | Transpose)` nodes; (4) `pitch` lives in the pattern crate (the engine depends on the pattern crate, not the reverse), written from `src/pitch.ts`; (5) **documentation:** rustdoc with examples for each constructor.
- **Files:** `crates/undertone-pattern/src/{constructors,scale,chord,pitch}.rs`.
- **Acceptance:** corpus groups `notes`, `scales`, `chords` green.
- **Risks:** clean-room: the tables come only from this repository's TypeScript.
- **Hand-off:** none.
- **From M2 ([DESIGN-ADJUSTMENTS.md](../results/DESIGN-ADJUSTMENTS.md)):** `notes-chord-01` is the one layer 1 program R1 does not cover (`chord()` and `voicing()`), and 7 of the 18 R5 failures in the covered files are chord and voicing tests.

### RF-16. Signals and the point sampler

- **Owner:** A. **Size:** M. **Depends on:** RF-14 (controls read signals).
- **Objective:** every signal of 0.4.0 as a built-in node (the planner's position: no `Arc<dyn Fn>` for built-ins), sampled at onsets by controls, passing through every combinator that the TypeScript's sampler passes through.
- **Steps:** (1) `SignalKind`: `Saw`, `Isaw`, `Sine`, `Cosine`, `Tri`, `Square` and the bipolar `…2` forms, `Rand`, `Rand2`, `Irand(n)`, `Choose(values)`, `Brand`, `BrandBy(p)`, `Perlin`; (2) `seed`, `segment`, `range`, `range2`, `rangex`, `add`, `sub`, `mul`, `div`, `round`, `floor` as nodes (and `std::ops` for `+ - * /`); (3) `sample(t)` on every node from one pass-through table; (4) `signal(f)` with a host function as `Custom` (Rust) or `Foreign` (JavaScript); (5) `timeRandom(seed, kind, t)` and perlin's `smootherstep` as pure functions of exact time; (6) the off-main-thread check (formerly R11): serialise a signal tree, rebuild it on another thread, query 1,000 windows, compare; (7) **documentation:** rustdoc for every signal, matching `docs/guide/signals.md`'s wording and examples.
- **Files:** `crates/undertone-pattern/src/signal.rs`, tests.
- **Acceptance:** corpus group `signals` green, including the mixed continuous and discrete compositions fixed in `5a45f43` and the negative-time case of `6deecfb`; a 1,000-window benchmark (`cargo bench` or a test with timing printed, never a CI gate) at most the TypeScript's `src/signal.bench.ts` figure on the same machine.
- **Risks:** `euclid` on a sampler-less continuous pattern makes events with no whole (a known limit in #44): copy the behaviour, it is the reference.
- **Hand-off:** none.

### RF-17. Seeded random and `drift`

- **Owner:** A. **Size:** S. **Depends on:** RF-13.
- **Objective:** `seededRandom` (mulberry32, FNV-1a for string seeds) in the pattern crate (shared with the engine, which depends on it), and `drift(pattern, options)` with its keys (`` `${seed}|${pass}|${n}/${d}|${pitch}` ``) formatted with JavaScript's number rules.
- **Files:** `crates/undertone-pattern/src/{random,drift}.rs`; `crates/undertone-engine/src/random.rs` re-exports.
- **Acceptance:** corpus groups `random` (the first 64 values of many seeds) and `drift` green.

## Planned stack

Five pull requests, one work package each.

| #   | Branch                           | Pull request title                                     | Work package |
| --- | -------------------------------- | ------------------------------------------------------ | ------------ |
| 1   | `feat/pattern-core`              | Add the pattern core and combinators in Rust           | RF-13        |
| 2   | `feat/controls-and-voice-params` | Add controls and resolve them to `VoiceParams` in Rust | RF-14        |
| 3   | `feat/notes-scales-chords`       | Add notes, sounds, scales, chords, and voicing in Rust | RF-15        |
| 4   | `feat/signals`                   | Add signals and the point sampler in Rust              | RF-16        |
| 5   | `feat/seeded-random-and-drift`   | Add seeded random and drift in Rust                    | RF-17        |

The branch `feat/signals` was used by the TypeScript work (#44) and was deleted on merge; pick a different name if it still exists on the remote (for example `feat/rust-signals`).

## Documentation in this milestone

- Rustdoc with runnable doc tests for every public item of `undertone-pattern` and the `VoiceParams` part of `undertone-engine`; `cargo doc` with `-D warnings` in CI.
- Update the status of each group in [API-MAPPING.md](../API-MAPPING.md) in the pull request that finishes it.
- Update [CONFORMANCE.md](../CONFORMANCE.md)'s group table where case counts change.
- The Rust guide section itself is written in M5, when the facade exists; this milestone keeps the rustdoc complete so the guide can link to it.

## Agent assignments

The orchestrator assigns Sonnet agents. RF-13 first; RF-14 after it; RF-15, RF-16, and RF-17 in parallel once their dependencies are in (at most 2 Rust-building agents at once).

## Status log

| Date       | Entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-11-19 | RF-13 done on `feat/pattern-core` (not pushed): fraction fast path and in-place queries cut a hap from about 980 ns to about 125 ns natively (a 32-hap `seq` query from 31 us to 4 us); `Query`, `Foreign` with a host registry, `fmap`, `jux(f)`, `describe`; the corpus runner finds groups itself. Layer 1: `core` 44, `combinators` 60, `mini` 359, `scales` 130, `controls` 58, `signals` 104 equal, `notes` 42 of 43; `chords`, `drift`, `random` not covered (RF-15, RF-17) |
