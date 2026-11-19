#!/usr/bin/env bash
# Builds the thin pattern binding into pkg/ (throwaway; never published)
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/undertone-spike-r5-target}" CARGO_INCREMENTAL=0
cargo build --release --target wasm32-unknown-unknown
rm -rf pkg && mkdir -p pkg
wasm-bindgen --target web --weak-refs --out-dir pkg --out-name r5_suite \
	"$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/r5_suite.wasm"
ls -l pkg/r5_suite_bg.wasm
