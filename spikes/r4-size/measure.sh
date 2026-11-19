#!/usr/bin/env bash
# Throwaway spike R4: build one module, run wasm-bindgen (control only) and wasm-opt, print raw/gzip -9/Brotli 11 sizes.
# Usage: measure.sh <control|worklet> <label> [cargo feature flags...]
# Env: CARGO_PROFILE_RELEASE_OPT_LEVEL (z by default), WOPT (default -Oz; "none" skips wasm-opt).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
module="$1"; label="$2"; shift 2
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/home/scott/.cache/undertone-spike-r4-target}"
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
wopt="${WOPT:--Oz}"
out="$here/out/$label"; rm -rf "$out"; mkdir -p "$out"
start=$(date +%s.%N)
cargo build --release --target wasm32-unknown-unknown --manifest-path "$here/Cargo.toml" -p "r4-$module" "$@" 2>&1 | tail -2
end=$(date +%s.%N)
src="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/r4_$module.wasm"
if [ "$module" = control ]; then
	wasm-bindgen --target web --weak-refs --out-dir "$out/bg" "$src" >/dev/null
	wasm="$out/bg/r4_control_bg.wasm"
else
	wasm="$src"
fi
raw0=$(stat -c %s "$wasm")
if [ "$wopt" != none ]; then
	"$here/node_modules/.bin/wasm-opt" $wopt -all "$wasm" -o "$out/final.wasm"
else
	cp "$wasm" "$out/final.wasm"
fi
f="$out/final.wasm"
raw=$(stat -c %s "$f"); gz=$(gzip -9 -c "$f" | wc -c); br=$(brotli -q 11 -c "$f" | wc -c)
line="$module | $label | cargo $(printf '%.1f' "$(echo "$end - $start" | bc)") s | pre-opt $raw0 | raw $raw | gzip9 $gz | brotli11 $br"
if [ "$module" = control ]; then
	js="$out/bg/r4_control.js"
	line="$line | glue-js $(stat -c %s "$js") glue-brotli $(brotli -q 11 -c "$js" | wc -c)"
fi
echo "$line" | tee -a "$here/out/results.txt"
