# R-layer4: the Rust renderer against Chromium 149 (layer 4 measured)

RF-20 step 5. Every figure here comes from `crates/undertone-engine/tests/layer4.rs` run against `conformance/cases/4/renders.json`. **Nothing was listened to.** The browser summaries were recorded by hand in headless Chromium and are summaries only (RMS, peak, octave-band RMS, RMS per 100 ms window); the definitions are in `conformance/README.md` (layer 4) and `conformance/recorder/renderSummary.ts`.

- **Browser:** Chrome for Testing 149.0.7827.55, headless, Linux (`~/.cache/ms-playwright/chromium-1228`), driven by `playwright-core` 1.65.1; 17 cases of 1.8 to 4 s at 44.1 and 48 kHz, stereo.
- **Determinism:** two runs on the same machine wrote files that differ in 6 of 17 cases (the pan-law, limiter, and mix cases), by at most a relative 5.6e-8 in a single value (a band of 5e-4 amplitude): float noise, far below any tolerance. The other 11 cases are byte-identical. Across browser versions or machines no claim is made.
- **Difference:** Rust minus browser, in decibels (`20 log10(rust / browser)`), so positive means louder in Rust. RMS and peak are the worst of the two channels; band and window are the worst compared value (band index 0 to 7, window index in 100 ms steps in brackets). A band or window is compared only when one of the two is at least 1e-4 (-80 dBFS). `X` marks a figure outside the proposed tolerance for that case (limiter off: RMS 0.01, peak 0.02, band 0.1, window 0.05; limiter on: RMS 0.05, peak 0.1, and the band and window figures are compared against the same 0.1 and 0.05 for information, the proposal gives none).

## What the first run found, and the two renderer fixes

Before any change, the first run gave the table below. Two renderer differences explained most of it, and both were measured against the browser directly (not assumed) before being fixed, each in its own commit:

1. **Built-in oscillators were not normalised.** Chromium scales a square or sawtooth to 0.848 of the ideal wave (one over the Gibbs overshoot of the many-partial sum; a sine and triangle are unchanged), and the in-house tables were left at 1.0. The square and sawtooth voices were +1.478 and +1.521 dB too loud in RMS; the filter, reverb, delay, and mix cases 1.2 to 1.8 dB. Fixed in `fix: normalise the built-in oscillator waves like Chromium`.
2. **The low-pass and high-pass `Q` had the old browsers' meaning.** Chromium 149's `getFrequencyResponse` gives the gain at the cutoff as `Q` decibels (1.000, 1.122, 3.981 for `Q` 0, 1, 12; 0.501 for -6), the specification's linear `10^(Q/20)`. The renderer treated the dB value as the height of the peak with 0 dB as Butterworth, so with the engine's default `Q` of 1 it was about 0.7 dB too quiet in the pass band's upper part. On seeded white noise through the engine's `lpf` 1500 the difference went from -0.717 dB to 0.000 dB (relative sample error 3.4e-7); a `hpf` 3000 from -0.226 dB to 0.000 dB. Fixed in `fix: give the low-pass and high-pass Q the specification's decibel meaning`.

### Before (the first run)

