#!/usr/bin/env bash
# Builds the TypeScript reference engine (the root package) and copies it where the worklet harness's head-to-head page can import it
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0

# The reference engine in `src/` builds to the root `dist/` with `bun run build` (plain ES modules). The harness server only serves
# `packages/undertone/`, so this copies that `dist/` to `packages/undertone/harness/reference/` (git-ignored), where
# `harness/headtohead.html` loads it as `./reference/index.js`. Run it again after the reference changes.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$root/packages/undertone/harness/reference"

cd "$root"
bun run build
rm -rf "$target"
mkdir -p "$target"
cp -R dist/. "$target/"
echo "reference engine copied to ${target#"$root"/}"
