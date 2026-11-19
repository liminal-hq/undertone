---
title: 'Rust: Mini-Notation'
---

# Rust: Mini-Notation

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Mini-Notation](/guide/mini-notation) page. Sequences, rests, subdivision, alternation, chords, polyrhythm, elongation, Euclidean rhythms, and what a bad string reports.

## What differs from the TypeScript

- **The strings are identical.** The mini-notation parser is the same one the TypeScript has, so every string on the TypeScript page works unchanged.
- **Each `.loop()` snippet becomes a short render.** A render gates notes by event length, which is what a loop does.
- **A bad string fails when the pattern is built**, with the position of the mistake.

## The example

The whole of `crates/undertone/examples/mini_notation.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example mini_notation` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/mini_notation.rs

<RustAudio example="mini_notation" />

A one-shot plays cycle zero only, so an alternation in a one-shot always plays its first option; the example renders two cycles to hear both.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
