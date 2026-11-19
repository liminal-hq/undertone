#!/usr/bin/env bash
# Throwaway spike R4: clean release build timings (empty target dir before each).
export CARGO_TARGET_DIR=/home/scott/.cache/undertone-spike-r4-target CARGO_INCREMENTAL=0
cd "$(dirname "$0")"
for what in "-p r4-control -p r4-worklet" "-p r4-control" "-p r4-worklet"; do
	rm -rf "$CARGO_TARGET_DIR"
	echo "== clean: $what"
	python3 timeit.py cargo build --release --target wasm32-unknown-unknown $what 2>&1 | tail -1
done
du -sh "$CARGO_TARGET_DIR"
