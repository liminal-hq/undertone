# Worklet harness

Browser pages for measuring the package's AudioWorklet backend and the engines behind it, on a real device and browser. They are plain scripts with no bundler: build the package first (`bun run package:build` at the repository root), then serve `packages/undertone/`.

## Serving

`bun packages/undertone/harness/serve.ts [--port 8080] [--host 0.0.0.0] [--not-isolated]` serves the package folder (`/harness/`, `/dist/`, `/wasm/`) cross-origin isolated, which the harness needs for its worklet clock (`SharedArrayBuffer`). An AudioWorklet needs a secure context: `localhost` is one, and for a phone use `adb reverse tcp:8080 tcp:8080` or put the page behind https.

`serve.ts` serves files only. A page that finishes a run POSTs its numbers as JSON to `/results`; when the server has no such route the status line says so and the Copy results button holds the same JSON. A longer-running server (such as one on a LAN, collecting results from several devices) can accept the POST and file it by its `label`.

## Pages

- `index.html`: plays one pattern in a loop through the worklet and shows underruns, the 99th percentile block time and the block budget. Listen as well as read.
- `matrix.html`: runs the speed probe and then the light, representative and heavy patterns one after another; the run-all page for a device.
- `probe.html`: times a JavaScript loop on the page, the same in a worker, and a short offline render, to tell a slow JavaScript engine from slow WebAssembly. Silent.
- `check.html`: the correctness check (`check.ts` runs it in headless Chromium): the worklet's output against the offline render, sample for sample.
- `profile.html`: a ladder of small patterns (nothing, dry voices, reverb, delay) timed through the worklet, so the differences between steps show a device's hot spots.
- `experiments.html`: the reverb steps of the ladder under different worklet module builds and context settings, each beside a control run. Needs the variant builds (see below).
- `bench.html`: the paths we would ship (current module, SIMD, a 32 kHz context, a smaller reverb room) on the representative and heavy songs, repeated at the end to show drift. Needs the variant builds.
- `headtohead.html`: the TypeScript reference engine against the Rust and WebAssembly engine on the same songs, by offline render speed, plus main-thread jitter in real time. The WebAssembly engine has three rows per song, one crate built three ways: the size build (the render module `renderToBuffer` loads), the speed build and the SIMD speed build (the worklet modules, whose glue and module the page loads itself and calls `renderVoices` on with the same inputs). It checks the speed and SIMD renders sample for sample against the size build's, and skips the SIMD row, with a note, where `WebAssembly.validate` rejects SIMD. Needs the reference build (see below) and the worklet builds in `wasm/worklet/`.

`patterns.js` holds the three songs (light, representative, heavy) as a function of an engine's `note`, `sound` and `stack`; `harness.js` and `summary.js` are shared code.

## Variant builds

`experiments.html` and `bench.html` load worklet builds from `wasm/variants/<id>/undertone_worklet.js` and `undertone_worklet_bg.wasm` (ids such as `baseline` and `simd-b8`). They are experiment builds, not committed and not made by `package:build`; whoever serves the harness puts them there. A missing variant shows as a failed row.

## The TypeScript reference

`headtohead.html` imports the root reference engine as a browser module from `harness/reference/` (git-ignored). Run `scripts/harness-reference.sh` at the repository root to build it (`bun run build`) and copy the root `dist/` there. The page says so when the folder is missing.
