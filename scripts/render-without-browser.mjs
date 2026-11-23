// Renders the RF-30 cases through the built package, with no Web Audio, and compares each with the native Rust render byte for byte
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Usage (the same file runs under every runtime):
//   node scripts/render-without-browser.mjs REFDIR
//   bun scripts/render-without-browser.mjs REFDIR
//   deno run -A scripts/render-without-browser.mjs REFDIR
//
// REFDIR holds the native WAV files that `scripts/check-wasi-render.sh` writes. The package must be built
// (`bun run package:build`). The renders are the cases of scripts/render-without-browser-cases.json, the ones the WASI build
// renders too. Every case goes through `note(...).sound(...).render(...)` (or `sound(...)`) and `encodeWav`, which is the
// WebAssembly render module and the TypeScript encoder: no `OfflineAudioContext`, no `AudioContext`, no browser.
// Nothing here listens to the audio; it compares bytes.

import { readFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const refDir = process.argv[2];
if (!refDir) {
  console.error('usage: render-without-browser.mjs REFDIR');
  process.exit(2);
}

// The built package, by path (scripts/check-package-loading.sh covers the import by name from the packed tarball).
const entry = pathToFileURL(
  join(here, '..', 'packages', 'undertone', 'dist', 'index.node.js')
).href;
const { note, sound, encodeWav } = await import(entry);

const runtime =
  'Deno' in globalThis
    ? `deno ${globalThis.Deno.version.deno}`
    : 'Bun' in globalThis
      ? `bun ${globalThis.Bun.version}`
      : `node ${process.versions.node}`;
console.log(`runtime: ${runtime}; AudioContext present: ${'AudioContext' in globalThis}`);

const cases = JSON.parse(readFileSync(join(here, 'render-without-browser-cases.json'), 'utf8'));
let failed = 0;
for (const c of cases) {
  const pattern = c.kind === 'note' ? note(c.pattern).sound(c.wave) : sound(c.pattern);
  const audio = await pattern.render({
    seconds: c.seconds,
    bpm: c.bpm,
    sampleRate: c.rate,
    channels: c.channels,
    seed: c.seed,
    // The Rust command line turns the master bus off above stereo; this does the same.
    master: c.channels > 2 ? false : undefined
  });
  const bytes = encodeWav(audio, { bitDepth: c.bitDepth, seed: c.seed });
  const reference = new Uint8Array(readFileSync(join(refDir, `${c.name}.wav`)));

  if (bytes.length === reference.length && bytes.every((b, i) => b === reference[i])) {
    console.log(`ok   ${c.name}: ${bytes.length} bytes, identical to the native Rust render`);
    continue;
  }
  failed++;
  // Not byte-identical: say how far apart, so the difference is reported rather than hidden.
  let differing = 0;
  let maxByteDifference = 0;
  const shared = Math.min(bytes.length, reference.length);
  for (let i = 0; i < shared; i++) {
    if (bytes[i] !== reference[i]) {
      differing++;
      maxByteDifference = Math.max(maxByteDifference, Math.abs(bytes[i] - reference[i]));
    }
  }
  console.error(
    `FAIL ${c.name}: ${bytes.length} bytes against ${reference.length}; ${differing} of ${shared} shared bytes differ (largest byte difference ${maxByteDifference})`
  );
}
if (failed) process.exit(1);
console.log(`render-without-browser: all ${cases.length} renders are identical (${runtime})`);
