// The WAV corpus through the render module's encodeWav: every case's bytes, or its message, exactly
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, with Bun:
//   bun crates/undertone-wasm/tests/js/wav.ts
// Each case of conformance/cases/wav/wav.json is encoded with the render module's `encodeWav(sampleRate, channels, options)` and
// its bytes compared with the recorded hex, byte for byte; an error case must throw the recorded message word for word.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from './render.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

interface WavCase {
  id: string;
  sampleRate: number;
  channels: unknown[][];
  options: Record<string, unknown>;
  bytes?: string;
  error?: string;
}

/** A recorded sample: a number, or `{ $num }` for one JSON cannot hold. */
const sample = (value: unknown): number =>
  typeof value === 'number'
    ? value
    : (value as { $num: string }).$num === '-0'
      ? -0
      : Number((value as { $num: string }).$num);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export function runWav(): { total: number; failed: string[] } {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/wav/wav.json`, 'utf8')) as {
    cases: WavCase[];
  };
  const failed: string[] = [];
  for (const spec of file.cases) {
    const channels = spec.channels.map((channel) => Float32Array.from(channel, sample));
    try {
      const bytes = hex(render.encodeWav(spec.sampleRate, channels, spec.options));
      if (spec.error !== undefined) failed.push(`${spec.id}: expected ${spec.error}, got bytes`);
      else if (bytes !== spec.bytes) failed.push(`${spec.id}: the bytes differ`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== spec.error) failed.push(`${spec.id}: threw ${message}`);
    }
  }
  return { total: file.cases.length, failed };
}

if (import.meta.main) {
  const { total, failed } = runWav();
  console.log(`wav: ${total - failed.length} of ${total} equal, ${failed.length} failed`);
  for (const failure of failed) console.log(`  FAIL ${failure}`);
  if (failed.length > 0) process.exit(1);
}
