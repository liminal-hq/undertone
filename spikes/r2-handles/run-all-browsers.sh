#!/usr/bin/env bash
# Runs the R2 measurements in Chromium and Firefox (WebKit could not run on this machine), JSON into $1
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
out="${1:?output directory}"
mkdir -p "$out" out
bun build ts/browser.ts --outdir out --target browser >/dev/null
for settle in idle churn gc; do
	bun run-browsers.mjs chromium $settle 3 >"$out/chromium-$settle.json"
done
bun run-browsers.mjs chromium gc 5 --gc-in-loop >"$out/chromium-leak.json"
# Firefox cannot expose an explicit collector, so only the idle and churn settles run.
export PLAYWRIGHT_CORE=/home/scott/.npm/_npx/86170c4cd1c5da32/node_modules/playwright-core/index.mjs
for settle in idle churn; do
	bun run-browsers.mjs firefox $settle 3 >"$out/firefox-$settle.json"
done
