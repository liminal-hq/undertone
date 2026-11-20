// Vitest project for the package: tests run against the built module (dist/ and wasm/), not the sources
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dist = (file: string) => fileURLToPath(new URL(`./dist/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // The package's own name, as a user imports it, resolved to the synchronous Node entry (the `node` export condition).
    alias: [
      { find: /^@liminal-hq\/undertone\/init$/, replacement: dist('init.node.js') },
      { find: /^@liminal-hq\/undertone\/testing$/, replacement: dist('testing.js') },
      {
        find: /^@liminal-hq\/undertone\/wasm$/,
        replacement: fileURLToPath(new URL('./wasm/undertone_wasm.js', import.meta.url))
      },
      { find: /^@liminal-hq\/undertone$/, replacement: dist('index.node.js') }
    ]
  },
  test: {
    name: 'package',
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
