---
title: 'Rust: Signals'
---

# Rust: Signals

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Signals](/guide/signals) page. Continuous patterns, read at the onset of each event: ranges, arithmetic, randomness, and custom signals.

## What differs from the TypeScript

- **Each signal is a function.** `sine()`, `saw2()`, and `rand()` are called, because a pattern is built by a call; they live in `undertone::signals`.
- **They return a `Pattern<Value>`**, which works for a control and for `n()`.
- **Randomness is deterministic**: each value is a pure function of the seed, the kind, and the exact time.
- **Reading a signal never fails**: a pan past 1 is clamped.

## The example

The whole of `crates/undertone/examples/signals.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example signals` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/signals.rs

<RustAudio example="signals" />

Segment a signal with `segment(n)` to give it a rhythm, or hand it to a control, which reads it at each onset.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
