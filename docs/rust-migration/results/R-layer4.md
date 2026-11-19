# R-layer4: the Rust renderer against Chromium 149 (layer 4 measured and enforced)

RF-20 step 5. Every figure here comes from `crates/undertone-engine/tests/layer4.rs` run against `conformance/cases/4/renders.json`. **Nothing was listened to.** The browser summaries were recorded by hand in headless Chromium and are summaries only (RMS, peak, octave-band RMS, RMS per 100 ms window); the definitions are in `conformance/README.md` (layer 4) and `conformance/recorder/renderSummary.ts`.

- **Browser:** Chrome for Testing 149.0.7827.55, headless, Linux (`~/.cache/ms-playwright/chromium-1228`), driven by `playwright-core` 1.65.1; 20 cases of 1.8 to 4 s at 32768, 48000, and 49152 Hz, stereo.
- **Decision (D-32):** option 1 below. The proposed tolerances are kept and enforced, the cases are recorded so that Chromium's two quirks do not apply, and two clearly labelled cases keep the quirks on record against a wider guard.
- **Determinism:** two runs on the same machine wrote files that differ in 6 of 20 cases (the pan-law, limiter-off, limiter-on, ceiling, and mix cases), by at most a relative 1.5e-7 in a single value (a band of tiny amplitude): float noise, about 1e-6 dB. The other 14 cases are byte-identical. Across browser versions or machines no claim is made.
- **Difference:** Rust minus browser, in decibels (`20 log10(rust / browser)`), so positive means louder in Rust. RMS and peak are the worst of the two channels; band and window are the worst compared value (band index 0 to 7, window index in 100 ms steps in brackets). A band or window is compared only when one of the two is at least 1e-4 (-80 dBFS). `X` marks a figure outside what the case is held to: the proposed tolerances (limiter off: RMS 0.01, peak 0.02, band 0.1, window 0.05; limiter on: RMS 0.05, peak 0.1, with the band and window figures of the limiter-off row), or for a quirk case its guard.

## What was decided and why the cases changed

The first measurements (below) found two Chromium quirks that no renderer following the specification would copy, and the person chose to keep the proposed tolerances and re-record the cases to avoid them, rather than widen the tolerances to cover them (which would not have caught a real 1 dB error in a peak).

- **A voice that starts inside a render quantum runs its oscillator at the wrong frequency for the rest of that quantum in Chromium.** An oscillator whose `frequency` has a `setValueAtTime(f, t0)` event with `t0` not a multiple of 128 frames runs at the previous frequency (440 Hz) for the rest of that quantum. Measured in isolation: a sine at 164.8 Hz started at 0.25 s (frame 12000, 96 frames into a quantum) has 0.0576 at frame 1 where the specification gives 0.0216; started at 0 or on a quantum boundary it is exact. Every case's onset is now a multiple of 128 frames at the case's sample rate.
- **Chromium adds one render quantum (128 frames) to every pass through a delay feedback loop.** Echoes of a 0.25 s delay with feedback 0.5 start at 12001, 24129, 36257 frames in Chromium and 12001, 24001, 36001 in Rust. The first echo matches; later ones are 128 frames late per pass. No normal case has a delay feedback loop now (an echo with feedback 0 has the first echo only).
- **The onset must also be exact in a double.** A first re-recording at 48000 Hz and 150 bpm had every onset on a whole quantum but not exact (`0.4 * 3` is `1.2000000000000002`); Chromium treats such a `setValueAtTime` as one instant late, so the voice's first sample sat at the unset gain (a click of up to full scale in the white noise case). The cases therefore use 49152 Hz (3 times 2^14) and 32768 Hz at one cycle a second (120 bpm for the Acid line, 2 s a cycle), where every onset is a multiple of 1/128 s and exact. The Acid line's playground tempo is 150 bpm; here it is 120 bpm.
- **Check:** `checkRenderQuirks` in `conformance/recorder/renders.ts` fails `conformance:check` (no browser) and the browser script for a case with no label that has an onset not exactly on a 128-frame boundary or a voice with a delay send with feedback, and for a labelled case that does not have its quirk.

## Measured (the committed code, the 20 recorded cases)

