---
title: 'Rust: FM Synthesis'
---

# Rust: FM Synthesis

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [FM Synthesis](/guide/fm-synthesis) page. Modulation index and harmonicity, the modulator envelope, pitch curves, and the shaped waveforms.

## What differs from the TypeScript

- **The controls keep their names**: `fm`, `fmh`, `fm_decay`, `fm_sustain`, `fm_env`, `fm_wave`, `penv`, and `pdecay`.
- **`SHAPED_WAVE_TYPES` and `is_shaped_wave`** are exported, as in TypeScript.
- **FM controls are validated when the pattern is built**, and an unknown envelope or wave name is an `Err` with the reference's message.

## The example

The whole of `crates/undertone/examples/fm_synthesis.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example fm_synthesis` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/fm_synthesis.rs

Nothing on this page is browser-specific.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
