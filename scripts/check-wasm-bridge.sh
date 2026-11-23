#!/usr/bin/env bash
# Runs the WebAssembly bridge job's checks, in the order CI runs them.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo clippy -p undertone-wasm -p undertone-wasm-render --target wasm32-unknown-unknown --locked -- -D warnings
bash scripts/build-wasm.sh
bun scripts/check-wasm-size.ts
for test in smoke layer1 layer2 booking layer3 layer4 wav worklet; do
	bun "crates/undertone-wasm/tests/js/${test}.ts"
done
