// Runs corpus layers 3 and 4 and the WAV corpus through the package: booked graphs, renders, and WAV bytes from the public API
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Layer 3 runs the recorder's own code (conformance/recorder/graph.ts, `recordLayer3`) with the package as the reference:
// `playVoice` and `seedContext` from `./testing`, `createMasterBus`, `createMonoFold`, `enableMultichannel`, `registerSample`,
// `renderToBuffer` with a `context` and `score().render`, on the repository's fake contexts. So every booking goes through the
// Web Audio backend's replayer, and every render case through the render module's booking on the caller's offline context. The
// records are compared with conformance/cases/3 by the comparator of the Rust runner (crates/undertone-wasm/tests/js/
// graphCompare.ts). Layer 4 renders each program with the package's `renderToBuffer` (the render module, D-14) and holds it to
// Chromium's summaries (renderCompare.ts); the WAV corpus goes through the package's `encodeWav` (wavCases.ts).

import { readFileSync } from 'node:fs';
import * as pkg from '@liminal-hq/undertone';
import { playVoice, seedContext } from '@liminal-hq/undertone/testing';
import { recordLayer3 } from '../../../../conformance/recorder/graph';
import { layer3Cases } from '../../../../conformance/recorder/graphData';
import { serialiseFile } from '../../../../conformance/recorder/format';
import type { Json } from '../../../../conformance/recorder/format';
import { build } from '../../../../conformance/recorder/programs';
import type { Reference } from '../../../../conformance/recorder/reference';
import { compare } from '../../../../crates/undertone-wasm/tests/js/graphCompare';
import { checkRender } from '../../../../crates/undertone-wasm/tests/js/renderCompare';
import { runWavWith } from '../../../../crates/undertone-wasm/tests/js/wavCases';
import { lib, root, scheduler } from './runner';

/** The package as the recorder's reference, with the two internals the recorder reads taken from `./testing`. */
const packageReference = {
  root,
  lib,
  engine: { playVoice, resolveParams: pkg.resolveParams },
  random: { seedContext },
  scheduler
} as unknown as Reference;

export interface Layer3Result {
  group: string;
  cases: number;
  passed: number;
  floor: string[];
  failed: string[];
}

/** Records every layer 3 case through the package and compares it with the corpus, group by group. */
export async function runLayer3(): Promise<Layer3Result[]> {
  const warn = console.warn;
  console.warn = () => undefined; // the corpus records values, not logs (the recorder's own rule)
  try {
    const files = await recordLayer3(packageReference, layer3Cases());
    return files.map((file) => {
      const mine = JSON.parse(serialiseFile(file)) as { cases: (Json & { id: string })[] };
      const recorded = JSON.parse(
        readFileSync(`${root}conformance/cases/3/${file.group}.json`, 'utf8')
      ) as { cases: (Json & { id: string })[] };
      const result: Layer3Result = {
        group: file.group,
        cases: recorded.cases.length,
        passed: 0,
        floor: [],
        failed: []
      };
      if (mine.cases.length !== recorded.cases.length) {
        result.failed.push(`${mine.cases.length} cases made, ${recorded.cases.length} recorded`);
      }
      recorded.cases.forEach((expected, index) => {
        const diff = compare(expected, mine.cases[index] ?? null, expected.id);
        if (diff === 'floor') {
          result.floor.push(expected.id);
          result.passed += 1;
        } else if (diff) result.failed.push(diff);
        else result.passed += 1;
      });
      return result;
    });
  } finally {
    console.warn = warn;
  }
}

/** Renders every layer 4 case with the package's `renderToBuffer`; `level` scales the result (a negative control). */
export async function runLayer4(level = 1): Promise<{ cases: number; failed: string[] }> {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/4/renders.json`, 'utf8')) as {
    cases: Record<string, unknown>[];
  };
  const failed: string[] = [];
  for (const spec of file.cases) {
    const built = build(packageReference, spec.program as never);
    if ('error' in built) {
      failed.push(`${String(spec.id)}: the program throws ${built.error}`);
      continue;
    }
    const rendered = await pkg.renderToBuffer(
      built.pattern as never,
      spec.render as pkg.RenderOptions
    );
    const channels: Float32Array[] = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      channels.push(rendered.getChannelData(c).map((sample) => sample * level));
    }
    failed.push(...checkRender(spec, { sampleRate: rendered.sampleRate, channels }).failures);
  }
  return { cases: file.cases.length, failed };
}

/** Encodes every WAV case with the package's `encodeWav`; `nudge` moves the first sample (a negative control). */
export function runWav(nudge = 0): { total: number; failed: string[] } {
  return runWavWith((sampleRate, channels, options) => {
    if (nudge !== 0 && channels[0]?.length > 0) channels[0][0] += nudge;
    return pkg.encodeWav({ sampleRate, channels }, options as pkg.WavOptions);
  });
}
