// Records the layer 4 browser renders: each case rendered by the reference in headless Chromium, written as summaries
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { browserJson, renderHead, RENDERS_PATH, serialiseRenders } from './renders';
import type { BrowserRecord } from './renders';
import { renderCases } from './rendersData';
import { loadReference, repoRoot } from './reference';
import type { RenderSummary } from './renderSummary';

// A by-hand tool, never run in CI (`docs/rust-migration/CONFORMANCE.md`). It needs Playwright's core library and a
// Chromium binary, which are not dependencies of this package:
//   PLAYWRIGHT_CORE  directory of an installed `playwright-core` (default: resolve `playwright-core` normally)
//   CHROMIUM_PATH    a Chromium or Chrome executable (default: the newest of Playwright's cache, then /usr/bin/chromium)

interface Page {
  goto(url: string): Promise<unknown>;
  addScriptTag(options: { content: string }): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
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
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv !== undefined) return fromEnv;
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

/** The part of Bun's bundler this script uses (the package has no `@types/bun`). */
declare const Bun: {
  build(options: {
    entrypoints: string[];
    target: 'browser';
    format: 'iife';
    minify: boolean;
  }): Promise<{ success: boolean; logs: unknown[]; outputs: { text(): Promise<string> }[] }>;
};

/** Bundles the page side (the library, the interpreter, and the summary) into one script. */
async function bundlePage(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(repoRoot, 'conformance', 'recorder', 'browser-page.ts')],
    target: 'browser',
    format: 'iife',
    minify: false
  });
  if (!result.success) throw new Error(`bundling the page failed:\n${result.logs.join('\n')}`);
  return await result.outputs[0].text();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const casesDir = resolve(flag('--out') ?? join(repoRoot, 'conformance', 'cases'));
  const only = flag('--only');
  const specs = renderCases().filter((spec) => only === undefined || spec.id === only);
  if (specs.length === 0) throw new Error(`no case ${only}`);
  if (only !== undefined && flag('--out') === undefined) {
    throw new Error('--only writes a partial file; pass --out <directory> as well');
  }

  const ref = await loadReference();
  const warn = console.warn;
  console.warn = () => undefined; // the reference warns once per clamp; the corpus records values, not logs
  const script = await bundlePage();
  const playwright = await loadPlaywright();
  const executablePath = findChromium();
  const browser = await playwright.chromium.launch({ executablePath });
  const chromium = browser.version();
  console.log(`${chromium} (${executablePath})`);
  const cases = [];
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: script });
    for (const spec of specs) {
      const head = renderHead(ref, spec);
      const started = Date.now();
      const summary: RenderSummary = await page.evaluate(
        async ([program, render]) =>
          await (
            globalThis as unknown as {
              undertoneRender(p: unknown, r: unknown): Promise<RenderSummary>;
            }
          ).undertoneRender(program, render),
        [spec.program, spec.render] as const
      );
      const record: BrowserRecord = { chromium, ...summary };
      cases.push({ ...head, browser: browserJson(record) });
      const peak = Math.max(...summary.channels.map((c) => c.peak));
      console.log(
        `${spec.id}: ${summary.frames} frames, peak ${peak.toFixed(4)}, ${Date.now() - started} ms`
      );
    }
  } finally {
    await browser.close();
    console.warn = warn;
  }
  const target = join(casesDir, RENDERS_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serialiseRenders(cases));
  console.log(`wrote ${cases.length} cases to ${relative(process.cwd(), target)}`);
}

await main();