| case                                 | limiter |    RMS dB |   peak dB | band dB (band) | window dB (window) | bands / windows compared |
| ------------------------------------ | ------- | --------: | --------: | -------------: | -----------------: | ------------------------ |
| `render-voice-sine`                  | off     | +0.0178 X | -0.1160 X |  +11.863 X (7) |       +0.107 X (2) | 16 / 40                  |
| `render-voice-triangle`              | off     |   +0.0089 | -0.5457 X |   +0.921 X (7) |       +0.101 X (2) | 16 / 40                  |
| `render-voice-square`                | off     | +1.4780 X | +1.2691 X |   +1.813 X (7) |      +1.837 X (10) | 16 / 40                  |
| `render-voice-sawtooth`              | off     | +1.5208 X | +1.7626 X |   +1.835 X (2) |       +2.145 X (2) | 16 / 40                  |
| `render-voice-white`                 | off     |   -0.0000 |   +0.0000 |     -0.000 (1) |        -0.000 (11) | 16 / 24                  |
| `render-filter-sweep`                | off     | +1.2700 X | -1.7283 X |   +1.446 X (2) |       +1.596 X (9) | 16 / 60                  |
| `render-envelope`                    | off     |   -0.0017 |   -0.0005 |     +0.096 (7) |        -0.002 (10) | 14 / 46                  |
| `render-reverb`                      | off     | +1.2848 X | +0.5524 X |   +1.421 X (1) |      +1.314 X (10) | 16 / 41                  |
| `render-delay`                       | off     | +1.8319 X | +1.9986 X |   +1.994 X (7) |      +3.090 X (27) | 16 / 36                  |
| `render-pan-law`                     | off     | -0.0345 X | +0.4561 X |   -0.807 X (7) |       -0.236 X (4) | 16 / 39                  |
| `render-pan-law-6`                   | off     | -0.0345 X | +0.4561 X |   -0.807 X (7) |       -0.236 X (4) | 16 / 39                  |
| `render-limiter-off`                 | off     | +1.3142 X | +2.4235 X |   +2.237 X (7) |      +2.459 X (15) | 16 / 40                  |
| `render-limiter-on`                  | on      | +0.3903 X | +0.5542 X |   +1.858 X (0) |       +1.304 X (0) | 16 / 44                  |
| `render-limiter-ceiling`             | on      | +0.1835 X |   -0.0000 |   -1.093 X (0) |      +0.932 X (21) | 16 / 44                  |
| `render-playground-acid-line`        | off     | +1.3051 X | +0.5641 X |   +1.514 X (6) |      +1.375 X (16) | 15 / 64                  |
| `render-playground-acid-line-master` | on      | +1.4530 X | +0.2598 X |   +1.649 X (6) |       +5.251 X (0) | 16 / 64                  |
| `render-mix-four-bars`               | on      | +0.4183 X | +1.7071 X |   +1.340 X (3) |       +3.410 X (0) | 16 / 80                  |

### After both fixes (the committed code)

| case                                 | limiter |    RMS dB |   peak dB | band dB (band) | window dB (window) | bands / windows compared |
| ------------------------------------ | ------- | --------: | --------: | -------------: | -----------------: | ------------------------ |
| `render-voice-sine`                  | off     | +0.0178 X | -0.1160 X |  +11.863 X (7) |       +0.107 X (2) | 16 / 40                  |
| `render-voice-triangle`              | off     | +0.0106 X | -0.5440 X |   +0.923 X (7) |       +0.102 X (2) | 16 / 40                  |
| `render-voice-square`                | off     | +0.0478 X | -0.1610 X |   +0.383 X (7) |      +0.407 X (10) | 16 / 40                  |
| `render-voice-sawtooth`              | off     | +0.0943 X | +0.3361 X |   -0.474 X (3) |       +0.719 X (2) | 16 / 40                  |
| `render-voice-white`                 | off     |   -0.0000 |   +0.0000 |     -0.000 (1) |        -0.000 (11) | 16 / 24                  |
| `render-filter-sweep`                | off     | -0.0996 X | -2.7517 X |   -0.398 X (1) |       -0.379 X (5) | 16 / 60                  |
| `render-envelope`                    | off     |   -0.0000 |   +0.0012 |     +0.098 (7) |        -0.000 (10) | 14 / 46                  |
| `render-reverb`                      | off     |   -0.0022 |   -0.0039 |     -0.094 (0) |       -0.090 X (9) | 16 / 41                  |
| `render-delay`                       | off     | +0.4018 X | +0.5685 X |   +0.564 X (7) |      -3.920 X (28) | 16 / 36                  |
| `render-pan-law`                     | off     | -0.0328 X | +0.4578 X |   -0.806 X (7) |       -0.234 X (4) | 16 / 39                  |
| `render-pan-law-6`                   | off     | -0.0328 X | +0.4578 X |   -0.806 X (7) |       -0.234 X (4) | 16 / 39                  |
| `render-limiter-off`                 | off     | -0.1123 X | +0.9969 X |   -0.905 X (2) |      +1.033 X (15) | 16 / 40                  |
| `render-limiter-on`                  | on      | +0.2195 X | +0.3607 X |   +1.649 X (0) |       +1.095 X (0) | 16 / 44                  |
| `render-limiter-ceiling`             | on      | +0.1022 X |   -0.0000 |   -1.306 X (0) |       +0.724 X (0) | 16 / 44                  |
| `render-playground-acid-line`        | off     |   +0.0039 |   +0.0001 |   +0.116 X (6) |        +0.038 (25) | 15 / 64                  |
| `render-playground-acid-line-master` | on      | +0.1920 X |   +0.0076 |   +0.337 X (5) |       +3.928 X (0) | 16 / 64                  |
| `render-mix-four-bars`               | on      | -0.1050 X | +1.4081 X |   -0.405 X (1) |       +2.655 X (0) | 16 / 80                  |

