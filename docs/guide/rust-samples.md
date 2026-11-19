---
title: 'Rust: Samples'
---

# Rust: Samples

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Samples](/guide/samples) page. A bring-your-own-assets registry, with a kick, snare, hat, and bass made as PCM so the example needs no files.

## What differs from the TypeScript

- **The host supplies decoded PCM.** Undertone fetches and decodes nothing in Rust, so a URL passed to `registerSample` has no equivalent: you hand over a `SampleData` (a sample rate and one buffer of samples per channel).
- **`loadSamples(ctx)` and `getSampleBuffer(ctx)` as decoding do not exist.** The two-step flow of the browser is a pending name (`register_pending_sample`) and a later `load_samples` with the PCM; a voice that names a pending sample is skipped, without a warning, until the PCM arrives.
- **Registration validates**, so a bad base note or an empty recording fails at registration, not in the middle of a song.
- **Where the registry lives.** `RenderOptions::register_sample` puts a sample in a render; `Player::samples_mut` reaches a player's registry.

## The example

The whole of `crates/undertone/examples/samples.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example samples` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/samples.rs

<RustAudio example="samples" />

`.bank(name)` is a lookup convention in both languages: it tries `{bank}_{name}` before the bare name.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
