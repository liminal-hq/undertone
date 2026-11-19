#!/usr/bin/env bash
# Checks the crate layering rules of the Cargo workspace from `cargo metadata`
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0

# Rules:
#   - undertone-pattern depends on no other workspace crate.
#   - undertone-engine depends on no workspace crate except undertone-pattern.
#   - undertone-sched depends on no workspace crate except undertone-pattern and undertone-engine.
#   - A crate may list itself as a dev-dependency (to turn on its own features in tests).
#   - No crate depends on a git source or a path outside this workspace.
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
  "undertone-sched": ["undertone-pattern", "undertone-engine"]
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

echo "Crate layering OK."
