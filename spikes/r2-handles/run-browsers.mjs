// Runs the R2 measurements in headless browsers through Playwright, over a localhost-only static server
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Usage: bun run-browsers.mjs <chromium|firefox|webkit> <idle|churn|gc> <repeats> [--gc-in-loop]
// Needs `bun build ts/browser.ts --outdir out --target browser` first. Writes JSON to stdout.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
// PLAYWRIGHT_CORE may name another playwright-core whose protocol matches the cached browser build.
const { chromium, firefox, webkit } = await import(
  process.env.PLAYWRIGHT_CORE ?? 'playwright-core'
);

const [name, settle = 'idle', repeats = '3'] = process.argv.slice(2);
const gcInLoop = process.argv.includes('--gc-in-loop');
const home = process.env.HOME;
const executables = {
  chromium: `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  firefox: `${home}/.cache/ms-playwright/firefox-1539/firefox/firefox`
};
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const files = {
  '/': [
    '<!doctype html><meta charset=utf-8><script type=module src=/browser.js></script>',
    '.html'
  ],
  '/browser.js': [readFileSync('out/browser.js'), '.js'],
  '/r2_handles_bg.wasm': [readFileSync('pkg/r2_handles_bg.wasm'), '.wasm']
};
// Cross-origin isolation gives performance.now() its finest resolution.
const server = createServer((req, res) => {
  const hit = files[req.url];
  if (!hit) return res.writeHead(404).end();
  res.writeHead(200, {
    'content-type': types[hit[1]],
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp'
  });
  res.end(hit[0]);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const kind = { chromium, firefox, webkit }[name];
  const args = name === 'chromium' ? ['--js-flags=--expose-gc'] : [];
  const browser = await kind.launch({ headless: true, executablePath: executables[name], args });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof globalThis.__run === 'function');
  const result = await page.evaluate(
    ([s, g, r]) => globalThis.__run(s, g, r),
    [settle, gcInLoop, Number(repeats)]
  );
  result.browserVersion = browser.version();
  console.log(JSON.stringify(result));
  await browser.close();
} finally {
  server.close();
}
