#!/usr/bin/env bash
# Builds the throwaway skeleton bridge package into pkg/ and packs it into the spike tarball (never published)
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/undertone-spike-r3-target}" CARGO_INCREMENTAL=0
cargo build --release --target wasm32-unknown-unknown
rm -rf pkg && mkdir -p pkg/wasm
wasm-bindgen --target web --weak-refs --out-dir pkg/wasm --out-name r3_bridge \
	"$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/r3_bridge.wasm"
# Transpile the TypeScript entries in place (no bundling): the relative imports stay as they are.
bun build ts/api.ts ts/index.ts ts/init.ts ts/index.node.ts --no-bundle --outdir pkg --target browser >/dev/null
cp ts/index.d.ts pkg/index.d.ts
cat >pkg/package.json <<'J'
{
  "name": "@liminal-hq/undertone",
  "version": "0.0.0-r3-spike",
  "private": true,
  "description": "Throwaway spike R3 skeleton bridge. Never published.",
  "type": "module",
  "types": "./index.d.ts",
  "sideEffects": false,
  "exports": {
    ".": { "types": "./index.d.ts", "node": "./index.node.js", "default": "./index.js" },
    "./init": { "types": "./index.d.ts", "node": "./index.node.js", "default": "./init.js" }
  },
  "files": ["*.js", "*.d.ts", "wasm"]
}
J
(cd pkg && bun pm pack --quiet --destination .. 2>&1 | tail -3)
ls -l ./*.tgz
