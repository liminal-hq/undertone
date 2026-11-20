# undertone-native

Plays an Undertone `Player` in real time, through the system audio device (with [`cpal`](https://crates.io/crates/cpal)) or through a host's own audio callback.

This crate is part of the Rust migration of Undertone (RF-28) and ships with 0.4.0; it is not on crates.io yet.

## What is in it

- `Output`: takes a `Player` and a `Sink` and plays one through the other. A control thread ticks and renders the player ahead into a lock-free ring (`rtrb`); the audio thread only copies from the ring, so it does not allocate or lock. `open` and `close` are explicit; closing twice is fine.
- `Sink` and `AudioCallback`: the seam. A host with its own audio system implements `Sink`, is handed an `AudioCallback`, and calls `AudioCallback::fill(&mut [f32])` (interleaved) from its audio thread. `ManualSink` is a sink with no device, for tests and offline hosts.
- `CpalSink`, `output_devices`, `DeviceChoice` (the default `cpal` feature): list devices, open the default one or one by name.

```rust
use undertone::prelude::*;
use undertone_native::{CpalSink, Output, OutputOptions, Sink};

let sink = CpalSink::default_output()?;
let mut player = Player::new(&sink.format().player_options())?;
player.play_loop(&note("c3 e3 g3 c4")?.sound("triangle"), &LoopOptions::default())?;
let mut output = Output::open(sink, player, &OutputOptions::default())?;
// ... later
output.close();
```

## Linux build prerequisites

`cpal` uses ALSA on Linux, so the build needs the ALSA development headers and `pkg-config`:

- Debian and Ubuntu: `sudo apt-get install libasound2-dev pkg-config`
- Fedora: `sudo dnf install alsa-lib-devel pkgconf-pkg-config`
- Arch: `sudo pacman -S alsa-lib pkgconf`

At run time the machine needs an ALSA-visible device (PipeWire and PulseAudio both provide one). macOS (CoreAudio) and Windows (WASAPI) need nothing extra.

To build only the `Sink` seam, with no system audio library at all, turn the default feature off:

```toml
undertone-native = { version = "0.4", default-features = false }
```

## Run it

```text
cargo run -p undertone-native --example play                       # four seconds on the default device
cargo run -p undertone-native --example play -- --list             # list the output devices
cargo run -p undertone-native --example play -- --device pipewire  # a device by name
cargo run -p undertone-native --example play -- --soak-seconds 600 --busy-threads 16
```

`--soak-seconds` is the underrun soak: ten minutes with every core busy is `--soak-seconds 600 --busy-threads <cores>`. It reports the sample clock and the underrun count every ten seconds and exits with a failure status if anything underran. It is run by hand, not in CI.

## What the tests cover, and what they do not

- The audio callback allocates nothing (a counting global allocator, over runs with and without underruns).
- The stream a fake callback pulls is the player's own audio, sample for sample, and the first onset lands within a millisecond of where the sample clock expects it.
- Open and close twice, with a fake sink always and with the default device where the machine has one (the test says it skipped where there is none).

They do not say how it sounds: nothing here has been listened to by its authors. FreeBSD is not claimed: `cpal`'s output paths there are unverified.
