// The page side of the browser render: builds a program's pattern, renders it with the library, and summarises it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as lib from '../../src/index';
import { interpret } from './interpret';
import type { Program } from './interpret';
import type { Reference } from './reference';
import { summarise } from './renderSummary';
import type { RenderSummary } from './renderSummary';

/** Renders a program with the real `OfflineAudioContext` of the page and returns the summary of the samples. */
async function undertoneRender(
  program: Program,
  render: Parameters<typeof lib.renderToBuffer>[1]
): Promise<RenderSummary> {
  const pattern = interpret({ lib } as unknown as Reference, program);
  const buffer = await lib.renderToBuffer(pattern as never, render);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
    buffer.getChannelData(c)
  );
  return summarise(channels, buffer.sampleRate);
}

(globalThis as { undertoneRender?: typeof undertoneRender }).undertoneRender = undertoneRender;