Per band, the worst difference over the channels after both fixes (dB; `.` means below the floor in both renders):

| case                                 |  <125 |   125 |   250 |   500 |    1k |    2k |     4k |   >=8k |
| ------------------------------------ | ----: | ----: | ----: | ----: | ----: | ----: | -----: | -----: |
| `render-voice-sine`                  | +0.04 | +0.01 | +0.00 | +1.79 | +6.03 | +9.59 | +11.27 | +11.86 |
| `render-voice-triangle`              | +0.04 | +0.01 | -0.02 | -0.07 | -0.06 | +0.07 |  +0.16 |  +0.92 |
| `render-voice-square`                | +0.04 | +0.01 | +0.07 | +0.18 | +0.12 | -0.09 |  -0.03 |  +0.38 |
| `render-voice-sawtooth`              | +0.04 | +0.02 | +0.41 | -0.47 | +0.40 | +0.17 |  -0.03 |  +0.34 |
| `render-voice-white`                 | -0.00 | -0.00 | -0.00 | -0.00 | -0.00 | -0.00 |  -0.00 |  -0.00 |
| `render-filter-sweep`                | -0.08 | -0.40 | +0.15 | -0.01 | +0.12 | -0.00 |  +0.01 |  -0.21 |
| `render-envelope`                    |     . | +0.00 | -0.00 | -0.00 | +0.00 | -0.00 |  -0.00 |  +0.10 |
| `render-reverb`                      | -0.09 | -0.00 | +0.00 | -0.01 | -0.00 | -0.01 |  -0.01 |  +0.00 |
| `render-delay`                       | +0.22 | +0.23 | +0.44 | +0.18 | +0.21 | +0.36 |  +0.29 |  +0.56 |
| `render-pan-law`                     | -0.35 | -0.05 | +0.02 | +0.14 | +0.02 | +0.10 |  -0.24 |  -0.81 |
| `render-pan-law-6`                   | -0.35 | -0.05 | +0.02 | +0.14 | +0.02 | +0.10 |  -0.24 |  -0.81 |
| `render-limiter-off`                 | -0.11 | -0.03 | -0.90 | +0.28 | +0.34 | +0.17 |  +0.19 |  +0.81 |
| `render-limiter-on`                  | +1.65 | +0.38 | -0.66 | +0.44 | +0.61 | +0.45 |  +0.47 |  +1.09 |
| `render-limiter-ceiling`             | -1.31 | +0.23 | -0.77 | +0.62 | +0.45 | +0.30 |  +0.32 |  +0.87 |
| `render-playground-acid-line`        | +0.00 | +0.00 | +0.01 | -0.00 | +0.04 | +0.11 |  +0.12 |  +0.00 |
| `render-playground-acid-line-master` | +0.22 | +0.27 | +0.23 | +0.21 | +0.27 | +0.34 |  +0.24 |  +0.01 |
| `render-mix-four-bars`               | +0.09 | -0.40 | -0.14 | +0.33 | +0.23 | +0.10 |  +0.22 |  +0.25 |

## What still deviates, and why

Each cause below was isolated with a probe (a single note started at time 0 so that the first two causes do not apply, rendered in both engines, compared sample by sample), not guessed.

