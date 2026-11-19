---
title: 'Rust: Stereo and Surround'
---

# Rust: Stereo and Surround

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Stereo and Surround](/guide/stereo-and-surround) page. Surround placement, pan movement inside a note, autopan, the pan slide, and the pan law.

## What differs from the TypeScript

- **No `enableMultichannel(ctx)`.** A render has no hardware, so it asks for the channel count it wants (`channels(8)`).
- **A surround render turns the master bus off.** A render goes through the master bus by default, whose input is two channels, so a placement for eight is folded to stereo (the TypeScript does the same). Use `MasterSetting::Off` for a surround render.
- **Pan points are in different units by context**: whole ticks from the onset in a score event, seconds from the voice's start in plain voice data, as the example shows.
- **Pan laws and autopan** are the same controls as in TypeScript.

## The example

The whole of `crates/undertone/examples/stereo_and_surround.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example stereo_and_surround` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/stereo_and_surround.rs

<RustAudio example="stereo_and_surround" />

Eight channels write a 7.1 WAV file with the extensible header.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
