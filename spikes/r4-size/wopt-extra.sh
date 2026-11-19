#!/usr/bin/env bash
# Throwaway spike R4: extra wasm-opt flag experiments on the baseline modules; prints sizes and wasm-opt time.
cd "$(dirname "$0")"
export CARGO_TARGET_DIR=/home/scott/.cache/undertone-spike-r4-target CARGO_INCREMENTAL=0
cargo build --release --target wasm32-unknown-unknown -p r4-control -p r4-worklet 2>&1 | tail -1
wasm-bindgen --target web --weak-refs --out-dir out/extra-bg "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/r4_control.wasm" >/dev/null
for m in "control out/extra-bg/r4_control_bg.wasm" "worklet $CARGO_TARGET_DIR/wasm32-unknown-unknown/release/r4_worklet.wasm"; do
	set -- $m
	for flags in "-Oz" "-Oz --converge" "-O3 --converge" "-Oz --converge --zero-filled-memory --low-memory-unused"; do
		s=$(date +%s.%N)
		node_modules/.bin/wasm-opt $flags -all "$2" -o out/x.wasm
		e=$(date +%s.%N)
		echo "$1 | wasm-opt $flags | $(printf '%.1f' "$(echo "$e - $s" | bc)") s | raw $(stat -c %s out/x.wasm) | brotli11 $(brotli -q 11 -c out/x.wasm | wc -c)"
	done
done
