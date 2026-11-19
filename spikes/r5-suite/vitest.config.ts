// Runs the reference's own test files with every public module path resolved to a bridge (spike R5)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const srcDir = resolve(repo, 'src');

/** `binding`: the thin Rust-backed pattern binding (bridge/index.ts); `skeleton`: R3's skeleton as built. */
const which = process.env.R5_BRIDGE ?? 'binding';
const entry = resolve(here, which === 'skeleton' ? 'skeleton/index.ts' : 'bridge/index.ts');

/**
 * Sends `./pattern`, `./fraction`, `./index`, `../src/index`, and every other module path of the library to
 * the bridge when a test file (or the docs, or the recorder) asks for it. Imports made by the reference's own
 * sources (the fake context in src/test-utils) are left alone, so the fakes stay the reference's fakes.
 * A symbol the bridge does not export is simply undefined, which is how "not covered" shows up.
 */
const toBridge = {
  name: 'r5-bridge',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    // The recorder's loadReference() imports src/<file>.ts by absolute file URL: that is the "point it at the package" step.
    if (importer?.endsWith('/conformance/recorder/reference.ts') && source.startsWith('file://')) {
      return source.startsWith('file://' + srcDir + '/') ? entry : null;
    }
    if (!importer || !source.startsWith('.')) return null;
    if (importer.includes('/node_modules/') || importer.startsWith(here)) return null;
    const target = resolve(dirname(importer), source).replace(/\.(ts|js)$/, '');
    const inSrc = target.startsWith(srcDir + '/');
    if (!inSrc) return null;
    if (target.startsWith(resolve(srcDir, 'test-utils') + '/')) return null;
    const importerInSrcSource = importer.startsWith(srcDir + '/') && !/\.test\.ts$/.test(importer);
    if (importerInSrcSource) return null;
    return entry;
  }
};

export default defineConfig({
  root: repo,
  plugins: [toBridge],
  test: { environment: 'node' }
});
