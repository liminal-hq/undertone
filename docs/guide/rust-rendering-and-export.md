---
title: 'Rust: Rendering and Export'
---

# Rust: Rendering and Export

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Rendering and Export](/guide/rendering-and-export) page. Offline rendering, WAV encoding, reproducible seeds, gating, seamless loops, the master bus, and channel formats.

## What differs from the TypeScript

- **`render` is `renderToBuffer`**, `RenderedAudio::to_wav` is `encodeWav`, and `render_to_wav` does both in one call.
- **`context` factory and `URL.createObjectURL` have no equivalent.** There is no context to supply, and the WAV is a `Vec<u8>` you write where you like.
- **Options are checked, in the reference's order**, with its messages.
- **A render has no clock**, so the same pattern, options, and seed give the same samples on every machine.

## The example

The whole of `crates/undertone/examples/rendering_and_export.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example rendering_and_export` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/rendering_and_export.rs

WAV files are one to eight channels, all of one length.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
