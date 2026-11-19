---
title: 'Rust: Tempo and Note Length'
---

# Rust: Tempo and Note Length

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Tempo and Note Length](/guide/tempo-and-note-length) page. Gated loops against percussive one-shots, a loop on a player, the default tempo, and how stop differs from a cut.

## What differs from the TypeScript

- **The tempo is explicit.** There is no global `setcpm`. A `bpm` or `cps` on a call wins; otherwise the `Player` (or the render options' `default_cpm`) holds the default, set with `Player::set_cpm` and cleared with `Player::reset_tempo`.
- **The loop handle** returned by `Player::play_loop` goes back to `Player::stop_loop` with a `LoopStop`, which is how `stop()` and a cut are told apart.
- **Time is the clock's.** The example uses the offline clock, so asking for two seconds of audio plays two seconds.

## The example

The whole of `crates/undertone/examples/tempo_and_note_length.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example tempo_and_note_length` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/tempo_and_note_length.rs

The pattern transforms (`fast`, `slow`, `rev`, `every`, `euclid`, `jux`) have the same names as in TypeScript and return `Result` where the reference can reject an argument.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
