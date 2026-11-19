---
title: 'Rust: Effects and Filters'
---

# Rust: Effects and Filters

::: warning The Rust API ships with 0.4.0
This page documents the Rust API of the `undertone` crate. It is released with Undertone 0.4.0 and the crates are not on crates.io yet, so nothing here can be installed today. At release, `cargo add undertone` will be the way in. Every code block below is the real source of an example that is compiled and run by the test suite; none of it has been listened to.
:::

This is the Rust version of the [Effects and Filters](/guide/effects) page. The lowpass and its envelope, highpass and phaser, orbits, and the per-orbit reverb and delay buses.

## What differs from the TypeScript

- **Reverb and delay are sends to shared buses**, so `roomsize`, `delaytime`, and `delayfeedback` are last-writer-wins on an orbit, exactly as in TypeScript.
- **`getOrbitBus` is `Engine::orbit_bus`**, reached through `Player::engine_mut`; `Engine::set_orbit_room_size` and `Engine::set_orbit_delay` tune a bus by hand.
- **A reverb's impulse response** comes from `build_impulse_response` and a seeded random source, so the room is repeatable.
- **`.orbit()` takes a plain non-negative integer**, and a negative one is an `Err`.

## The example

The whole of `crates/undertone/examples/effects_and_filters.rs` is below, included from the file itself, so it is the code that the test suite compiles and runs. Run it with `cargo run --example effects_and_filters` from a checkout; it writes short WAV files to the directory named by `UNDERTONE_EXAMPLE_OUT`, or to `undertone-examples` in the temporary directory.

<<< @/../crates/undertone/examples/effects_and_filters.rs

<RustAudio example="effects_and_filters" />

The browser-only part of the TypeScript page (the shared `AudioContext`) has no counterpart; the buses belong to the engine you hold.

The generated API reference is the [Rust API docs](/rust/undertone/) (rustdoc). The name mapping for every call is in [API-MAPPING.md](https://github.com/liminal-hq/undertone/blob/main/docs/rust-migration/API-MAPPING.md).
