#!/usr/bin/env bash
# Packs @liminal-hq/undertone, installs the tarball in a clean directory, and loads it in Node, Bun, Deno (if present), and Vite 5
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

# The checks of RF-25 (D-17, R3's scratch-app idea on the real package):
#   1. `npm pack` makes the tarball a user would install, and it holds the built module and no sources or tests;
#   2. Node and Bun import the package by name (the `node` condition: synchronous load, no await) and run a query, and the
#      `./init` entry works with its explicit `await init()`;
#   3. Deno does the same when it is installed (skipped otherwise, and said so);
#   4. a Vite 5 build of an app that imports the package fails at Vite 5's default target on the top-level `await` (the
#      documented condition), succeeds with `build.target: 'esnext'`, and succeeds for the `./init` entry at the default target;
#      the built output holds the module as an asset, and the built bundles run (under Node, with a stand-in `document` and `fetch`), which
#      catches a bundler dropping the entry's initialisation (what `"sideEffects": false` did before the entries were listed).
# Needs a built package (`bun run package:build`), npm, Node 22+, Bun, and network access for Vite 5 (npm).
# Usage: scripts/check-package-loading.sh

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="${root}/packages/undertone"
vite_version="5.4.21"

for need in dist/index.js dist/index.node.js wasm/undertone_wasm_bg.wasm; do
	if [[ ! -f "${package}/${need}" ]]; then
		echo "check-package-loading: ${need} is missing; run 'bun run package:build' first" >&2
		exit 1
	fi
done

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

fail() {
	echo "check-package-loading: FAIL: $*" >&2
	exit 1
}

echo "== 1. the tarball"
(cd "${package}" && npm pack --silent --pack-destination "${work}" >/dev/null)
tarball="$(ls "${work}"/*.tgz)"
listing="$(tar -tzf "${tarball}")"
for want in package/dist/index.js package/dist/index.node.js package/dist/init.js package/dist/testing.js package/wasm/undertone_wasm_bg.wasm package/wasm/undertone_wasm.js package/README.md; do
	grep -qx "${want}" <<<"${listing}" || fail "the tarball lacks ${want}"
done
if grep -E '^package/(src|test)/|\.test\.' <<<"${listing}" >/dev/null; then fail "the tarball holds sources or tests"; fi
echo "ok   $(basename "${tarball}"): $(wc -c <"${tarball}") bytes, $(wc -l <<<"${listing}") files"

app="${work}/app"
mkdir -p "${app}"
cat >"${app}/package.json" <<'JSON'
{ "name": "loading-check", "private": true, "type": "module" }
JSON
(cd "${app}" && npm install --silent --no-audit --no-fund "${tarball}")

cat >"${app}/main.mjs" <<'JS'
import { Fraction, Pattern, hasOnset, mini, sine } from '@liminal-hq/undertone';
const pattern = mini('a b*2', (word) => word);
const haps = pattern.query({ begin: new Fraction(0), end: new Fraction(1) });
if (!(pattern instanceof Pattern) || haps.length !== 3 || !hasOnset(haps[0])) throw new Error('unexpected haps');
if (Math.abs(sine.sampleAt(new Fraction(1, 4)) - 1) > 1e-9) throw new Error('unexpected sine');
console.log(`${haps.map((hap) => `${hap.part.begin}:${hap.value}`).join(' ')}`);
JS
cat >"${app}/init.mjs" <<'JS'
import { init, pure, Fraction } from '@liminal-hq/undertone/init';
await init();
await init();
const haps = pure(7).query({ begin: new Fraction(0), end: new Fraction(2) });
if (haps.length !== 2 || haps[1].value !== 7) throw new Error('unexpected haps');
console.log('init ok');
JS

echo "== 2. Node $(node --version) and Bun $(bun --version)"
for runtime in node bun; do
	out="$(cd "${app}" && "${runtime}" main.mjs)" || fail "${runtime} could not import the package"
	[[ "${out}" == "0:a 1/2:b 3/4:b" ]] || fail "${runtime} printed '${out}'"
	(cd "${app}" && "${runtime}" init.mjs >/dev/null) || fail "${runtime} could not use ./init"
	echo "ok   ${runtime}: . and ./init"
