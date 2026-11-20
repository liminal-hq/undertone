#!/usr/bin/env bash
# Renders the RF-30 cases natively and under wasmtime (wasm32-wasip1), and fails unless the WAV files are identical bytes
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0

# The native files are the reference the package check (check-package-render.sh) compares against, so they are kept in OUTDIR.
# Needs cargo with the wasm32-wasip1 target, and wasmtime (WASMTIME names the binary; default `wasmtime`). Respects CARGO_TARGET_DIR.
# Usage: scripts/check-wasi-render.sh [OUTDIR]     OUTDIR defaults to target/render-reference
#
# Nothing here listens to the audio: it asserts that two builds of one engine write the same bytes.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
cases=scripts/render-without-browser-cases.json

wasmtime="${WASMTIME:-wasmtime}"
if ! command -v "${wasmtime}" >/dev/null; then
	echo "check-wasi-render: ${wasmtime} is not installed (set WASMTIME to its path)" >&2
	exit 1
fi

out="${1:-target/render-reference}"
mkdir -p "${out}"
out="$(cd "${out}" && pwd)"
rm -f "${out}"/*.wav "${out}"/wasi-*.wav

target_dir="${CARGO_TARGET_DIR:-target}"
cargo build --release --locked -p undertone-cli
cargo build --release --locked -p undertone-cli --target wasm32-wasip1
native="${target_dir}/release/undertone-render"
wasi="${target_dir}/wasm32-wasip1/release/undertone-render.wasm"

echo "wasmtime: $("${wasmtime}" --version)"
failed=0
count=0
while IFS=$'\t' read -r name kind pattern wave seconds bpm rate channels depth seed; do
	count=$((count + 1))
	args=("--${kind}" "${pattern}" --seconds "${seconds}" --bpm "${bpm}" --rate "${rate}" --channels "${channels}" --bit-depth "${depth}" --seed "${seed}")
	[[ "${kind}" == "note" ]] && args+=(--wave "${wave}")

	"${native}" "${args[@]}" --out "${out}/${name}.wav" 2>/dev/null
	# The WASI build reads and writes only the directory it is given (`--dir`), so the file is written under OUTDIR.
	"${wasmtime}" run --dir "${out}" "${wasi}" "${args[@]}" --out "${out}/wasi-${name}.wav" 2>/dev/null

	if cmp -s "${out}/${name}.wav" "${out}/wasi-${name}.wav"; then
		echo "ok   ${name}: $(wc -c <"${out}/${name}.wav") bytes, native and wasmtime identical"
	else
		echo "FAIL ${name}: native and wasmtime differ" >&2
		cmp -l "${out}/${name}.wav" "${out}/wasi-${name}.wav" | wc -l | sed 's/^/     differing bytes: /' >&2
		failed=1
	fi
	rm -f "${out}/wasi-${name}.wav"
done < <(jq -r '.[] | [.name, .kind, .pattern, (.wave // "-"), .seconds, .bpm, .rate, .channels, .bitDepth, .seed] | @tsv' "${cases}")

if ((failed)); then exit 1; fi
echo "check-wasi-render: all ${count} renders are identical"
