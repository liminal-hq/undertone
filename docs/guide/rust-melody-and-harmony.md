---
title: 'Rust: Melody and Harmony'
---

# Rust: Melody and Harmony

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Melody and Harmony](/guide/melody-and-harmony) page. Scale degrees, chord symbols and their voicing, and the pitch helpers.

## What differs from the TypeScript

- **Same vocabulary.** `n`, `.scale`, `chord`, `.voicing`, `note_to_midi`, `midi_to_frequency`, and `note_to_frequency` mirror the TypeScript names in snake case.
- **Options are structs.** The voicing anchor is a `VoicingOptions` (`VoicingOptions::default()` for middle C) rather than an object literal.
- **A bad note name or scale** fails when it is built, as an `Err`.

## The example

The whole of `crates/undertone/examples/melody_and_harmony.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example melody_and_harmony` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/melody_and_harmony.rs

<RustAudio example="melody_and_harmony" />

Chords are just notes, so the example reads the first cycle of the progression back as pitches.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
