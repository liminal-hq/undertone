// Loads the worklet backend in headless Chromium and compares what the worklet renders with the offline render
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// A by-hand tool, never run in CI: it needs Playwright's core library and a Chromium binary, which are not dependencies of this
// package (the same arrangement as conformance/recorder/browser-render.ts):
//   PLAYWRIGHT_CORE  directory of an installed `playwright-core` (default: resolve `playwright-core` normally)
//   CHROMIUM_PATH    a Chromium or Chrome executable (default: the newest of Playwright's cache, then /usr/bin/chromium)
// Usage: bun packages/undertone/harness/check.ts [--harness SECONDS]
//
// What it proves: the worklet loads (the blob module with the shim, the glue, and the processor in a real AudioWorkletGlobalScope,
// which has no `TextDecoder`), the render module is instantiated from the module posted in `processorOptions`, a pass is posted
// and booked, and the output equals the package's own offline render of the same pattern. What it does not prove: anything about
// performance (a headless run has no real audio device, and the offline context renders as fast as it can), or about how it sounds.
// With `--harness SECONDS` it also opens the harness page on a real-time AudioContext in headless Chromium for that long, which
// exercises the real-time path against the browser's silent sink and prints the statistics: not a device result either.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from './serve.ts';

interface Page {
  goto(url: string): Promise<unknown>;
  waitForFunction(
    fn: string | (() => unknown),
    arg?: unknown,
    options?: { timeout: number }
  ): Promise<unknown>;
  evaluate<T>(fn: string | (() => T | Promise<T>)): Promise<T>;
  on(event: string, listener: (message: { text(): string; type(): string }) => void): void;
}
interface Browser {
  version(): string;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface PlaywrightCore {
  chromium: { launch(options: { executablePath: string; args?: string[] }): Promise<Browser> };
}

async function loadPlaywright(): Promise<PlaywrightCore> {
  const dir = process.env.PLAYWRIGHT_CORE;
  const specifier =
    dir === undefined ? 'playwright-core' : pathToFileURL(join(resolve(dir), 'index.mjs')).href;
  const module = (await import(specifier)) as PlaywrightCore & { default?: PlaywrightCore };
  return module.default ?? module;
}

function findChromium(): string {
  if (process.env.CHROMIUM_PATH !== undefined) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const newest = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
    const binary = newest === undefined ? '' : join(cache, newest, 'chrome-linux64', 'chrome');
    if (existsSync(binary)) return binary;
  }
  return '/usr/bin/chromium';
}

interface Comparison {
  name: string;
  channels: number;
  length: number;
  worst: number;
  differing: number;
  first: number;
  loud: number;
  timing: string;
  errors: string[];
}

const args = process.argv.slice(2);
const harnessSeconds = args.includes('--harness') ? Number(args[args.indexOf('--harness') + 1]) : 0;
const server = serve(0, true);
const base = `http://127.0.0.1:${server.port}`;
const playwright = await loadPlaywright();
const executablePath = findChromium();
const browser = await playwright.chromium.launch({
  executablePath,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox']
});
let failed = false;
try {
  console.log(`${browser.version()} (${executablePath})`);
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      console.log(`  page ${message.type()}: ${message.text()}`);
  });
  await page.goto(`${base}/harness/check.html`);
  await page.waitForFunction('window.checkResult !== undefined', undefined, { timeout: 120_000 });
  const report = await page.evaluate<{
    error?: string;
    userAgent?: string;
    results?: Comparison[];
  }>('window.checkResult');
  if (report.error !== undefined) {
    console.log(`FAIL the page threw: ${report.error}`);
    failed = true;
  } else {
    for (const result of report.results ?? []) {
      const tolerance = 1e-6;
      const ok = result.worst < tolerance && result.loud > 1000 && result.errors.length === 0;
      failed ||= !ok;
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.channels} ch): ${result.length} frames, ${result.loud} samples above 0.01, ` +
          `${result.differing} differ from the offline render, by at most ${result.worst}` +
          `${result.first >= 0 ? ` (first at frame ${result.first})` : ''}; the worklet's clock: ${result.timing}` +
          `${result.errors.length > 0 ? `; errors: ${result.errors.join(' | ')}` : ''}`
      );
    }
  }
  if (harnessSeconds > 0 && !failed) {
    console.log(
      `harness page, ${harnessSeconds} s on a real-time context with no audio device (not a device result)`
    );
    await page.goto(`${base}/harness/index.html?auto=${harnessSeconds}&pattern=representative`);
    await page.waitForFunction(
      'window.undertoneHarness && window.undertoneHarness.result !== undefined',
      undefined,
      { timeout: (harnessSeconds + 60) * 1000 }
    );
    const result = await page.evaluate('window.undertoneHarness.result');
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
