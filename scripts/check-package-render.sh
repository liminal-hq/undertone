#!/usr/bin/env bash
# Renders the RF-30 cases through the built package in Node, Bun, and Deno with no Web Audio, and compares them with the native Rust render
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0

# REFDIR holds the native WAV files that scripts/check-wasi-render.sh writes. Needs the built package (`bun run package:build`).
# A runtime that is not installed is skipped and said so, unless REQUIRE_RUNTIMES lists it (for example `REQUIRE_RUNTIMES="node bun deno"`
# in CI), in which case its absence fails the check.
# Usage: scripts/check-package-render.sh REFDIR

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ref="${1:?usage: check-package-render.sh REFDIR}"
required=" ${REQUIRE_RUNTIMES:-} "

if [[ ! -f packages/undertone/dist/index.node.js ]]; then
	echo "check-package-render: the package is not built; run 'bun run package:build' first" >&2
	exit 1
fi

failed=0
for runtime in node bun deno; do
	if ! command -v "${runtime}" >/dev/null; then
		if [[ "${required}" == *" ${runtime} "* ]]; then
			echo "FAIL ${runtime} is required and not installed" >&2
			failed=1
		else
			echo "skip ${runtime} is not installed"
		fi
		continue
	fi
	echo "== ${runtime}"
	if [[ "${runtime}" == "deno" ]]; then
		deno run -A scripts/render-without-browser.mjs "${ref}" || failed=1
	else
		"${runtime}" scripts/render-without-browser.mjs "${ref}" || failed=1
	fi
done

exit "${failed}"
