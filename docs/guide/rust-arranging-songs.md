---
title: 'Rust: Arranging Songs'
---

# Rust: Arranging Songs

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Arranging Songs](/guide/arranging-songs) page. Sections of whole cycles, played back to back.

## What differs from the TypeScript

- **`arrange` takes a `Vec` of `(cycles, pattern)` pairs** and returns an ordinary pattern, so everything composes.
- **Each section experiences its own cycles from zero** when its span begins.
- **A section length must be a positive whole number of cycles**, or `arrange` returns an `Err`.

## The example

The whole of `crates/undertone/examples/arranging_songs.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example arranging_songs` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/arranging_songs.rs

A sixteen-cycle song is about forty seconds at 96 bpm, so the example squeezes the same sections into two seconds to pass through every seam.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
