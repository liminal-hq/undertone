// The WAV corpus through the render module's encodeWav: every case's bytes, or its message, exactly
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, with Bun:
//   bun crates/undertone-wasm/tests/js/wav.ts
// Each case of conformance/cases/wav/wav.json is encoded with the render module's `encodeWav(sampleRate, channels, options)` and
// its bytes compared with the recorded hex, byte for byte; an error case must throw the recorded message word for word
// (wavCases.ts, which the package's runner shares).

import { render } from './render.ts';
import { runWavWith } from './wavCases.ts';

/** The corpus through the render module. */
export function runWav(): { total: number; failed: string[] } {
  return runWavWith((sampleRate, channels, options) =>
    render.encodeWav(sampleRate, channels, options)
  );
}

if (import.meta.main) {
  const { total, failed } = runWav();
  console.log(`wav: ${total - failed.length} of ${total} equal, ${failed.length} failed`);
  for (const failure of failed) console.log(`  FAIL ${failure}`);
  if (failed.length > 0) process.exit(1);
}