- **Chromium starts a voice that begins inside a render quantum at the wrong phase (not fixed; a browser quirk).** An oscillator whose `frequency` has a `setValueAtTime(f, t0)` event with `t0` not a multiple of 128 frames runs at the previous frequency (440 Hz) for the rest of that quantum. Measured in isolation: a sine at 164.8 Hz started at 0.25 s (frame 12000, 96 frames into a quantum) has 0.0576 at frame 1 where the specification gives 0.0216; started at 0 or on a quantum boundary it is exact. The engine always sets the frequency with such an event, so every voice that starts mid-quantum has another phase in Chromium. A single `e3` at time 0 matches to 2.6e-6; the same note at 0.25 s differs by up to 0.54. The effect is invisible in a whole-render RMS but changes the sum of overlapping voices (peaks) and, through where an envelope's kinks fall on the wave, the level of the quietest bands: the sine's bands above 1 kHz (at -70 to -80 dBFS) differ by 6 to 12 dB for this reason. It accounts for the remaining voice, pan-law, limiter-off, and mix differences (peak up to 1.4 dB, 2.75 dB for the filter sweep, whose resonant peaks add coherently). The Rust follows the specification and does not emulate it.
- **Chromium adds one render quantum (128 frames) to every pass through a delay feedback loop (not fixed; a browser quirk).** Echoes of the delay case start at 12001, 24129, 36257 frames in Chromium and 12001, 24001, 36001 in Rust. The first echo matches; later ones are 128 frames late per pass, so a window holding an echo edge differs by up to 3.9 dB, while RMS differs by only 0.40 dB. The specification clamps the delay time of a cycle to one quantum at minimum and adds nothing; the Rust follows it.
- **The master limiter differs (known by design).** Limiter-on cases: RMS +0.22 (limiter on), +0.10 (ceiling), +0.19 (Acid line), -0.11 dB (mix); peak +0.36, 0.00 (the ceiling holds exactly), +0.01, +1.41 dB. A loud chord pair starting at time 0 through the limiter, which the phase quirk does not touch, is +0.39 dB RMS and +0.26 dB peak, so this is the compressor's release and look-ahead, as `conformance/README.md` lists.
- **Band-limited oscillator tables differ in their partials near Nyquist (known by design).** The triangle's peak is -0.54 dB and the square and sawtooth peaks -0.16 and +0.34 dB with RMS within 0.1 dB; this is mixed with the phase quirk and was not separated.

What matches closely (single causes ruled out): white noise (0.0000 dB everywhere: the seeded noise buffers are identical), the envelope with a note at 0 (0.000 dB, band 0.098 dB at 8 kHz), the reverb (RMS -0.002 dB, peak -0.004 dB, worst window -0.09 dB: the convolver and its seeded impulse response are right), Acid line without the master (RMS +0.004 dB, peak +0.0001 dB, worst band 0.12 dB), and a swept low-pass on a note at 0 s (1.4e-4 relative sample error).

## Against the proposed tolerances

- **Limiter off, per case:** white noise and the envelope meet every proposed figure (RMS 0.000, peak 0.001 dB, band 0.098, window 0.000). The reverb meets RMS (0.002), peak (0.004), and band (0.094) and misses the window figure (0.090 against 0.05); Acid line meets RMS (0.004), peak (0.0001), and window (0.038) and misses the band (0.116 against 0.1). Everything with a mid-quantum voice start or a delay feedback misses, by the causes above. Worst: RMS 0.40 dB (delay), peak 2.75 dB (filter sweep), band 11.9 dB (the sine's quiet bands), window 3.9 dB (delay).
- **Limiter on:** RMS 0.10 to 0.22 dB against 0.05, peak 0.00 to 1.41 dB against 0.1; the ceiling case holds its peak exactly.

## Suggested final numbers (for the person to decide; nothing in CONFORMANCE.md has been loosened)

The proposed numbers are reachable for the cases the quirks do not touch, and not otherwise. The choices:

1. **Keep 0.01 / 0.02 / 0.1 / 0.05 dB, and re-record the layer 4 cases with every voice starting on a multiple of 128 frames and without delay feedback** (for example a cycle of 0.768 s at 48 kHz, 288 quanta). Then the browser's quirks do not apply and the tolerances test the renderer. The cost is cases that sound less like the playground.
2. **Or widen to what a mid-quantum start costs:** RMS 0.15 dB, peak 3 dB, band 1.5 dB above -60 dBFS (not -80), window 1.5 dB, and for the limiter on RMS 0.5 dB and peak 1.5 dB, with the delay feedback case excluded from the window check. These are only the measured worst values rounded up; they would not catch a real 1 dB error in a peak.

The recommendation is option 1 for the oscillator and filter cases and keeping a few musical cases (Acid line, the four-bar mix) at the wider numbers as smoke checks.

## Not verified

- No case was listened to; automated summaries cannot say how anything sounds.
- Chromium only, one version, one machine. Firefox and Safari were not run, so the quirks above are Chromium's, and `Q` and the built-in wave normalisation are as Chromium 149 does them.
- The limiter's release and look-ahead were left alone; the differences above are measured, not diagnosed further.
- Booking in windows (`bookingWindow`) was not compared (the cases book up front).
