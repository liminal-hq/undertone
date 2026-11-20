#!/usr/bin/env bash
# Builds the two WebAssembly modules into packages/undertone/wasm/ (main) and wasm/render/ (render): cargo, wasm-bindgen, wasm-opt, sizes
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0

# Two modules (docs/rust-migration/results/M6-BOUNDARY.md, sections 9 and 13): the main module (crates/undertone-wasm, the
# glue `undertone_wasm.js`) and the lazily loaded render module (crates/undertone-wasm-render, `render/undertone_wasm_render.js`).
# Steps, for each:
#   1. the `wasm-bindgen` CLI must be the version the crate pins (`wasm-bindgen = "=X"` in crates/undertone-wasm/Cargo.toml),
#      or the generated glue would not match the module; a mismatch stops here and prints the install command;
#   2. `cargo build --profile wasm --target wasm32-unknown-unknown -p <crate>` (the root Cargo.toml's `wasm` profile), both crates
#      in one cargo call;
#   3. `wasm-bindgen --target web --weak-refs` into the module's directory (the glue, its `.d.ts`, and `<name>_bg.wasm`);
#   4. `wasm-opt -Oz` in place, from the `binaryen` npm package pinned by scripts/wasm-opt/ (installed with its lockfile's
#      integrity hash on first use; runs under Bun), with exactly the WebAssembly features rustc 1.98 emits for
#      wasm32-unknown-unknown enabled (the list below). Not `-all` (R4's flag): binaryen 132's `-all` includes the compact
#      import section, which Node 22 and Bun 1.4 refuse to compile ("unknown import kind 0x7f"); R4 never ran its module;
#   5. the raw, gzip, and Brotli sizes of both (scripts/check-wasm-size.ts --report; the budget check itself is a separate CI step).
#
# Needs cargo with the wasm32-unknown-unknown target, the wasm-bindgen CLI, jq, and Bun. Respects CARGO_TARGET_DIR. Run from anywhere.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

crate=crates/undertone-wasm
render_crate=crates/undertone-wasm-render
out=packages/undertone/wasm
tools=scripts/wasm-opt

pin="$(sed -n 's/^wasm-bindgen = "=\([0-9.]*\)".*$/\1/p' "${crate}/Cargo.toml")"
if [[ -z "${pin}" ]]; then
	echo "build-wasm: ${crate}/Cargo.toml must pin wasm-bindgen exactly (wasm-bindgen = \"=X.Y.Z\")" >&2
	exit 1
fi
have="$( (wasm-bindgen --version 2>/dev/null || true) | awk '{ print $2 }')"
render_pin="$(sed -n 's/^wasm-bindgen = "=\([0-9.]*\)".*$/\1/p' "${render_crate}/Cargo.toml")"
if [[ "${render_pin}" != "${pin}" ]]; then
	echo "build-wasm: ${render_crate} pins wasm-bindgen ${render_pin:-nothing}, but ${crate} pins ${pin}; they must match" >&2
	exit 1
fi
if [[ "${have}" != "${pin}" ]]; then
	echo "build-wasm: the wasm-bindgen CLI is '${have:-not installed}', but ${crate} pins ${pin}. Install the pinned CLI with:" >&2
	echo "  cargo install wasm-bindgen-cli --version =${pin} --locked" >&2
	exit 1
fi

target_dir="$(cargo metadata --format-version 1 --no-deps --locked | jq -r .target_directory)"
cargo build --locked --target wasm32-unknown-unknown --profile wasm -p undertone-wasm -p undertone-wasm-render

if [[ ! -f "${tools}/node_modules/binaryen/bin/wasm-opt" ]]; then
	bun install --frozen-lockfile --cwd "${tools}"
fi
features=(
	--enable-bulk-memory --enable-bulk-memory-opt --enable-call-indirect-overlong --enable-multivalue
	--enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext
)

# <crate's library name> <output directory>
for module in "undertone_wasm ${out}" "undertone_wasm_render ${out}/render"; do
	read -r name dir <<<"${module}"
	mkdir -p "${dir}"
	rm -f "${dir}/${name}".js "${dir}/${name}".d.ts "${dir}/${name}"_bg.wasm "${dir}/${name}"_bg.wasm.d.ts
	wasm-bindgen --target web --weak-refs --out-dir "${dir}" --out-name "${name}" "${target_dir}/wasm32-unknown-unknown/wasm/${name}.wasm"
	bun "${tools}/node_modules/binaryen/bin/wasm-opt" -Oz "${features[@]}" "${dir}/${name}_bg.wasm" -o "${dir}/${name}_bg.wasm"
done

bun scripts/check-wasm-size.ts --report
