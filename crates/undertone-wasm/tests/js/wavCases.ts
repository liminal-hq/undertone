// The WAV corpus over any encoder: every case's bytes, or its message, exactly (the module's runner and the package's share it)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// No module is loaded here, so the package's Vitest runner can import it without instantiating a second copy of the glue.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** An encoder: the render module's `encodeWav(sampleRate, channels, options)`, or the package's over `{ sampleRate, channels }`. */
export type Encode = (
  sampleRate: number,
  channels: Float32Array[],
  options: Record<string, unknown>
) => Uint8Array;

/** Encodes every case of conformance/cases/wav/wav.json with `encode` and compares the bytes (or the message). */
export function runWavWith(encode: Encode): { total: number; failed: string[] } {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/wav/wav.json`, 'utf8')) as {
    cases: WavCase[];
  };
  const failed: string[] = [];
  for (const spec of file.cases) {
    const channels = spec.channels.map((channel) => Float32Array.from(channel, sample));
    try {
      const bytes = hex(encode(spec.sampleRate, channels, spec.options));
      if (spec.error !== undefined) failed.push(`${spec.id}: expected ${spec.error}, got bytes`);
      else if (bytes !== spec.bytes) failed.push(`${spec.id}: the bytes differ`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== spec.error) failed.push(`${spec.id}: threw ${message}`);
    }
  }
  return { total: file.cases.length, failed };
}
