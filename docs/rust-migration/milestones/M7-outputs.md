# M7: Outputs

## Objective

Undertone produces sound without Web Audio: natively in real time, in a browser `AudioWorklet` (opt-in), and in a no-browser render through WASI, Node, Bun, and Deno.

**Depends on:** RF-22 (M5) for native output, RF-22 and RF-25 (M6) for the worklet, RF-20 (M4) and RF-25 (M6) for the no-browser render. The native output can start before M6 finishes. **Done when:** each backend meets its acceptance.

## Work packages

### RF-28. Native real-time output (`undertone-native`, `cpal`)

- **Owner:** A. **Size:** M. **Depends on:** RF-22.
- **Objective:** a `Sink` trait after `Engine`, and `undertone-native` playing on `cpal` with a control thread booking windows into a lock-free ring (`rtrb` or `ringbuf`, licence checked with `cargo deny`, D-11) and pooled voices.
- **Steps:** (1) the `Sink` trait in the engine's output seam; (2) `crates/undertone-native` with the `cpal` stream, the ring, and the audio-thread runner; (3) an example `cargo run -p undertone-native --example play`; (4) **documentation:** rustdoc, and a "Playing natively" page in the Rust guide (`docs/guide/rust-native.md`).
- **Acceptance (formerly spike R7):** no underrun for ten minutes with every core busy; zero allocations on the audio thread (counted); position error under 1 ms; the example plays a pattern. State plainly whether it was listened to.
- **Risks:** device availability in CI (the soak test runs by hand on the person's machine, not in CI); the `cpal` licences and system libraries (checked by `cargo deny` and documented).

### RF-29. The worklet backend (`undertone-worklet`)

- **Owner:** A builds; P runs the device checks. **Size:** L. **Depends on:** RF-22, RF-25.
- **Objective:** an opt-in browser backend: `undertone-worklet` (raw C ABI, no `wasm-bindgen` glue, since the worklet scope lacks `TextDecoder`) inside an `AudioWorkletProcessor`; booking on a worker or the main thread; the main thread compiles the module and posts the `WebAssembly.Module` in `processorOptions`; a ring over `SharedArrayBuffer` when cross-origin isolated, `MessagePort` otherwise.
- **Steps:** (1) the raw-ABI crate over the engine; (2) the processor and the bridge's backend switch in `packages/undertone`; (3) a harness page that reports underruns, the 99th percentile of `process`, and drift; (4) **documentation:** a worklet section in `docs/guide/runtimes.md` (opt-in, cross-origin isolation, the foreign-leaf restriction), and the measured numbers.
- **Acceptance (formerly spike R6):** on a mid-range phone, a Steam Deck, and Chromium throttled six times (the person runs them with the harness page), no underrun over five minutes, the 99th percentile of `process` at most 40% of the 128-frame budget, drift zero against frames. If not met, the backend still ships as opt-in with the numbers documented, and Web Audio stays the default (D-09).
- **Risks:** the device checks need the person's time (batched into one request); a pattern with a foreign leaf cannot run in the worklet (refused with a diagnostic).

### RF-30. Rendering with no browser (WASI, Node, Bun, Deno)

- **Owner:** A. **Size:** S. **Depends on:** RF-20, RF-25.
- **Objective (formerly spike R8):** render a pattern to WAV under `wasmtime` (`wasm32-wasip1`, a small CLI in `crates/undertone/examples/` or `crates/undertone-cli`), and through the package in Node 20, Bun 1.2, and Deno with no Web Audio.
- **Steps:** (1) the WASI build and CLI; (2) the same render through the package in each runtime; (3) a CI job that builds the WASI target; (4) **documentation:** a "Rendering without a browser" section in `docs/guide/rendering-and-export.md` (and a Rust counterpart), with the commands.
- **Acceptance:** the same bits as the native render, or within R9's tolerance; a CI job builds the WASI target.

## Planned stack

Three pull requests, one work package each.

| #   | Branch                        | Pull request title                                     | Work package |
| --- | ----------------------------- | ------------------------------------------------------ | ------------ |
| 1   | `feat/native-output`          | Play patterns natively through the system audio device | RF-28        |
| 2   | `feat/worklet-backend`        | Add an opt-in AudioWorklet backend                     | RF-29        |
| 3   | `feat/render-without-browser` | Render patterns to WAV without a browser               | RF-30        |

## Documentation in this milestone

- Rustdoc for `undertone-native` and `undertone-worklet`; a native playing page in the Rust guide.
- Runtime notes extended to the worklet, WASI, Node, Bun, and Deno in `docs/guide/runtimes.md` and `docs/guide/rendering-and-export.md`.
- `README.md` API tables for any new entry point.
- `bun run docs:build` for every guide change.

## Agent assignments

The orchestrator assigns Sonnet agents. RF-28 can run while M6 is in review; RF-29 and RF-30 need the package. Device checks (N-3 in [HANDOFFS.md](../HANDOFFS.md)) are the person's.

## Status log

| Date       | Entry       |
| ---------- | ----------- |
| 2026-11-18 | Not started |