| case                                 | limiter | held to                        |  RMS dB | peak dB | band dB (band) | window dB (window) | bands / windows compared |
| ------------------------------------ | ------- | ------------------------------ | ------: | ------: | -------------: | -----------------: | ------------------------ |
| `render-voice-sine`                  | off     | proposed                       | -0.0000 | -0.0000 |     +0.000 (7) |        +0.000 (20) | 16 / 42                  |
| `render-voice-triangle`              | off     | proposed                       | -0.0000 | +0.0000 |     +0.000 (7) |        +0.000 (20) | 16 / 42                  |
| `render-voice-square`                | off     | proposed                       | -0.0000 | -0.0001 |     +0.000 (7) |        +0.000 (10) | 16 / 42                  |
| `render-voice-sawtooth`              | off     | proposed                       | +0.0000 | +0.0007 |     +0.000 (7) |        -0.000 (20) | 16 / 42                  |
| `render-voice-white`                 | off     | proposed                       | -0.0000 | -0.0000 |     -0.000 (0) |        -0.000 (11) | 16 / 24                  |
| `render-voice-pink-brown`            | off     | proposed                       | +0.0000 | -0.0000 |     +0.000 (1) |        +0.000 (11) | 16 / 24                  |
| `render-filter-sweep`                | off     | proposed                       | -0.0000 | -0.0004 |     -0.000 (1) |        -0.000 (25) | 16 / 60                  |
| `render-envelope`                    | off     | proposed                       | -0.0000 | -0.0000 |     -0.000 (6) |        -0.000 (10) | 14 / 46                  |
| `render-reverb`                      | off     | proposed                       | +0.0000 | -0.0000 |     -0.000 (7) |         -0.000 (9) | 16 / 42                  |
| `render-delay`                       | off     | proposed                       | +0.0000 | -0.0000 |     -0.000 (1) |         +0.000 (3) | 16 / 12                  |
| `render-quirk-delay-feedback`        | off     | quirk guard: delay-feedback    | +0.1700 | +0.5266 |     +0.472 (3) |        -6.820 (28) | 16 / 36                  |
| `render-quirk-mid-quantum-start`     | off     | quirk guard: mid-quantum-start | +0.0178 | -0.1160 |    +11.863 (7) |         +0.107 (2) | 16 / 40                  |
| `render-pan-law`                     | off     | proposed                       | -0.0000 | -0.0000 |     -0.000 (7) |        -0.000 (20) | 16 / 41                  |
| `render-pan-law-6`                   | off     | proposed                       | -0.0000 | -0.0000 |     -0.000 (7) |        -0.000 (20) | 16 / 41                  |
| `render-limiter-off`                 | off     | proposed                       | -0.0000 | +0.0006 |     +0.000 (7) |        -0.000 (14) | 16 / 40                  |
| `render-limiter-on`                  | on      | proposed                       | +0.0014 | +0.0004 |     +0.060 (0) |         +0.034 (0) | 16 / 44                  |
| `render-limiter-ceiling`             | on      | proposed                       | +0.0015 | -0.0000 |     +0.037 (0) |         +0.036 (0) | 16 / 44                  |
| `render-playground-acid-line`        | off     | proposed                       | +0.0000 | -0.0000 |     +0.000 (5) |        -0.000 (40) | 16 / 82                  |
| `render-playground-acid-line-master` | on      | proposed                       | +0.0008 | +0.0001 |     +0.001 (1) |         +0.022 (0) | 14 / 82                  |
| `render-mix-four-bars`               | on      | proposed                       | +0.0005 | +0.0001 |     +0.001 (7) |         +0.019 (0) | 16 / 80                  |

Per band, the worst difference over the channels (dB; `.` below the floor in both renders):

