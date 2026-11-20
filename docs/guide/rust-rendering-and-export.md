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

<RustAudio example="rendering_and_export" />

WAV files are one to eight channels, all of one length.

## Rendering without a browser

Nothing in a render needs a device, a browser, or an operating system clock, so the same engine runs as a command line, natively or as a WebAssembly program under WASI. `undertone-render` (the `undertone-cli` crate) takes a mini-notation pattern, a length, a tempo, a sample rate, a channel count, and a seed, and writes a WAV file:

```sh
cargo run --release -p undertone-cli -- --note "c3 [e3 g3] <b3 a3> ~" --wave triangle --seconds 1.5 --bpm 240 --rate 22050 --seed level-1 --out song.wav
```

`--sound "white*4"` takes unpitched sounds instead of notes, `--channels` is 1, 2, 4, 6, or 8 (above two the master bus is off, as in the example above), `--bit-depth` is 16, 24, or 32, and `--out -` writes to standard output. Run it with `--help` for the list.

To run it under [`wasmtime`](https://wasmtime.dev/), build for `wasm32-wasip1` and give the program the directory it may write to:

```sh
rustup target add wasm32-wasip1
cargo build --release -p undertone-cli --target wasm32-wasip1
wasmtime run --dir . target/wasm32-wasip1/release/undertone-render.wasm --note "c3 e3 g3" --seconds 1 --out song.wav
```

The two builds write the same bytes: the maths is the `libm` crate on both (the default `libm` feature), so there is no platform difference to measure, and `scripts/check-wasi-render.sh` compares the files with `cmp` in CI. The JavaScript package renders the same bytes too ([Rendering without a browser](/guide/rendering-and-export#rendering-without-a-browser)). Nothing here has been listened to.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
