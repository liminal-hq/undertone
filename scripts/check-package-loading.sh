#!/usr/bin/env bash
# Packs @liminal-hq/undertone, installs the tarball in a clean directory, and loads it in Node, Bun, Deno (if present), and Vite 5
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

# The checks of RF-25 (D-17, R3's scratch-app idea on the real package):
#   1. `npm pack` makes the tarball a user would install, and it holds the built module and no sources or tests;
#   2. Node and Bun import the package by name (the `node` condition: synchronous load, no await), run a query, render a
#      note through the lazily loaded render module and encode it as WAV, and the `./init` entry works with its explicit `await init()`;
#   3. Deno does the same when it is installed (skipped otherwise, and said so);
#      The opt-in `./worklet` entry (RF-29) imports there too, and its Vite build emits the render module's glue and module as
#      assets (it finds them with `new URL(..., import.meta.url)`);
#   4. a Vite 5 build of an app that imports the package fails at Vite 5's default target on the top-level `await` (the
#      documented condition), succeeds with `build.target: 'esnext'`, and succeeds for the `./init` entry at the default target;
#      the built output holds both modules as assets (the render module's glue a chunk of its own, imported on the first
#      render), and the built bundles run and render (under Node, with a stand-in `document` and `fetch`), which
#      catches a bundler dropping the entry's initialisation (what `"sideEffects": false` did before the entries were listed).
# Needs a built package (`bun run package:build`), npm, Node 22+, Bun, and network access for Vite 5 (npm).
# Usage: scripts/check-package-loading.sh

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="${root}/packages/undertone"
vite_version="5.4.21"

for need in dist/index.js dist/index.node.js wasm/undertone_wasm_bg.wasm wasm/render/undertone_wasm_render_bg.wasm wasm/worklet/undertone_worklet_bg.wasm; do
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
for want in package/dist/index.js package/dist/index.node.js package/dist/init.js package/dist/testing.js package/dist/worklet.js package/dist/workletProcessor.js package/dist/workletShim.js package/wasm/undertone_wasm_bg.wasm package/wasm/undertone_wasm.js package/wasm/render/undertone_wasm_render.js package/wasm/render/undertone_wasm_render_bg.wasm package/wasm/worklet/undertone_worklet.js package/wasm/worklet/undertone_worklet_bg.wasm package/README.md; do
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
import { CHANNEL_ORDER, Fraction, Pattern, encodeWav, hasOnset, mini, note, sine } from '@liminal-hq/undertone';
const pattern = mini('a b*2', (word) => word);
const haps = pattern.query({ begin: new Fraction(0), end: new Fraction(1) });
if (!(pattern instanceof Pattern) || haps.length !== 3 || !hasOnset(haps[0])) throw new Error('unexpected haps');
if (Math.abs(sine.sampleAt(new Fraction(1, 4)) - 1) > 1e-9) throw new Error('unexpected sine');
if (note('c3').gain(0.5).query({ begin: new Fraction(0), end: new Fraction(1) })[0].value.gainLevel !== 0.5) throw new Error('unexpected control');
if (CHANNEL_ORDER.length !== 8) throw new Error('unexpected constants');
const rendered = await note('c3').render({ sampleRate: 8000, master: false });
if (rendered.length !== 16000 || !rendered.getChannelData(0).some((x) => x !== 0)) throw new Error('unexpected render');
if (encodeWav(rendered).length !== 44 + 16000 * 4) throw new Error('unexpected WAV');
console.log(`${haps.map((hap) => `${hap.part.begin}:${hap.value}`).join(' ')}`);
JS
cat >"${app}/init.mjs" <<'JS'
import { init, note, pure, Fraction, renderToBuffer } from '@liminal-hq/undertone/init';
await init();
await init();
const haps = pure(7).query({ begin: new Fraction(0), end: new Fraction(2) });
if (haps.length !== 2 || haps[1].value !== 7) throw new Error('unexpected haps');
if ((await renderToBuffer(note('c3'), { sampleRate: 8000, master: false })).length !== 16000) throw new Error('unexpected render');
console.log('init ok');
JS

cat >"${app}/worklet.mjs" <<'JS'
import { createWorkletOutput, workletModuleSource } from '@liminal-hq/undertone/worklet';
if (typeof createWorkletOutput !== 'function') throw new Error('no createWorkletOutput');
const source = workletModuleSource('/* glue */');
if (!source.includes('registerProcessor') || !source.includes('TextDecoder')) throw new Error('the worklet module lacks the processor or the shim');
console.log('worklet ok');
JS

