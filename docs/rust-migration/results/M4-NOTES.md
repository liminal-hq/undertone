# M4 notes: what the engine taught us

M4 built the voice booking, the in-house renderer, the score and WAV output, instruments and channels, and samples in `undertone-engine`, against the layer 3 corpus and a first layer 4. Nothing was listened to: every figure here comes from recorded node graphs, rendered numbers, or summaries.

## Where it stands

| Corpus                      | Result                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer 3                     | `placement` 50, `voices` 75, `options` 33, `instruments` 28, `channels` 42, `score` 46, `samples` 63: all equal in Rust, byte for byte except for the 1e-15 floor on wave coefficients |
| Layer 3 on the real C maths | equal with no case needing the floor (CI runs it on x86-64 and ARM64 with `UNDERTONE_EXPECT_MATHS=native`)                                                                             |
| Layer 2 (new groups)        | `instruments` 31/31, `channels` 31/31                                                                                                                                                  |
| WAV                         | 34 cases, byte for byte                                                                                                                                                                |
| Layer 4 (Chromium 149)      | 17 cases recorded and measured, not yet tolerance-checked; see [R-layer4.md](R-layer4.md)                                                                                              |
| Baseline against `v0.3.0`   | 243 of 243 baseline cases give the same graph with every 0.4.0 option off                                                                                                              |

## What changed or was found

- **The C-maths CI step had never tested the C library.** A self dev-dependency pulled the default `libm` feature back in. The fix (`default-features = false`) and `UNDERTONE_EXPECT_MATHS` make a regression fail the build. R9's claim of no differences against JavaScriptCore held when it was finally tested ([R9.md](R9.md) has the correction).
- **Reviews found real bugs before merge:** an engine that kept every voice forever, playback handles usable across engines, a reverb room size that panicked, a render option that hung on infinite tempo (the TypeScript hangs too), a biquad cache that ignored the filter type, a delay clamp that inverted at low sample rates, unbounded buffer rates, and a sample accepted by the registry that panicked when played. Each has a test that failed first.
- **Deliberate Rust-only bounds (D-27):** impulse responses up to 60 seconds, sample rates 1 to 1,000,000 Hz, at most 2^28 samples in a buffer, at most 1,048,576 cycles and 268,435,456 frames in a render. They return errors, not panics.
- **Layer 4 found two renderer bugs:** built-in oscillators were 1.5 dB too loud against Chromium, and the low-pass and high-pass `Q` used the wrong convention. What remains is mostly two Chromium quirks (a voice starting inside a 128-frame quantum runs at 440 Hz for the rest of that quantum; a delay feedback pass adds 128 frames) and the limiter, which differs by design.
- **Speed:** the renderer ran at 18.7 times real time on one run (10 s of stereo, 50 voices with filter, reverb, delay, and the master bus). The WebAssembly speed is not measured.

## Decisions made in M4

D-26 to D-31 in [DECISIONS.md](../DECISIONS.md): two guide passages corrected rather than the behaviour, the 60-second room bound, the `testing` entry for the bridge (D-24 decided), an explicit tempo in the Rust API, host-supplied PCM for samples, and layer 4 renders recorded here by hand.

## Still open

- **The layer 4 tolerances.** [R-layer4.md](R-layer4.md) offers two options and no tolerance was changed: re-record the cases with voice starts on multiples of 128 frames and no delay feedback (recommended), or widen to the measured worst values (which would not catch a real 1 dB peak error). Only Chromium 149 was run.
- **Not compared:** `bookingWindow` renders, the limiter's release and look-ahead, other browsers.
- **Render cases in the layer 3 runner** book the whole score up front; the windowed pauses are checked by the plan, not by a renderer driven through them.
- **For later milestones:** the scheduler (M5) owns windowed booking over time; the bridge decodes samples and keeps the global `setcpm()` (M6); `fast-check` is missing from local checkouts, so `conformance/recorder/properties.test.ts` runs only in CI.
