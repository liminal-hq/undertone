# `packages/undertone/wasm/`

Build output: the WebAssembly control module of `@liminal-hq/undertone` and its `wasm-bindgen` glue, written by `scripts/build-wasm.sh` from `crates/undertone-wasm` (RF-24). Nothing here but this file and `.gitignore` is committed.

- `undertone_wasm_bg.wasm`: the module, after `wasm-opt -Oz -all`; `scripts/check-wasm-size.ts` holds it to 150 KB after Brotli (D-07).
- `undertone_wasm.js` and `undertone_wasm.d.ts`: the glue (`--target web --weak-refs`), which the bridge package wraps (RF-25). The exports and the rules they follow are in `docs/rust-migration/results/M6-BOUNDARY.md`.

The package around this directory (`package.json`, the TypeScript wrappers, loading) arrives in RF-25.
