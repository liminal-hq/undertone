// Bun script: records the five programs' graphs through the bridge and diffs them with the corpus and a live reference run
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { note } from '@liminal-hq/undertone';
import { FakeAudioContext } from '../../../../src/test-utils/fakeAudioContext';
import { playVoice, resolveParams } from '../../../../src/engine';
import { describeGraph, track } from '../../../../conformance/recorder/graph';
import { programs } from './programs.mjs';

const corpus = JSON.parse(
  readFileSync(new URL('../../../../conformance/cases/3/placement.json', import.meta.url), 'utf8')
);

// The corpus's own bytes: it is written with numbers to nine digits through JSON.stringify of the record.
function canonical(value: unknown): string {
  return JSON.stringify(JSON.parse(JSON.stringify(value)));
}

let failures = 0;
const rows: unknown[] = [];
for (const program of programs) {
  const recorded = corpus.cases.find((c: { id: string }) => c.id === program.id);
  const patch = JSON.parse(recorded.score[0].replace(/^v0 @\S+ /, ''));

  // The TypeScript reference, run live on a fake context.
  const reference = new FakeAudioContext();
  const referenceNodes = track(reference);
  playVoice(reference as never, resolveParams(patch), 0);
  const referenceGraph = describeGraph(reference, referenceNodes, null);

  // The bridge: Rust books, TypeScript replays on a fake context.
  const bridged = new FakeAudioContext();
  const bridgedNodes = track(bridged);
  program.build(note).play({ context: bridged as never, at: 0 });
  const bridgeGraph = describeGraph(bridged, bridgedNodes, null);

  const vsCorpus = canonical(bridgeGraph) === canonical(recorded.graph);
  const vsLive = canonical(bridgeGraph) === canonical(referenceGraph);
  const referenceVsCorpus = canonical(referenceGraph) === canonical(recorded.graph);
  if (!vsCorpus || !vsLive) failures++;
  rows.push({
    id: program.id,
    nodes: (bridgeGraph as { counts: { total: number } }).counts.total,
    bytes: canonical(bridgeGraph).length,
    bridgeEqualsCorpus: vsCorpus,
    bridgeEqualsLiveReference: vsLive,
    liveReferenceEqualsCorpus: referenceVsCorpus
  });
  if (!vsCorpus) {
    console.error(program.id, 'bridge', canonical(bridgeGraph));
    console.error(program.id, 'corpus', canonical(recorded.graph));
  }
}
console.log(JSON.stringify(rows, null, 2));
console.log(failures === 0 ? 'ALL FIVE EQUAL' : `${failures} DIFFER`);
process.exit(failures === 0 ? 0 : 1);
