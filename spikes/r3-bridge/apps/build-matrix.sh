#!/usr/bin/env bash
# Builds every scratch app into out/<app>-<config>/ and prints one result line per build (ok or the error)
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
rm -rf out && mkdir -p out
build() { # <vite dir> <app> <name> [vite args...]
	local dir="$1" app="$2" name="$3"
	shift 3
	local log
	if log=$(cd "$dir" && node node_modules/vite/bin/vite.js build "$app" --outDir "../../out/$name" --emptyOutDir --base ./ "$@" 2>&1); then
		echo "OK    $name"
	else
		echo "FAIL  $name :: $(echo "$log" | grep -m1 -E 'ERROR|rror:' )"
		rm -rf "out/$name"
	fi
}
for v in vite5 vite8; do
	for app in static playground; do
		build $v $app "$v-$app-default"
		build $v $app "$v-$app-cli-esnext" --target esnext
		build $v $app "$v-$app-cfg-esnext" --config configs/esnext.config.js
		build $v $app "$v-$app-cfg-baseline" --config configs/baseline.config.js
	done
done
build vite5 init "vite5-init-default"
build vite5 init "vite5-init-cfg-esnext" --config configs/esnext.config.js
# Dynamic import(): the unpacked package next to a plain page, no bundler.
mkdir -p out/dynamic/pkg out/shared out/scripts
cp -r dynamic/index.html dynamic/main.js out/dynamic/
cp -r scripts/node_modules/@liminal-hq/undertone/* out/dynamic/pkg/
cp shared/run.js out/shared/
cp scripts/programs.mjs scripts/recorder-context.mjs out/scripts/
echo "OK    dynamic (no bundler)"
