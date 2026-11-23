// Benches the module and context paths we would ship on the real song patterns, in the AudioWorklet backend
// Note: it loads wasm builds from `../wasm/variants/<id>/` (undertone_worklet.js and undertone_worklet_bg.wasm), which are not committed;
// the server that serves the harness provides them, and a missing variant shows as a failed row.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as undertone from '../dist/index.js';
import { createWorkletOutput } from '../dist/worklet.js';
import { harnessPatterns } from './patterns.js';

const $ = (id) => document.getElementById(id);
const WARM_UP_MS = 2000;
const BPM = 110;
const SONGS = ['representative', 'heavy'];
const dir = (id) => ({
  wasmUrl: new URL(`../wasm/variants/${id}/undertone_worklet_bg.wasm`, import.meta.url),
  glueUrl: new URL(`../wasm/variants/${id}/undertone_worklet.js`, import.meta.url)
});

const PATHS = [
  { id: 'current', name: 'current module', ...dir('baseline') },
  { id: 'simd-b8', name: 'SIMD, 8-bin blocks', ...dir('simd-b8') },
  { id: 'simd-b8-32k', name: 'SIMD at a 32 kHz context', ...dir('simd-b8'), sampleRate: 32000 },
  { id: 'simd-b8-room2', name: 'SIMD, reverb room size 2', ...dir('simd-b8'), roomsize: 2 },
  { id: 'current-again', name: 'current module (again)', ...dir('baseline'), reference: 'current' },
  {
    id: 'simd-b8-again',
    name: 'SIMD, 8-bin blocks (again)',
    ...dir('simd-b8'),
    reference: 'simd-b8'
  }
];

const defaultLabel = (() => {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Linux/.test(ua)
        ? 'Linux'
        : /Mac/.test(ua)
          ? 'Mac'
          : '';
  return `${name} on ${os} (bench)`;
})();
$('label').value = defaultLabel;

// The smallest module that uses a 128-bit vector instruction, to see whether this browser accepts SIMD at all.
const simdOk = WebAssembly.validate(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253,
    15, 253, 98, 11
  ])
);
$('simd').textContent = `This browser ${simdOk ? 'accepts' : 'does NOT accept'} WebAssembly SIMD.`;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const f = (v, d = 3) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
const log = (text) => ($('log').textContent += `${text}\n`);
const state = { results: [], started: null };

async function runOne(path, song, seconds) {
  const songs = harnessPatterns(undertone);
  const pattern = path.roomsize ? songs[song].roomsize(path.roomsize) : songs[song];
  const context = new AudioContext({
    latencyHint: 'playback',
    ...(path.sampleRate ? { sampleRate: path.sampleRate } : {})
  });
  await context.resume();
  try {
    const output = await createWorkletOutput(context, {
      channels: 2,
      seed: 'bench',
      clock: 'spin',
      wasm: path.wasmUrl,
      glueUrl: path.glueUrl
    });
    output.onerror = (m) => log(`worklet: ${m}`);
    const loop = output.loop(pattern, { cycles: 4, bpm: BPM });
    await loop.ready;
    await pause(WARM_UP_MS);
    output.resetStats();
    await pause(seconds * 1000);
    const s = await output.stats();
    loop.stop();
    output.close();
    return {
      blocks: s.blocks,
      mean: s.processMs?.mean ?? null,
      p50: s.processMs?.p50 ?? null,
      p99: s.processMs?.p99 ?? null,
      max: s.processMs?.max ?? null,
      overruns: s.overruns,
      budgetMs: s.budgetMs,
      sampleRate: s.sampleRate
    };
  } finally {
    await context.close();
  }
}

function finish() {
  const results = {
    label: $('label').value.trim() || defaultLabel,
    kind: 'bench',
    startedAt: state.started,
    finishedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    simd: simdOk,
    crossOriginIsolated: self.crossOriginIsolated,
    secondsPerRun: Number($('seconds').value),
    bpm: BPM,
    results: state.results
  };
  const text = JSON.stringify(results, null, 2);
  $('copy').disabled = false;
  $('copy').onclick = () => navigator.clipboard?.writeText(text);
  return fetch('/results', {
    method: 'POST',
    body: text,
    headers: { 'Content-Type': 'application/json' }
  })
    .then(
      (r) =>
        ($('status').textContent = r.ok
          ? 'Done. Results sent.'
          : `Done, but the server refused the results (${r.status}); use Copy results.`)
    )
    .catch(
      (e) =>
        ($('status').textContent =
          `Done, but the results could not be sent (${e?.message ?? e}); use Copy results.`)
    );
}

$('run').onclick = async () => {
  $('run').disabled = true;
  $('copy').disabled = true;
  $('table').querySelector('tbody').replaceChildren();
  $('log').textContent = '';
  state.results = [];
  state.started = new Date().toISOString();
  const seconds = Number($('seconds').value);
  const current = {};
  try {
    for (const song of SONGS) {
      for (const path of PATHS) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${path.name}</td><td>${song}</td><td colspan="4">running...</td>`;
        $('table').querySelector('tbody').append(tr);
        $('status').textContent = `${path.name}, ${song}...`;
        let r;
        try {
          r = await runOne(path, song, seconds);
        } catch (error) {
          tr.innerHTML = `<td>${path.name}</td><td>${song}</td><td colspan="4" class="bad">failed: ${error?.message ?? error}</td>`;
          state.results.push({
            id: path.id,
            name: path.name,
            song,
            error: String(error?.message ?? error)
          });
          continue;
        }
        if (path.id === 'current') current[song] = r;
        const ref = path.id === 'current' ? null : current[song];
        const ratio = ref?.mean ? r.mean / ref.mean : null;
        const cls = ratio === null ? '' : ratio < 0.9 ? 'good' : ratio > 1.1 ? 'bad' : '';
        tr.innerHTML = `<td>${path.name}</td><td>${song}</td><td>${f(r.mean)}</td><td>${f(r.p99)}</td><td>${r.overruns} of ${r.blocks}</td><td class="${cls}">${ratio === null ? '(reference)' : `${f(ratio, 2)}x`}</td>`;
        state.results.push({ id: path.id, name: path.name, song, ...r, ratioToCurrent: ratio });
        await pause(500);
      }
    }
  } finally {
    await finish();
    $('run').disabled = false;
  }
};
