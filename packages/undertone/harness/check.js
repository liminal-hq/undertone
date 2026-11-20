// The page side of the worklet correctness check: the worklet's output against the package's offline render, sample for sample
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as undertone from '../dist/index.js';
import { createWorkletOutput } from '../dist/worklet.js';
import { harnessPatterns } from './patterns.js';

const sampleRate = 48000;
const options = { cycles: 1, bpm: 110, sampleRate, seed: 'check', tail: 0.5 };

async function compare(name, pattern, channels) {
  const expected = await undertone.renderToBuffer(pattern, { ...options, channels });
  const length = expected.length;
  const context = new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate });
  const output = await createWorkletOutput(context, { channels, seed: 'check' });
  const errors = [];
  output.onerror = (message) => errors.push(message);
  // The pass starts at frame 0 of the context; the worklet holds it until its first block and then books it.
  await output.play(pattern, { cycles: 1, bpm: 110, when: 0 }).ready;
  const rendered = await context.startRendering();
  let worst = 0;
  let differing = 0;
  let first = -1;
  let loud = 0;
  for (let c = 0; c < channels; c += 1) {
    const got = rendered.getChannelData(c);
    const want = expected.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      const diff = Math.abs(got[i] - want[i]);
      if (diff > 0) {
        differing += 1;
        if (first < 0) first = i;
      }
      if (diff > worst) worst = diff;
      if (Math.abs(want[i]) > 0.01) loud += 1;
    }
  }
  return { name, channels, length, worst, differing, first, loud, timing: output.timing, errors };
}

try {
  const patterns = harnessPatterns(undertone);
  const results = [];
  results.push(await compare('representative', patterns.representative, 2));
  results.push(await compare('light', patterns.light, 2));
  results.push(await compare('light, mono', patterns.light, 1));
  const report = {
    userAgent: navigator.userAgent,
    audioWorklet: typeof AudioWorkletNode === 'function',
    results
  };
  window.checkResult = report;
  document.getElementById('out').textContent = JSON.stringify(report, null, 2);
} catch (error) {
  window.checkResult = { error: String(error?.stack ?? error) };
  document.getElementById('out').textContent = String(error?.stack ?? error);
}
