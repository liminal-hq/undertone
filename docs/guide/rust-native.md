---
title: 'Rust: Playing Natively'
---

# Rust: Playing Natively

::: warning The Rust API ships with 0.4.0
This page documents the `undertone-native` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. Everything below was checked by automated tests against a fake audio callback; none of it has been listened to by its authors.
:::

The other Rust pages render a pattern to samples. This one plays a [`Player`](/guide/rust-getting-started) through the sound card in real time, with the `undertone-native` crate. There is no TypeScript page to port: in a browser, Web Audio does this for you.

<!-- rust-audio: none, this example plays on a sound card and writes no WAV file, so there is no player here -->

## What it does

- **`Output`** takes a `Player` and a `Sink`, and plays the player through the sink until you close it. `Output::open` and `Output::close` are explicit, and closing twice is fine.
- **`CpalSink`** is a sink over a system output device, through the `cpal` crate. `output_devices` lists the devices and `DeviceChoice` picks the default one or one by name.
- **`Sink`** is the seam. If your program already owns an audio callback (a Tauri plugin, a plug-in host), implement `Sink` instead: you receive an `AudioCallback`, call `AudioCallback::fill` from your audio thread, and nothing needs `cpal`.

## Threads

Two threads share the work, and only one of them is real time.

- The **control thread** books the player's transport, renders the engine's graph a block at a time, and writes the samples to a lock-free ring. This is the work that allocates, so it never runs in the audio callback.
- The **audio thread** is the device's callback. `AudioCallback::fill` copies from the ring and counts frames. It does not allocate, lock, or block, and a test counts that with a global allocator.

The cost is latency: what you play is heard after the ring has drained what was rendered before it. `OutputOptions::buffer_seconds` sets it (default a tenth of a second). A bigger buffer survives a busier machine; a smaller one responds sooner and underruns sooner.

If the ring runs dry the callback writes silence and, when audio is available again, drops the same number of frames, so the stream keeps its place against the sample clock. An underrun costs a gap, never a drift. `StreamHealth` counts them.

## The example

The whole of `crates/undertone-native/examples/play.rs` is below, included from the file itself. Run it with `cargo run -p undertone-native --example play` from a checkout. `-- --list` lists the output devices, `-- --device NAME` picks one, and `-- --soak-seconds 600 --busy-threads 16` is the underrun soak: it plays for ten minutes with sixteen threads spinning, and exits with a failure status if anything underran.

<<< @/../crates/undertone-native/examples/play.rs

## Linux build prerequisites

`cpal` talks to ALSA on Linux, so building needs the ALSA development files and `pkg-config`: `libasound2-dev` on Debian and Ubuntu, `alsa-lib` on Arch, `alsa-lib-devel` on Fedora. macOS and Windows need nothing extra. Build with `--no-default-features` to leave `cpal` out and keep only the `Sink` seam, which needs no system library.

## What is not claimed

- **Nobody has listened to it here.** The tests assert the samples, the timing, and the allocation count. They cannot say how it sounds on your speakers.
- **The ten-minute soak with every core busy is run by hand**, with the example's `--soak-seconds` flag, on a real machine. CI does not run it.
- **FreeBSD is not claimed.** `cpal`'s output paths there are unverified, so the crate is built and tested on Linux only for now.

The generated API reference is the [Rust API docs](/rust/undertone_native/).
