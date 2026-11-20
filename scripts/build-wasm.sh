#!/usr/bin/env bash
# Builds the WebAssembly control module into packages/undertone/wasm/: cargo, wasm-bindgen, wasm-opt, then the sizes
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0

# Steps (docs/rust-migration/results/M6-BOUNDARY.md, section 9):
#   1. the `wasm-bindgen` CLI must be the version the crate pins (`wasm-bindgen = "=X"` in crates/undertone-wasm/Cargo.toml),
#      or the generated glue would not match the module; a mismatch stops here and prints the install command;
#   2. `cargo build --profile wasm --target wasm32-unknown-unknown -p undertone-wasm` (the root Cargo.toml's `wasm` profile);
#   3. `wasm-bindgen --target web --weak-refs` into packages/undertone/wasm/ (the glue `undertone_wasm.js`, its `.d.ts`, and
#      `undertone_wasm_bg.wasm`);
#   4. `wasm-opt -Oz` in place, from the `binaryen` npm package pinned by scripts/wasm-opt/ (installed with its lockfile's
#      integrity hash on first use; runs under Bun), with exactly the WebAssembly features rustc 1.98 emits for
#      wasm32-unknown-unknown enabled (the list below). Not `-all` (R4's flag): binaryen 132's `-all` includes the compact
#      import section, which Node 22 and Bun 1.4 refuse to compile ("unknown import kind 0x7f"); R4 never ran its module;
#   5. the raw, gzip, and Brotli sizes (scripts/check-wasm-size.ts --report; the budget check itself is a separate CI step).
#
# Needs cargo with the wasm32-unknown-unknown target, the wasm-bindgen CLI, jq, and Bun. Respects CARGO_TARGET_DIR. Run from anywhere.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

crate=crates/undertone-wasm
out=packages/undertone/wasm
tools=scripts/wasm-opt

pin="$(sed -n 's/^wasm-bindgen = "=\([0-9.]*\)".*$/\1/p' "${crate}/Cargo.toml")"
if [[ -z "${pin}" ]]; then
	echo "build-wasm: ${crate}/Cargo.toml must pin wasm-bindgen exactly (wasm-bindgen = \"=X.Y.Z\")" >&2
	exit 1
fi
have="$( (wasm-bindgen --version 2>/dev/null || true) | awk '{ print $2 }')"
if [[ "${have}" != "${pin}" ]]; then
	echo "build-wasm: the wasm-bindgen CLI is '${have:-not installed}', but ${crate} pins ${pin}. Install the pinned CLI with:" >&2
	echo "  cargo install wasm-bindgen-cli --version =${pin} --locked" >&2
	exit 1
fi

target_dir="$(cargo metadata --format-version 1 --no-deps --locked | jq -r .target_directory)"
cargo build --locked --target wasm32-unknown-unknown --profile wasm -p undertone-wasm
module="${target_dir}/wasm32-unknown-unknown/wasm/undertone_wasm.wasm"

rm -f "${out}"/undertone_wasm*
wasm-bindgen --target web --weak-refs --out-dir "${out}" --out-name undertone_wasm "${module}"

if [[ ! -f "${tools}/node_modules/binaryen/bin/wasm-opt" ]]; then
	bun install --frozen-lockfile --cwd "${tools}"
fi
features=(
	--enable-bulk-memory --enable-bulk-memory-opt --enable-call-indirect-overlong --enable-multivalue
	--enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext
)
bun "${tools}/node_modules/binaryen/bin/wasm-opt" -Oz "${features[@]}" "${out}/undertone_wasm_bg.wasm" -o "${out}/undertone_wasm_bg.wasm"

bun scripts/check-wasm-size.ts --report "${out}/undertone_wasm_bg.wasm"