echo "== 2. Node $(node --version) and Bun $(bun --version)"
for runtime in node bun; do
	out="$(cd "${app}" && "${runtime}" main.mjs)" || fail "${runtime} could not import the package"
	[[ "${out}" == "0:a 1/2:b 3/4:b" ]] || fail "${runtime} printed '${out}'"
	(cd "${app}" && "${runtime}" init.mjs >/dev/null) || fail "${runtime} could not use ./init"
	(cd "${app}" && "${runtime}" worklet.mjs >/dev/null) || fail "${runtime} could not import ./worklet"
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
import { CHANNEL_ORDER, Fraction, encodeWav, mini, note } from '@liminal-hq/undertone';
const haps = mini('a b', (word) => word).query({ begin: new Fraction(0), end: new Fraction(1) });
const gain = note('c3').gain(0.5).query({ begin: new Fraction(0), end: new Fraction(1) })[0].value.gainLevel;
const rendered = await note('c3').render({ sampleRate: 8000, master: false });
document.body.textContent = `${haps.map((hap) => hap.value).join(' ')} ${gain} ${CHANNEL_ORDER.length} ${rendered.length} ${encodeWav(rendered).length}`;
JS
cat >"${app}/page-init/index.html" <<'HTML'
<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>
HTML
cat >"${app}/page-init/main.js" <<'JS'
import { CHANNEL_ORDER, Fraction, encodeWav, init, mini, note, renderToBuffer } from '@liminal-hq/undertone/init';
init().then(async () => {
  // encodeWav is TypeScript: it works in a browser before any render has loaded the render module.
  const early = encodeWav({ sampleRate: 8000, channels: [new Float32Array(2)] }).length;
  const haps = mini('a b', (word) => word).query({ begin: new Fraction(0), end: new Fraction(1) });
  const gain = note('c3').gain(0.5).query({ begin: new Fraction(0), end: new Fraction(1) })[0].value.gainLevel;
  const rendered = await renderToBuffer(note('c3'), { sampleRate: 8000, master: false });
  document.body.textContent = `${early} ${haps.map((hap) => hap.value).join(' ')} ${gain} ${CHANNEL_ORDER.length} ${rendered.length}`;
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
await new Promise((done) => setTimeout(done, 1000));
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
[[ "$(ls "${app}"/out-esnext/assets/*.wasm 2>/dev/null | wc -l)" -ge 2 ]] || fail "the esnext build does not hold both .wasm assets"
[[ "$(cd "${app}" && node run-built.mjs out-esnext)" == "a b 0.5 8 16000 64044" ]] || fail "the esnext bundle did not run or render: a module was not initialised"
echo "ok   build.target esnext: built, both modules are assets, and the bundle runs and renders"

build page-init --outDir ../out-init --emptyOutDir --base ./ >/dev/null || fail "the ./init build at the default target failed"
[[ "$(ls "${app}"/out-init/assets/*.wasm 2>/dev/null | wc -l)" -ge 2 ]] || fail "the ./init build does not hold both .wasm assets"
[[ "$(cd "${app}" && node run-built.mjs out-init)" == "48 a b 0.5 8 16000" ]] || fail "the ./init bundle did not run, encode, or render"
echo "ok   ./init at the default target: built, and the bundle runs, encodes a WAV before any render, and renders"

mkdir -p "${app}/page-worklet"
cat >"${app}/page-worklet/index.html" <<'HTML'
<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>
HTML
cat >"${app}/page-worklet/main.js" <<'JS'
import { createWorkletOutput } from '@liminal-hq/undertone/worklet';
globalThis.worklet = createWorkletOutput;
document.body.textContent = typeof createWorkletOutput;
JS
build page-worklet --outDir ../out-worklet --emptyOutDir --base ./ --target esnext >/dev/null || fail "the ./worklet build failed"
ls "${app}"/out-worklet/assets/ | grep -q '^undertone_worklet_bg-.*\.wasm$' || fail "the ./worklet build does not hold the worklet module as an asset"
ls "${app}"/out-worklet/assets/ | grep -q '^undertone_worklet-.*\.js$' || fail "the ./worklet build does not hold the worklet module's glue as an asset"
echo "ok   ./worklet: built, with the worklet module (the speed-optimised build) and its glue as assets"

echo "check-package-loading: all checks passed"
