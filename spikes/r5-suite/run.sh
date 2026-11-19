#!/usr/bin/env bash
# Builds the two bridges, runs the reference's suite against each, and writes results/*.txt (throwaway spike)
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0
# Needs `bun install` at the repository root (vitest) and wasm-bindgen CLI 0.2.125.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/undertone-spike-r5-target}" CARGO_INCREMENTAL=0
tmp="$(mktemp -d)"
./build.sh
# The R3 skeleton as built: its wasm, then its TypeScript transpiled in place (nothing under ../r3-bridge changes).
(cd ../r3-bridge && cargo build --release --target wasm32-unknown-unknown --locked)
rm -rf skeleton/pkg && mkdir -p skeleton/pkg/wasm
wasm-bindgen --target web --weak-refs --out-dir skeleton/pkg/wasm --out-name r3_bridge \
	"$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/r3_bridge.wasm"
bun build ../r3-bridge/ts/api.ts ../r3-bridge/ts/index.node.ts --no-bundle --outdir skeleton/pkg --target browser >/dev/null
cd ../..
R5_BRIDGE=binding npx vitest run --config spikes/r5-suite/vitest.config.ts --reporter=json --outputFile="$tmp/binding.json" >/dev/null 2>&1 || true
R5_BRIDGE=skeleton npx vitest run --config spikes/r5-suite/vitest.config.ts --reporter=json --outputFile="$tmp/skeleton.json" >/dev/null 2>&1 || true
covered=src/pattern.test.ts,src/mini.test.ts,src/signal.test.ts,src/control.test.ts,src/pitch.test.ts,src/fraction.test.ts,conformance/recorder/properties.test.ts
mkdir -p spikes/r5-suite/results
bun spikes/r5-suite/report.mjs "$tmp/binding.json" "$covered" >spikes/r5-suite/results/binding.txt
bun spikes/r5-suite/report.mjs "$tmp/skeleton.json" src/pitch.test.ts >spikes/r5-suite/results/skeleton.txt
echo "wrote spikes/r5-suite/results/binding.txt and skeleton.txt"