| case                                 |  <125 |   125 |   250 |   500 |    1k |    2k |     4k |   >=8k |
| ------------------------------------ | ----: | ----: | ----: | ----: | ----: | ----: | -----: | -----: |
| `render-voice-sine`                  | -0.00 | -0.00 | -0.00 | +0.00 | +0.00 | +0.00 |  +0.00 |  +0.00 |
| `render-voice-triangle`              | -0.00 | -0.00 | -0.00 | -0.00 | -0.00 | +0.00 |  +0.00 |  +0.00 |
| `render-voice-square`                | -0.00 | -0.00 | +0.00 | +0.00 | -0.00 | -0.00 |  +0.00 |  +0.00 |
| `render-voice-sawtooth`              | +0.00 | -0.00 | +0.00 | +0.00 | +0.00 | +0.00 |  +0.00 |  +0.00 |
| `render-voice-white`                 | -0.00 | -0.00 | -0.00 | -0.00 | -0.00 | -0.00 |  -0.00 |  -0.00 |
| `render-voice-pink-brown`            | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 |  +0.00 |  +0.00 |
| `render-filter-sweep`                | +0.00 | -0.00 | +0.00 | +0.00 | -0.00 | +0.00 |  +0.00 |  +0.00 |
| `render-envelope`                    |     . | -0.00 | -0.00 | -0.00 | +0.00 | -0.00 |  -0.00 |  +0.00 |
| `render-reverb`                      | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 |  -0.00 |  -0.00 |
| `render-delay`                       | +0.00 | -0.00 | +0.00 | +0.00 | -0.00 | +0.00 |  -0.00 |  -0.00 |
| `render-quirk-delay-feedback`        | +0.36 | +0.27 | +0.13 | +0.47 | +0.31 | +0.20 |  +0.22 |  +0.28 |
| `render-quirk-mid-quantum-start`     | +0.04 | +0.01 | +0.00 | +1.79 | +6.03 | +9.59 | +11.27 | +11.86 |
| `render-pan-law`                     | +0.00 | -0.00 | -0.00 | -0.00 | -0.00 | -0.00 |  -0.00 |  -0.00 |
| `render-pan-law-6`                   | +0.00 | -0.00 | -0.00 | -0.00 | -0.00 | -0.00 |  -0.00 |  -0.00 |
| `render-limiter-off`                 | +0.00 | +0.00 | -0.00 | +0.00 | -0.00 | +0.00 |  +0.00 |  +0.00 |
| `render-limiter-on`                  | +0.06 | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 |  +0.00 |  +0.00 |
| `render-limiter-ceiling`             | +0.04 | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 |  +0.00 |  +0.00 |
| `render-playground-acid-line`        | +0.00 | +0.00 | +0.00 | -0.00 | -0.00 | +0.00 |  +0.00 |  -0.00 |
| `render-playground-acid-line-master` | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 |  +0.00 |      . |
| `render-mix-four-bars`               | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 | +0.00 |  +0.00 |  +0.00 |

