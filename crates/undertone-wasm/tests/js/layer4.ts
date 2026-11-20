// Layer 4 of the corpus through the WebAssembly modules: each program rendered by the render module, against Chromium's summaries
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, with Bun:
//   bun crates/undertone-wasm/tests/js/layer4.ts
// For each case of conformance/cases/4/renders.json the program is built through the harness, its voices are collected by the main
// module (`collectVoices`), and the render module renders them (`renderVoices`), as `renderToBuffer` will by default (D-14). Each
// channel is summarised as conformance/recorder/renderSummary.ts summarises Chromium's (RMS, peak, eight FFT bands, 0.1 s windows)
// and held to the tolerances crates/undertone-engine/tests/layer4.rs enforces: the proposed ones (limiter off: RMS 0.01 dB, peak
// 0.02, band 0.1, window 0.05; limiter on: RMS 0.05, peak 0.1), or a quirk case's documented guard. Bands and windows under -80 dBFS
// on both sides are not compared. Any case outside its tolerance exits non-zero.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from '../../../../conformance/recorder/programs';
import type { Reference } from '../../../../conformance/recorder/reference';
import { lib, scheduler, wasm, Pattern } from './harness.ts';
import { render } from './render.ts';
import { checkRender } from './renderCompare.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const wasmRef = { root, lib, scheduler } as unknown as Reference;

if (import.meta.main) {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/4/renders.json`, 'utf8')) as {
    cases: Record<string, unknown>[];
  };
  const failures: string[] = [];
  for (const spec of file.cases) {
    const id = spec.id as string;
    const options = spec.render as Record<string, unknown>;
    const built = build(wasmRef, spec.program as never);
    if ('error' in built) {
      failures.push(`${id}: the program throws ${built.error}`);
      continue;
    }
    const voices = wasm.collectVoices((built.pattern as unknown as Pattern).handle, options);
    const [numbers, strings] = voices.encoded();
    const out = render.renderVoices(numbers, strings, voices.options) as {
      sampleRate: number;
      channels: Float32Array[];
    };
    voices.free();
    const checked = checkRender(spec, out);
    failures.push(...checked.failures);
    console.log(checked.line);
  }
  console.log(
    `layer 4: ${file.cases.length - new Set(failures.map((f) => f.split(':')[0])).size} of ${file.cases.length} within their tolerances`
  );
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  if (failures.length > 0) process.exit(1);
}
