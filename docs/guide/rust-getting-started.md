---
title: 'Rust: Getting Started'
---

# Rust: Getting Started

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Getting Started](/guide/getting-started) page. Your first sound, a layered one-shot, and a look inside a pattern.

## What differs from the TypeScript

- **Nothing plays by itself.** There is no `.play()` that reaches for an `AudioContext`. `render` turns a pattern into samples, and a `Player` plays one on a clock; the example shows both.
- **No autoplay gesture.** The browser's user-gesture rule has no Rust equivalent, so the first-sound caveat of the TypeScript page does not apply.
- **Errors are values.** A control the reference would reject returns an `Err` when the pattern is built, so chained calls end in `?`.
- **Looking inside a pattern** is the same idea: `query` a span and read the haps.

## The example

The whole of `crates/undertone/examples/getting_started.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example getting_started` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/getting_started.rs

<RustAudio example="getting_started" />

The player above plays the files that example wrote, rendered by the Rust crate when the site is built. In a checkout the audio is not there until you make it: `scripts/render-rust-audio.sh` runs every example and writes the WAV files to `docs/public/rust-audio/`, and then `bun run docs:dev` shows the players. Nothing here has been listened to.

The TypeScript `.play()` is one cycle, once, so the example renders it with `gated(false)`. `.loop({ bpm })` is `Player::play_loop`.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
