# M4: Engine

## Objective

`undertone-engine` books voices on a `Graph` exactly as the TypeScript does (0.3.0 behaviour plus the 0.4.0 options), renders them in-house, and supports instruments, channels, scores, WAV output, and samples. It is written here from the TypeScript reference and the corpus; nothing is inherited (D-05).

**Depends on:** M3 (RF-14's `VoiceParams` and RF-15's pitch) and M2's R9 result (the maths module). **Done when:** corpus layers 3 and 4 are green on Rust.

The lab's `undertone-dsp` is prior art: it shows one way to organise voice booking, orbits, the master bus, and an in-house renderer, and may be read for design ideas. It is not copied, imported, or used as an oracle in the repository. Every behaviour lands with corpus cases recorded from `452f782`.

## Work packages

### RF-18. The voice graph and the 0.4.0 engine features

- **Owner:** A. **Size:** L (the earlier plan assumed an existing voice-booking engine; it is now built here, so this package is larger than the original M). **Depends on:** RF-05 (the graph recorder), RF-14 (`VoiceParams`), RF-08 (the maths module). (The 0.4.0 part is the former spike R10, done as work.)
- **Objective:** the engine books a voice on a `Graph` trait exactly as the TypeScript's `playParams` does, and implements 0.4.0's options: `panLaw` and `.panlaw(db)`, the master `ceiling`, `panPath` within a note, `.panpath`, `.panslide`, `.autopan` with depth, shape, and phase, and `bookingWindow`, including #39's review fixes (skipped voices left out of the windowed room-size look-ahead; the ceiling held after the tail is folded).
- **Steps:** (1) the `Graph` trait (`node`, `automate`, `connect`, `start`, `stop`, `buffer`, `periodic_wave`) and `LogGraph`, the recorder that produces the layer 3 format; (2) voice booking for every sound type and control the 0.3.0 engine handles (waveforms and shaped waves, ADSR, filter and its envelope, high-pass, phaser, pitch envelope and steps, FM, gain, slide, nudge, cut groups' graph part), orbits (reverb and delay buses), and the master bus with its limiter, read from `src/engine.ts`, `src/effects.ts`, `src/masterBus.ts`, and `src/waves.ts`; (3) the 0.4.0 features, read from `src/panPath.ts`, `src/autopan.ts`, `src/masterBus.ts`, and `src/render.ts` at `452f782`; (4) record every case in corpus layer 3, including a group `voices` of baseline cases for the 0.3.0 behaviours (about 60 cases, added to the recorder in this package) and the `placement` group; make them equal; (5) **documentation:** rustdoc for the `Graph` trait, `VoiceParams` booking, and each option, with the guide's wording on pan laws and the master ceiling.
- **Files:** `crates/undertone-engine/src/{graph,voice,master,effects,waves,pan,math}.rs`, `tests/corpus_graph.rs`, `conformance/recorder/graph.ts` and `conformance/cases/graph/**`.
- **Acceptance:** the baseline graph cases and the 40 `placement` cases byte for byte; with every new option off, the graph equals 0.3.0's (the baseline cases recorded in RF-05).
- **Risks:** the custom pan law sums stereo samples to mono (a documented limit in #39): copy it. Scope: say plainly in the pull request if the package should be split in two (baseline booking, then the 0.4.0 options), and use two pull requests in the stack if so.
- **Hand-off:** none.

### RF-19. Instruments and channels

- **Owner:** A. **Size:** M. **Depends on:** RF-18.
- **Objective:** `.voice(patch)`, `fmVoice(definition)`, `fmPresets` (`glassBell`, `roundBass`, `softPad`, `pluck`, `lead`), `layer(notes, voices, options)`, `SHAPED_WAVE_TYPES` and `isShapedWave`, `.channels(gains)`, `.surround(angle)`, `enableMultichannel`, `foldToStereo`, `surroundGains`, `CHANNEL_ORDER`, `MAX_CHANNELS`, and `createMonoFold`.
- **Steps:** (1) the instruments from `src/instruments.ts` (the studio's Rust glue has an `fm_voice` port in `crates/fizz-audio-undertone` in the studio repository: read it as a hint only, the reference is the TypeScript); (2) up to eight channels from the start (`MAX_CHANNELS = 8`), with the channel merger and the fold as the TypeScript books them, read from `src/surround.ts` and `src/monoFold.ts`; (3) **documentation:** rustdoc, and note any gap against `docs/guide/instruments-and-scores.md` and `docs/guide/stereo-and-surround.md`.
- **Acceptance:** corpus groups `instruments`, `channels` green, including 4, 6, and 8 channels.

### RF-20. Score, the in-house renderer, offline render from a pattern, WAV

- **Owner:** A. **Size:** L (it now includes the renderer). **Depends on:** RF-15, RF-18.
- **Objective:** `score({ ticksPerSecond, lengthTicks, events, seam, panLaw })` with `.loop`, `.play`, `.render`; the in-house renderer that turns booked graphs into samples; `renderToBuffer(pattern, options)` and `.render()` for patterns; `encodeWav(source, { bitDepth, dither, seed, channelMask })`.
- **Steps:** (1) `RenderGraph` and `Engine`: a `Graph` implementation that renders the booked nodes (oscillators and periodic waves, buffer sources, gain, biquad filters, delay, convolver, panners and channel mergers, the master compressor and limiter) streaming in any block size, using the maths module from R9; (2) pattern to score events (query the cycles, collect onsets, resolve params); (3) `RenderOptions` with every field of 0.4.0 (`cycles`, `seconds`, `bpm`, `cps`, `sampleRate`, `channels`, `tail`, `wrap`, `seed`, `gated`, `master`, `bookingWindow`); `context` is the bridge's concern (RF-26); (4) the WAV encoder from `src/wav.ts`, byte for byte; (5) the browser reference renders for layer 4, made by hand with `conformance/recorder/browser-render.ts` ([CONFORMANCE.md](../CONFORMANCE.md#golden-renders-and-tolerances)); (6) **documentation:** rustdoc, and a runnable example that renders a pattern to a WAV.
- **Acceptance:** corpus layer 4 (renders) within the tolerances in [CONFORMANCE.md](../CONFORMANCE.md#golden-renders-and-tolerances); WAV bytes equal the TypeScript's for the same samples. Nothing is listened to: say so.
- **Risks:** the browser's convolver and compressor differ by design (the tolerances allow for it); the renderer's cost on the person's disk and CPU (one render job at a time).

### RF-21. Samples

- **Owner:** A. **Size:** M. **Depends on:** RF-20.
- **Objective:** the sample registry (`registerSample`, `registerSamples`, `loadSamples`, `getSampleBuffer`, `getSampleBaseNote`, `isSampleRegistered`, `clearSamples`) and sample voices in the engine. Decoding stays with the host: Rust takes PCM.
- **Acceptance:** corpus group `samples` green (graph cases with a buffer source and its playback rate from `baseNote`).
- **Documentation:** rustdoc, and note how Rust callers supply PCM (the guide's `docs/guide/samples.md` covers the JavaScript loading).

## Planned stack

Four pull requests, one work package each (add a fifth if RF-18 is split as its risk note allows).

| #   | Branch                                 | Pull request title                                                    | Work package |
| --- | -------------------------------------- | --------------------------------------------------------------------- | ------------ |
| 1   | `feat/engine-voice-graph`              | Book voices on a graph in Rust, with the 0.4.0 pan and master options | RF-18        |
| 2   | `feat/engine-instruments-and-channels` | Add instruments and up to eight channels in Rust                      | RF-19        |
| 3   | `feat/engine-score-and-render`         | Add the score, the in-house renderer, and WAV output in Rust          | RF-20        |
| 4   | `feat/engine-samples`                  | Add sample voices in Rust                                             | RF-21        |

## Documentation in this milestone

- Rustdoc with runnable examples for `undertone-engine`; `cargo doc` with `-D warnings`.
- Update [API-MAPPING.md](../API-MAPPING.md) statuses and [CONFORMANCE.md](../CONFORMANCE.md) group counts (add the `voices` group).
- Notes on any mismatch between the guide's description and the reference behaviour, raised with the person rather than silently corrected.
- The Rust guide section is written in M5 on top of this rustdoc.

## Agent assignments

The orchestrator assigns Sonnet agents. RF-18 first (and alone, because it is large and builds Rust); RF-19 and RF-21's prerequisites follow; RF-20 depends on RF-15 and RF-18. At most 2 Rust-building agents at once; render jobs run one at a time.

## Status log

| Date       | Entry                                                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Not started                                                                                                                                                                                                                                                                                     |
| 2026-11-19 | RF-18, first slice: the `Graph` trait and `LogGraph` (the layer 3 recorder in Rust) are in `undertone-engine::graph`, with a layer 3 runner whose `placement` group is pending until voice booking lands; 41 of the 50 recorded `placement` graphs replay through the trait to the corpus bytes |
