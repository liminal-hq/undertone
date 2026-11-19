// Loads each built scratch app from a localhost-only static server in headless Chromium or Firefox and prints the results
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Usage: bun run.mjs <chromium|firefox> <repeats> <app dir under ../out>...
// PLAYWRIGHT_CORE may name another playwright-core whose protocol matches the cached Firefox build.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const { chromium, firefox } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const [name, repeatsText, ...apps] = process.argv.slice(2);
const repeats = Number(repeatsText);
const out = new URL('../out/', import.meta.url).pathname;
const home = process.env.HOME;
const executables = {
  chromium: `${home}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  firefox: `${home}/.cache/ms-playwright/firefox-1539/firefox/firefox`
};
const types = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.html': 'text/html'
};

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let file = join(out, path);
  if (!file.startsWith(out)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
try {
  const browser = await (name === 'chromium' ? chromium : firefox).launch({
    headless: true,
    executablePath: executables[name]
  });
  const version = browser.version();
  for (const app of apps) {
    const runs = [];
    const errors = [];
    for (let i = 0; i < repeats; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`http://127.0.0.1:${port}/${app}/`);
      try {
        await page.waitForFunction(() => globalThis.__r3 !== undefined, null, { timeout: 6000 });
        runs.push(await page.evaluate(() => globalThis.__r3));
      } catch {
        runs.push(null);
      }
      await context.close();
    }
    const ok = runs.filter(Boolean);
    const first = ok[0];
    console.log(
      JSON.stringify({
        browser: `${name} ${version}`,
        app,
        runs: runs.length,
        ran: ok.length,
        onTime: ok.every((r) => r.firstPlay.onTime),
        renderPeak: first?.renderPeak,
        hashes: first?.rows.map((r) => r.hash),
        medians: first && {
          instantiateMs: median(ok.map((r) => r.firstPlay.instantiateMs)),
          playMs: median(ok.map((r) => r.firstPlay.playMs)),
          loadStartToBookedMs: median(ok.map((r) => r.firstPlay.loadStartToBookedMs)),
          ...(first.dynamicImportMs === undefined
            ? {}
            : { dynamicImportMs: median(ok.map((r) => r.dynamicImportMs)) })
        },
        errors: [...new Set(errors)].slice(0, 3)
      })
    );
  }
  await browser.close();
} finally {
  server.close();
}
