// Opens a running Vite dev server in headless Chromium and prints whether the app produced its result
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  headless: true,
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
await page.goto(process.argv[2]);
const ok = await page
  .waitForFunction(() => globalThis.__r3, null, { timeout: 8000 })
  .then(
    () => true,
    () => false
  );
console.log(JSON.stringify({ url: process.argv[2], ok, errors: [...new Set(errors)].slice(0, 3) }));
await browser.close();
