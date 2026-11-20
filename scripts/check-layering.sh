#!/usr/bin/env bash
# Checks the crate layering rules of the Cargo workspace from `cargo metadata`
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0

# Rules:
#   - undertone-pattern depends on no other workspace crate.
#   - undertone-engine depends on no workspace crate except undertone-pattern.
#   - undertone-sched depends on no workspace crate except undertone-pattern and undertone-engine.
#   - undertone (the facade) depends on no workspace crate except undertone-pattern, undertone-engine, and
#     undertone-sched; nothing below it may depend on it (the three rules above leave it out of their lists).
#   - undertone-wasm (the WebAssembly main module) and undertone-wasm-render (the lazily loaded render module) depend
#     on no workspace crate except undertone, the facade, and undertone-pattern (directly only to turn on its
#     `host-number-format` feature in the WebAssembly build); nothing depends on either (no rule lists them), and the
#     render module does not depend on the main module (they share source files with `#[path]`, not a crate).
#   - A crate may list itself as a dev-dependency (to turn on its own features in tests).
#   - No crate depends on a git source or a path outside this workspace.
#   - Nothing under crates/*/src uses `unsafe` (a block, fn, impl, trait, or extern) or lifts the lint with
#     `allow(unsafe_code)` or `expect(unsafe_code)`. `undertone-sched` sets `unsafe_code = "deny"` (not
#     `forbid`) so its allocation test can opt in, which would let a `src/` module opt in just as quietly;
#     this check closes that. Lines that are comments are ignored.
#
# Needs `cargo` and `jq` (both are in the shared ci-rust image). Run from anywhere.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

metadata="$(cargo metadata --format-version 1 --no-deps --locked)"

# Rule table: crate name, then the workspace crates it may depend on.
# A workspace crate that is not listed here may depend on any workspace crate.
# Add a row when a new crate has a layering rule.
allowed_workspace_deps='{
  "undertone-pattern": [],
  "undertone-engine": ["undertone-pattern"],
  "undertone-sched": ["undertone-pattern", "undertone-engine"],
  "undertone": ["undertone-pattern", "undertone-engine", "undertone-sched"],
  "undertone-wasm": ["undertone", "undertone-pattern"],
  "undertone-wasm-render": ["undertone", "undertone-pattern"]
}'

violations="$(
	jq -r --argjson allowed "${allowed_workspace_deps}" '
		. as $m
		| ($m.workspace_root) as $root
		| [.packages[].name] as $members
		| .packages[] as $p
		| $p.dependencies[]
		| . as $d
		| (
			if ($members | index($d.name)) != null
				and ($d.name != $p.name)
				and ($allowed[$p.name] != null)
				and (($allowed[$p.name] | index($d.name)) == null)
			then "\($p.name) must not depend on workspace crate \($d.name)" else empty end,
			if ($d.source // "" | startswith("git+"))
			then "\($p.name) depends on git source \($d.source) (\($d.name))" else empty end,
			if ($d.path != null) and (($d.path + "/") | startswith($root + "/") | not)
			then "\($p.name) depends on \($d.name) at \($d.path), outside the workspace" else empty end
		)
	' <<<"${metadata}"
)"

if [[ -n "${violations}" ]]; then
	echo "Crate layering violations:" >&2
	echo "${violations}" | sed 's/^/  - /' >&2
	exit 1
fi

# Unsafe code under src/. Comment lines (`//`, `///`, `//!`) are dropped before matching.
unsafe_uses="$(
	grep -rnE --include='*.rs' \
		-e '\bunsafe[[:space:]]*(\{|fn\b|impl\b|trait\b|extern\b)' \
		-e '(allow|expect)[[:space:]]*\([^)]*unsafe_code' \
		crates/*/src 2>/dev/null |
		grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' || true
)"

if [[ -n "${unsafe_uses}" ]]; then
	echo "Unsafe code under crates/*/src (only the allocation test may use it):" >&2
	echo "${unsafe_uses}" | sed 's/^/  - /' >&2
	exit 1
fi

echo "Crate layering OK, and no unsafe code under crates/*/src."
