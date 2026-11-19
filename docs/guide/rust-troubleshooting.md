---
title: 'Rust: Troubleshooting'
---

# Rust: Troubleshooting

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Troubleshooting](/guide/troubleshooting) page. Each tip of the TypeScript guide, shown.

## What differs from the TypeScript

- **Two tips have no Rust form.** There is no autoplay policy, and decoded PCM is handed over whole, so "the first sound must follow a gesture" and "a sample is still decoding" do not arise.
- **Console warnings** (a clamped control, an unregistered sample name) are read from the engine with `Engine::warnings`, one per name.
- **The rest are demonstrated**: a silent sample layer, blips instead of held notes, a cut-off one-shot, `.sound()` after `.s()`, shared orbit buses, `~` in a control, tempo maths, stop against cut, and early errors.

## The example

The whole of `crates/undertone/examples/troubleshooting.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example troubleshooting` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/troubleshooting.rs

Patterns are immutable: `pat.fast(2)` returns a new pattern and leaves `pat` untouched.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
