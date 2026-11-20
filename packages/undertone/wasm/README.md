# `packages/undertone/wasm/`

Build output: the two WebAssembly modules of `@liminal-hq/undertone` and their `wasm-bindgen` glue, written by `scripts/build-wasm.sh` from `crates/undertone-wasm` and `crates/undertone-wasm-render` (RF-24). Nothing here but this file and `.gitignore` is committed.

- `undertone_wasm_bg.wasm`: the main module (patterns, controls, instruments, score data, the booking, the scheduler), after `wasm-opt -Oz`; `scripts/check-wasm-size.ts` holds it to 150 KB after Brotli (D-07).
- `undertone_wasm.js` and `undertone_wasm.d.ts`: its glue (`--target web --weak-refs`), which the bridge package wraps (RF-25).
- `render/undertone_wasm_render_bg.wasm`, `render/undertone_wasm_render.js`, `render/undertone_wasm_render.d.ts`: the render module (offline rendering, the booking on a caller's offline context, WAV), loaded with a dynamic `import()` on the first render; held to 150 KB after Brotli as well.

The exports of both and the rules they follow are in `docs/rust-migration/results/M6-BOUNDARY.md`. The package around this directory (`package.json`, the TypeScript wrappers in `src/`, the entries and loading) is `packages/undertone/`; build it with `bun run package:build`.
