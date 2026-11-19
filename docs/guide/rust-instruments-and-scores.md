---
title: 'Rust: Instruments and Scores'
---

# Rust: Instruments and Scores

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Instruments and Scores](/guide/instruments-and-scores) page. Instruments as data, layering, scores with exact timing, repeatable variation, and a mono check.

## What differs from the TypeScript

- **Instruments are plain data.** `fm_voice` takes an `FmVoiceDefinition` and gives a patch for `.voice`; `fm_presets()` returns the presets, and `layer` stacks voices on the same notes.
- **A score's cue** is played by the player: `cue.play()` and `cue.loop()` are `Player::play_score` and `Player::loop_score`, and `render_score` is the offline form.
- **`drift` is seeded**, so the same seed gives the same notes on every device.
- **`create_mono_fold`** makes the node that folds a mix to mono, to be given as the `output` of a play.

## The example

The whole of `crates/undertone/examples/instruments_and_scores.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example instruments_and_scores` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/instruments_and_scores.rs

A score refuses an event it cannot place, with the reference's message.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
