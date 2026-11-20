// A speed probe: the same work as a JavaScript loop, in a worker, and as an offline WebAssembly render, with no sound
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as undertone from '../dist/index.js';
import { harnessPatterns } from './patterns.js';

const out = document.getElementById('out');
const loopSource = `
  function work(n) { let x = 0; for (let i = 1; i <= n; i++) x += Math.sin(i) * Math.sqrt(i); return x; }
  onmessage = (e) => {
    const best = [];
    for (let r = 0; r < 5; r++) { const t = performance.now(); work(e.data); best.push(performance.now() - t); }
    postMessage(best);
  };
`;

function work(n) {
  let x = 0;
  for (let i = 1; i <= n; i++) x += Math.sin(i) * Math.sqrt(i);
  return x;
}

const round = (list) => list.map((v) => Number(v.toFixed(1)));

async function run() {
  document.getElementById('run').disabled = true;
  const result = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    isSecureContext: self.isSecureContext
  };
  out.textContent = 'JavaScript loop on the page...';
  await new Promise((r) => setTimeout(r));
  const page = [];
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    work(3_000_000);
    page.push(performance.now() - t);
  }
  result.jsLoopOnPageMs = round(page);

  out.textContent = 'JavaScript loop in a worker...';
  const worker = new Worker(
    URL.createObjectURL(new Blob([loopSource], { type: 'text/javascript' }))
  );
  result.jsLoopInWorkerMs = round(
    await new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(3_000_000);
    })
  );
  worker.terminate();

  out.textContent = 'WebAssembly render (two seconds of Light, five times)...';
  await new Promise((r) => setTimeout(r));
  try {
    const light = harnessPatterns(undertone).light;
    const renders = [];
    for (let r = 0; r < 5; r++) {
      const t = performance.now();
      await undertone.renderToBuffer(light, { seconds: 2, sampleRate: 48000, channels: 2 });
      renders.push(performance.now() - t);
    }
    result.wasmRenderTwoSecondsLightMs = round(renders);
  } catch (error) {
    result.wasmRenderError = String(error?.message ?? error);
  }
  result.note =
    'Lower is faster. The first of each list includes warm-up. Compare the last values across browsers and machines.';
  const text = JSON.stringify(result, null, 2);
  out.textContent = text;
  const copy = document.getElementById('copy');
  copy.disabled = false;
  copy.onclick = () => navigator.clipboard?.writeText(text);
  document.getElementById('run').disabled = false;
}

document.getElementById('run').onclick = run;
