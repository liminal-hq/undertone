# M4 notes: what the engine taught us

M4 built the voice booking, the in-house renderer, the score and WAV output, instruments and channels, and samples in `undertone-engine`, against the layer 3 corpus and a first layer 4. Nothing was listened to: every figure here comes from recorded node graphs, rendered numbers, or summaries.

## Where it stands

| Corpus                      | Result                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer 3                     | `placement` 50, `voices` 75, `options` 33, `instruments` 28, `channels` 42, `score` 46, `samples` 63: all equal in Rust, byte for byte except for the 1e-15 floor on wave coefficients                                                                                     |
| Layer 3 on the real C maths | equal with no case needing the floor (CI runs it on x86-64 and ARM64 with `UNDERTONE_EXPECT_MATHS=native`)                                                                                                                                                                 |
| Layer 2 (new groups)        | `instruments` 31/31, `channels` 31/31                                                                                                                                                                                                                                      |
| WAV                         | 34 cases, byte for byte                                                                                                                                                                                                                                                    |
| Layer 4 (Chromium 149)      | 20 cases recorded in Chromium 149 on 128-frame boundaries without delay feedback; the 18 normal cases meet the proposed tolerances (RMS and peak within 0.001 dB with the limiter off) and two labelled quirk cases meet documented guards; see [R-layer4.md](R-layer4.md) |
| Baseline against `v0.3.0`   | 243 of 243 baseline cases give the same graph with every 0.4.0 option off                                                                                                                                                                                                  |

## What changed or was found

- **The C-maths CI step had never tested the C library.** A self dev-dependency pulled the default `libm` feature back in. The fix (`default-features = false`) and `UNDERTONE_EXPECT_MATHS` make a regression fail the build. R9's claim of no differences against JavaScriptCore held when it was finally tested ([R9.md](R9.md) has the correction).
- **Reviews found real bugs before merge:** an engine that kept every voice forever, playback handles usable across engines, a reverb room size that panicked, a render option that hung on infinite tempo (the TypeScript hangs too), a biquad cache that ignored the filter type, a delay clamp that inverted at low sample rates, unbounded buffer rates, and a sample accepted by the registry that panicked when played. Each has a test that failed first.
- **Deliberate Rust-only bounds (D-27):** impulse responses up to 60 seconds, sample rates 1 to 1,000,000 Hz, at most 2^28 samples in a buffer, at most 1,048,576 cycles and 268,435,456 frames in a render. They return errors, not panics.
- **Layer 4 found renderer bugs, and the renderer now follows Chromium 149:** built-in oscillators were 1.5 dB too loud and used one table where Chromium blends two, the low-pass and high-pass `Q` used the wrong convention, the convolver's calibration gain was the specification's rounded figure and not Chromium's -58 dB, and the compressor's envelope, start-up state, and release differed. Two Chromium quirks stay on record as labelled cases (a voice starting inside a 128-frame quantum runs at 440 Hz for the rest of that quantum; a delay feedback pass adds 128 frames), and the other cases are recorded to avoid them (D-32). The renderer is therefore tuned to Chromium's behaviour, not to the specification alone.
- **Speed:** the renderer ran at 18.7 times real time on one run (10 s of stereo, 50 voices with filter, reverb, delay, and the master bus). The WebAssembly speed is not measured.

## Decisions made in M4

D-26 to D-31 in [DECISIONS.md](../DECISIONS.md): two guide passages corrected rather than the behaviour, the 60-second room bound, the `testing` entry for the bridge (D-24 decided), an explicit tempo in the Rust API, host-supplied PCM for samples, and layer 4 renders recorded here by hand.

## Still open

- **Layer 4 covers one browser:** only Chromium 149 on one machine was run, at 32768, 48000, and 49152 Hz (not 44100 Hz, where no musical cycle length is both aligned to 128 frames and exact in a double), and the renderer uses 4096-sample oscillator tables where Chromium uses 2048 up to 24 kHz and 8192 above 88.2 kHz. The compressor's adaptive-release constants are confirmed by four loud renders to 0.002 dB, not probed one by one.
- **Not compared:** `bookingWindow` renders and other browsers.
- **Render cases in the layer 3 runner** book the whole score up front; the windowed pauses are checked by the plan, not by a renderer driven through them.
- **For later milestones:** the scheduler (M5) owns windowed booking over time; the bridge decodes samples and keeps the global `setcpm()` (M6); `fast-check` is missing from local checkouts, so `conformance/recorder/properties.test.ts` runs only in CI.