- **Normal cases (18):** every case without a quirk label meets the proposed tolerances, and by a wide margin: limiter off, RMS within 0.0001 dB, peak within 0.001 dB (the worst, sawtooth, +0.0007 dB), bands and windows within 0.001 dB; limiter on, RMS within 0.002 dB and peak within 0.001 dB, the worst band +0.06 dB (below 125 Hz, `render-limiter-on`) and the worst window +0.036 dB (the first 100 ms, where the compressor's start-up shows).
- **Delay feedback (quirk, `render-quirk-delay-feedback`):** RMS +0.17 dB, peak +0.53 dB, band +0.47 dB, window -6.8 dB (the window holding the third echo's edge). Asserted against a guard of RMS 0.25, peak 0.75, band 0.75, window 7.5 dB.
- **Mid-quantum start (quirk, `render-quirk-mid-quantum-start`):** RMS +0.018 dB, peak -0.116 dB, window +0.107 dB, and the bands above 500 Hz +1.8 to +11.9 dB (the sine's partials there are at -70 to -80 dBFS, where the changed phase shows). Asserted against a guard of RMS 0.05, peak 0.25, band 12.5, window 0.25 dB.

## What the first run found (history)

The first run, on the earlier 17 cases (onsets at 0.25 s steps at 48 kHz, a delay with feedback in two of them), gave RMS differences of up to +1.8 dB, peaks up to 2.75 dB, and a band up to 11.9 dB; 15 of the 17 cases missed the proposed figures. Two renderer differences explained most of it, and both were measured against the browser directly before being fixed, each in its own commit:

1. **Built-in oscillators were not normalised.** Chromium scales a square or sawtooth to 0.848 of the ideal wave (one over the Gibbs overshoot of the many-partial sum; a sine and triangle are unchanged), and the in-house tables were left at 1.0 (square and sawtooth +1.48 and +1.52 dB in RMS). Fixed in `fix: normalise the built-in oscillator waves like Chromium`.
2. **The low-pass and high-pass `Q` had the old browsers' meaning.** Chromium 149's `getFrequencyResponse` gives the gain at the cutoff as `Q` decibels, the specification's linear `10^(Q/20)`; the renderer was 0.7 dB too quiet through the engine's default `Q` of 1. Fixed in `fix: give the low-pass and high-pass Q the specification's decibel meaning`.

After those two fixes the old table still missed in most cases because of the two quirks above (a limiter-off sine band +11.9 dB, filter sweep peak -2.75 dB, delay window -3.9 dB), a loose limiter (RMS +0.10 to +0.22 dB, peak up to 1.41 dB), and small differences in the oscillator's partials near Nyquist (band +0.3 to +0.9 dB). The old table is not kept; the sections above replace it.

## What the re-recorded cases found, and three more renderer fixes

With the quirks avoided, the 18 normal cases still missed the proposed tolerances for three renderer reasons, found by probing single notes and impulses in Chromium rather than assumed, and fixed each in its own commit (before and after numbers in the commit bodies):

1. **The oscillator's tables.** Chromium keeps 36 tables per wave, table `i` with `floor(2048 / 2^(i/3))` partials, the lowest fundamental being Nyquist over 2048, and blends the two neighbouring tables for the frequency (range `1 + 3 log2(f / lowest)`); the partials of a sawtooth at 440 Hz and 32768 Hz, 26 to 32, come out at 0.656 of their level, the blend of the tables with 32 and 25 partials. The renderer picked one table with a sharp edge. The ≥ 8 kHz band missed by +0.2 to +0.9 dB and the square and sawtooth peaks by 0.05 to 0.23 dB; now a single note at 440 Hz matches Chromium to 1.5e-7 of full scale (other pitches drift by up to 1e-3 from a float32 frequency in the browser, about -70 dB). Fixed in `fix: blend two neighbouring wave tables like Chromium's oscillators`.
2. **The convolver's calibration gain.** Chromium's convolver gives 0.0012589 at 44100 Hz for a response of constant 0.5 whatever its length, which is `10^(-58/20)`, not the specification's rounded 0.00125; the reverb sat a constant -0.0618 dB under the browser (correlation 0.9999999999). Fixed in `fix: use the convolver's -58 dB calibration gain` (window -0.0625 dB to 0.000 dB).
3. **The compressor.** Chromium resets the detector to 0 (the first tens of milliseconds are held down while it climbs: up to +3.9 dB in the first window), decides the envelope every 32 frames with the gain warped by `asin` and `sin`, and releases by an adaptive 5 dB-per-curve rate; the renderer had a constant 10 dB per release time and a detector at 1. Fixed in `fix: follow Chromium's compressor envelope and start-up state` (limiter-on RMS +0.145 dB to +0.001 dB, peak -0.339 dB to +0.000 dB, worst window +3.93 dB to +0.02 dB). The quartic's constants are Chromium's as recalled by the author; the measurement confirms them to 0.002 dB on four loud renders.

## What still deviates

- **The two quirks, on purpose** (the labelled cases above). The Rust follows the specification and does not emulate them.
- **Table size at other sample rates.** Chromium uses 2048-sample tables up to 24 kHz and 8192 above 88.2 kHz; this renderer uses 4096 at every rate and was measured only at 32768, 48000, and 49152 Hz.
- **The limiter on other signals.** It was measured on four loud renders (chords, a bass line, a mix), all within 0.002 dB RMS; the constants of the adaptive release were not probed one by one, so a signal that exercises a different part of the curve is not covered.

## Not verified

- No case was listened to; automated summaries cannot say how anything sounds.
- Chromium only, one version, one machine. Firefox and Safari were not run, so the quirks and the table, calibration, and compressor details above are Chromium 149's.
- A voice that starts mid-quantum is held only to the wide guard of its labelled case; the renderer does not copy the quirk, so a real phase error on such a voice would only be caught by the other cases.
- Booking in windows (`bookingWindow`) was not compared (the cases book up front).
- 44100 Hz was not used: its quanta (128 / 44100 s) are not exact in a double at any musical cycle length, so no case could be both aligned and exact there.
