---
title: 'Rust: Patterned Parameters'
---

# Rust: Patterned Parameters

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Patterned Parameters](/guide/patterned-parameters) page. A control as a number, a mini-notation string, or a pattern.

## What differs from the TypeScript

- **Structure comes from the pattern being controlled**, never from the control string, in both languages.
- **The guide's hi-hat line plays a sample**, and Undertone bundles none, so the example makes a hat as PCM and registers it the way a host registers decoded recordings.
- **A rest in a control string leaves the value unset**, so the default applies, not zero.
- **A few controls take plain values only** and return an `Err` when given a pattern.

## The example

The whole of `crates/undertone/examples/patterned_parameters.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example patterned_parameters` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/patterned_parameters.rs

<RustAudio example="patterned_parameters" />

Mistakes surface when the pattern is built, not in the middle of a song.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