done

echo "== 3. Deno"
if command -v deno >/dev/null; then
	(cd "${app}" && deno run -A main.mjs >/dev/null) || fail "deno could not import the package"
	(cd "${app}" && deno run -A init.mjs >/dev/null) || fail "deno could not use ./init"
	echo "ok   deno $(deno --version | head -1 | cut -d' ' -f2): . and ./init"
else
	echo "skip deno is not installed"
fi

echo "== 4. Vite ${vite_version}"
(cd "${app}" && npm install --silent --no-audit --no-fund --no-save "vite@${vite_version}")
mkdir -p "${app}/page" "${app}/page-init"
cat >"${app}/page/index.html" <<'HTML'
<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>
HTML
cat >"${app}/page/main.js" <<'JS'
import { Fraction, mini } from '@liminal-hq/undertone';
const haps = mini('a b', (word) => word).query({ begin: new Fraction(0), end: new Fraction(1) });
document.body.textContent = haps.map((hap) => hap.value).join(' ');
JS
cat >"${app}/page-init/index.html" <<'HTML'
<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>
HTML
cat >"${app}/page-init/main.js" <<'JS'
import { Fraction, init, mini } from '@liminal-hq/undertone/init';
init().then(() => {
  const haps = mini('a b', (word) => word).query({ begin: new Fraction(0), end: new Fraction(1) });
  document.body.textContent = haps.map((hap) => hap.value).join(' ');
});
JS
# Runs a built page's script in Node with a stand-in `document` and a `fetch` that serves the module from disk as
# application/wasm (as a web server would), and prints what the page wrote. This is what catches a bundler dropping the module's initialisation.
cat >"${app}/run-built.mjs" <<'JS'
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = resolve(process.argv[2], 'assets');
const script = readdirSync(dir).find((name) => name.endsWith('.js'));
globalThis.fetch = async (url) =>
  new Response(readFileSync(fileURLToPath(url)), { headers: { 'Content-Type': 'application/wasm' } });
globalThis.document = {
  body: { textContent: '' },
  createElement: () => ({ relList: { supports: () => true } }) // Vite's modulepreload polyfill returns early on this
};
await import(join(dir, script));
await new Promise((done) => setTimeout(done, 200));
console.log(document.body.textContent);
JS
vite="${app}/node_modules/vite/bin/vite.js"
build() { (cd "${app}" && node "${vite}" build "$@" 2>&1); }

if log="$(build page --outDir ../out-default --emptyOutDir)"; then
	fail "Vite ${vite_version} built the top-level await entry at its default target; the README's build.target note is stale"
fi
grep -q 'Top-level await is not available' <<<"${log}" || fail "the default-target build failed for another reason: ${log}"
echo "ok   default target: refused the top-level await, as documented"

build page --outDir ../out-esnext --emptyOutDir --base ./ --target esnext >/dev/null || fail "the build with target esnext failed"
ls "${app}"/out-esnext/assets/*.wasm >/dev/null 2>&1 || fail "the esnext build holds no .wasm asset"
[[ "$(cd "${app}" && node run-built.mjs out-esnext)" == "a b" ]] || fail "the esnext bundle did not run: the module was not initialised"
echo "ok   build.target esnext: built, the module is an asset, and the bundle runs"

build page-init --outDir ../out-init --emptyOutDir --base ./ >/dev/null || fail "the ./init build at the default target failed"
ls "${app}"/out-init/assets/*.wasm >/dev/null 2>&1 || fail "the ./init build holds no .wasm asset"
[[ "$(cd "${app}" && node run-built.mjs out-init)" == "a b" ]] || fail "the ./init bundle did not run"
echo "ok   ./init at the default target: built, and the bundle runs"

echo "check-package-loading: all checks passed"
