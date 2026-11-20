# M7 notes: what the outputs taught us

M7 gave Undertone three ways to make sound without Web Audio: natively in real time, in a browser `AudioWorklet` (opt-in), and in a render with no browser. Nothing was listened to. Every figure here comes from sample-for-sample comparisons, counted allocations, sizes, and one headless run. The device checks that RF-28 and RF-29 name as acceptance are the person's and have not been run.

## What was built, per pull request

The stack is #120, #121, #122, #124, and #126, in that order.

| PR   | Branch                        | What it delivered                                                                                                                                                                                                         |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #120 | `docs/m7-plan`                | The decisions D-47 to D-49 and the RF-29 changes in the M7 page.                                                                                                                                                          |
| #121 | `feat/native-output`          | RF-28: `crates/undertone-native`, a `Sink` seam, the `cpal` stream, device listing and selection, a ring-fed `Output`, the `play` example with a soak mode, the Rust guide page, and a native CI job on x86-64 and ARM64. |
| #122 | `feat/render-without-browser` | RF-30: `crates/undertone-cli` (`undertone-render`), a WASI build run under `wasmtime`, the same render through the package in Node, Bun, and Deno, two CI jobs, and the "Rendering without a browser" guide sections.     |
| #124 | `feat/worklet-backend`        | RF-29: `WorkletEngine` in the render module, the `./worklet` entry, a device harness page and a headless check, the guide section, and the render module's budget corrected to D-43's 120 KB.                             |
| #126 | `feat/worklet-fast-build`     | A speed-optimised build of the render crate for the worklet only (D-50), and `startCycle` so a worklet loop goes on from cycle to cycle (D-51).                                                                           |

## Where it stands

| Check                                     | Result                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native: no allocation on the audio thread | A counting allocator over 400 callback calls with underruns and 100 without: zero allocations and zero frees, with audio delivered                                                                        |
| Native: position against the sample clock | The stream is the player's own samples in place, sample for sample, and the first onset is within 1 ms (fake callback, no device)                                                                         |
| Native: open and close twice              | Passes on a machine with a sound card; skips where there is no device                                                                                                                                     |
| Native: ten minutes with every core busy  | **Not run.** `cargo run -p undertone-native --example play -- --soak-seconds 600 --busy-threads 16` is the person's run (it exits non-zero if anything underran). A 12 s run with 4 busy threads had none |
| No browser: WASI, Node, Bun, Deno         | Five cases (stereo 16-bit, noise, mono 24-bit, 32-bit float, six channels at 24-bit) are byte-identical across native Rust, `wasmtime` 51.0.0, and the package in Node 22, Bun 1.4, and Deno 2.9          |
| Worklet: streaming against offline        | `book` over N blocks equals one offline render bit for bit (stereo and 6 channels, blocks of 128 and 100); the fast and size builds render the same voices equal to the last bit                          |
| Worklet in real Chromium 156 (headless)   | Against `renderToBuffer`: light patterns exact, the representative pattern within 1.8e-7. A correctness check with no audio device                                                                        |
| Worklet: `process` timing                 | A headless desktop smoke run only: p99 about 9% of the 128-frame budget with the speed build, 41% with the size build. **Not the acceptance**                                                             |
| Worklet: phone, Steam Deck, throttled     | **Not run.** `bun packages/undertone/harness/serve.ts` and the page it prints (the guide has the phone steps); the limits are no underrun over five minutes, p99 at most 40%, and zero drift              |
| Module sizes after Brotli                 | Main 148.8 KB of 150 KB; render 100.1 KB of 120 KB; worklet 118.0 KB of 120 KB (its 108 KB warning fires every run, by design)                                                                            |
| Decisions                                 | D-47 to D-51                                                                                                                                                                                              |

## What changed in the plan

- **The worklet loads the render module, with no raw ABI.** D-47 kept D-45's `forbid(unsafe)`: a `TextDecoder` shim and the existing wasm-bindgen glue replaced the planned `undertone-worklet` crate.
- **The worklet plays booked voices only** (D-48), so patterns, foreign leaves, and the scheduler stay on the main thread. The cost is that a worklet loop depends on the main thread: passes are posted about 4 s ahead and polled every 100 ms, so a main-thread stall of more than about 4 s gaps the loop.
- **The native audio thread only copies from a ring.** The control thread renders about 0.1 s ahead, so a change made while playing is heard up to that late. Rendering voices on the audio thread would need the zero-allocation booking tick that D-34 deferred.
- **The render module's budget was wrong in the script.** `scripts/check-wasm-size.ts` enforced 150 KB for it while D-43 said 120 KB. It was found by the RF-29 agent and fixed in #124.
- **Chromium's `AudioWorkletGlobalScope` has no `performance`.** The processor times itself with a `SharedArrayBuffer` counter a page worker spins (`clock: 'spin'`), which needs cross-origin isolation. Other browsers' worklet scopes were not checked.

## Known limits

- **No `SharedArrayBuffer` voice ring.** Only the `MessagePort` path was built.
- **FreeBSD:** `cpal`'s output paths there are unverified; nothing is claimed and no job was added.
- **Node 22** is run by hand; CI has Node 24 only, and Node 20 is unsupported (D-42).
- **Seeds:** the WASI and package cases use `level-N` seeds; a plain `0` was not compared across Rust and the package.
- **Untested on GitHub until M7's PRs ran:** the ALSA install step, the pinned `wasmtime` and Deno installs. They passed.

## For the person to run

1. The native soak, on the machine that has the audio device: the command in the table above, then listen to the `play` example.
2. The worklet harness on a mid-range phone, a Steam Deck, and Chromium throttled six times, five minutes each, with the speed build the package ships.
3. Anything heard that sounds wrong goes back as a finding; no part of M7 has been listened to.
