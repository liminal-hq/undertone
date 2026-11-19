#!/usr/bin/env bash
# Runs the R2 measurements in Node, Bun, and Deno, writing JSON to the directory given as $1
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
out="${1:?output directory}"
mkdir -p "$out"
for settle in idle churn gc; do
	node --expose-gc ts/run-server.ts --settle=$settle >"$out/node-$settle.json"
	bun ts/run-server.ts --settle=$settle >"$out/bun-$settle.json"
	deno run --allow-read --v8-flags=--expose-gc ts/run-server.ts --settle=$settle >"$out/deno-$settle.json"
done
# Leak check: collect inside the loop too, five repeats.
node --expose-gc ts/run-server.ts --settle=gc --gc-in-loop --repeats=5 >"$out/node-leak.json"
bun ts/run-server.ts --settle=gc --gc-in-loop --repeats=5 >"$out/bun-leak.json"
deno run --allow-read --v8-flags=--expose-gc ts/run-server.ts --settle=gc --gc-in-loop --repeats=5 >"$out/deno-leak.json"
