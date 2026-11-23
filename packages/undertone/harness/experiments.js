// Runs the reverb steps of the ladder under different worklet module builds and different context settings, beside controls
// Note: it loads wasm builds from `../wasm/variants/<id>/` (undertone_worklet.js and undertone_worklet_bg.wasm), which are not committed;
// the server that serves the harness provides them, and a missing variant shows as a failed row.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as undertone from '../dist/index.js';
import { createWorkletOutput } from '../dist/worklet.js';

const $ = (id) => document.getElementById(id);
const WARM_UP_MS = 2000;
const BPM = 110;
const { note } = undertone;
const VARIANTS = new URL('../wasm/variants/manifest.json', import.meta.url);

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
  return `${name} on ${os} (experiments)`;
})();
$('label').value = defaultLabel;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const f = (v, d = 3) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
const log = (text) => {
  $('log').textContent += `${text}\n`;
};

const pad = () =>
  note('<[c4,eb4,g4,bb4] [ab3,c4,eb4,g4] [f3,ab3,c4,eb4] [g3,b3,d4,f4]>')
    .sound('triangle')
    .attack(0.02)
    .release(0.5)
    .gain(0.35);
const lead = () =>
  note('g4 bb4 d5 c5 [eb5 d5] c5 bb4 g4').sound('sine').fm(2).fmh(2).decay(0.2).gain(0.3);
/** The two steps every experiment plays: the reverb on chords, and on the lead. */
const steps = (extra = (p) => p) => [
  { step: 'chords + reverb', pattern: extra(pad().room(0.5)) },
  { step: 'lead + reverb', pattern: extra(lead().room(0.3)) }
];

/** The experiments that need no new module: what changes is the context, the channels, or the pattern. */
const CONTEXT = [
  { id: 'control', name: 'control (stereo, 48 kHz or the device rate, playback hint)', run: {} },
  { id: 'mono', name: 'mono output (1 channel)', run: { channels: 1 } },
  { id: 'rate-44100', name: 'context at 44.1 kHz', run: { sampleRate: 44100 } },
  { id: 'rate-32000', name: 'context at 32 kHz', run: { sampleRate: 32000 } },
  { id: 'rate-24000', name: 'context at 24 kHz', run: { sampleRate: 24000 } },
  {
    id: 'latency-interactive',
    name: 'latency hint "interactive"',
    run: { latencyHint: 'interactive' }
  },
  { id: 'latency-0.05', name: 'latency hint 0.05 s', run: { latencyHint: 0.05 } },
  { id: 'latency-0.2', name: 'latency hint 0.2 s', run: { latencyHint: 0.2 } },
  { id: 'busy-worker', name: 'a worker keeps another core busy', run: { busyWorker: true } },
  {
    id: 'roomsize-1',
    name: 'reverb room size 1 (a 0.7 s tail)',
    run: { pattern: (p) => p.roomsize(1) }
  },
  {
    id: 'roomsize-2',
    name: 'reverb room size 2 (a 0.9 s tail)',
    run: { pattern: (p) => p.roomsize(2) }
  },
  {
    id: 'roomsize-5',
    name: 'reverb room size 5 (a 2.4 s tail)',
    run: { pattern: (p) => p.roomsize(5) }
  },
  { id: 'control-again', name: 'control again (to see drift across the session)', run: {} }
];

const busySource = 'while (true) {}';

async function runOne(
  {
    wasmUrl,
    glueUrl,
    channels = 2,
    sampleRate,
    latencyHint = 'playback',
    busyWorker = false,
    pattern
  },
  seconds
) {
  const context = new AudioContext({ latencyHint, ...(sampleRate ? { sampleRate } : {}) });
  await context.resume();
  let busy;
  if (busyWorker)
    busy = new Worker(URL.createObjectURL(new Blob([busySource], { type: 'text/javascript' })));
  try {
    const options = { channels, seed: 'experiments', clock: 'spin' };
    if (wasmUrl) options.wasm = wasmUrl;
    if (glueUrl) options.glueUrl = glueUrl;
    const output = await createWorkletOutput(context, options);
    output.onerror = (m) => log(`worklet: ${m}`);
    const loop = output.loop(pattern, { cycles: 4, bpm: BPM });
    await loop.ready;
    await pause(WARM_UP_MS);
    output.resetStats();
    await pause(seconds * 1000);
    const stats = await output.stats();
    loop.stop();
    output.close();
    return {
      blocks: stats.blocks,
      mean: stats.processMs?.mean ?? null,
      p50: stats.processMs?.p50 ?? null,
      p99: stats.processMs?.p99 ?? null,
      overruns: stats.overruns,
      budgetMs: stats.budgetMs,
      sampleRate: stats.sampleRate
    };
  } finally {
    busy?.terminate();
    await context.close();
  }
}

const state = { results: [], started: null };

/** One experiment: both steps, each row beside the control's matching row that ran nearest (the one before it). */
async function experiment(group, id, name, opts, seconds, control) {
  const rows = [];
  for (const { step, pattern } of steps(opts.pattern)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${group}</td><td>${name}</td><td>${step}</td><td colspan="4">running...</td>`;
    $('table').querySelector('tbody').append(tr);
    $('status').textContent = `${name}: ${step}...`;
    let r;
    try {
      r = await runOne({ ...opts, pattern }, seconds);
    } catch (error) {
      tr.innerHTML = `<td>${group}</td><td>${name}</td><td>${step}</td><td colspan="4" class="bad">failed: ${error?.message ?? error}</td>`;
      state.results.push({ group, id, name, step, error: String(error?.message ?? error) });
      continue;
    }
    const ref = control?.[step];
    const ratio = ref && ref.mean ? r.mean / ref.mean : null;
    const cls = ratio === null ? '' : ratio < 0.9 ? 'good' : ratio > 1.1 ? 'bad' : '';
    tr.innerHTML = `<td>${group}</td><td>${name}</td><td>${step}</td><td>${f(r.mean)}</td><td>${f(r.p99)}</td><td>${r.overruns} of ${r.blocks}</td><td class="${cls}">${ratio === null ? '(control)' : `${f(ratio, 2)}x`}</td>`;
    rows.push([step, r]);
    state.results.push({
      group,
      id,
      name,
      step,
      ...r,
      controlMean: ref?.mean ?? null,
      ratioToControl: ratio,
      sampleRate: r.sampleRate
    });
    await pause(400);
  }
  return Object.fromEntries(rows);
}

async function loadVariants() {
  try {
    const response = await fetch(VARIANTS);
    if (!response.ok) return [];
    const manifest = await response.json();
    return manifest.variants ?? [];
  } catch {
    return [];
  }
}

function finish() {
  const results = {
    label: $('label').value.trim() || defaultLabel,
    kind: 'experiments',
    startedAt: state.started,
    finishedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    secondsPerStep: Number($('seconds').value),
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

function begin() {
  $('runModules').disabled = true;
  $('runContext').disabled = true;
  $('copy').disabled = true;
  $('table').querySelector('tbody').replaceChildren();
  $('log').textContent = '';
  state.results = [];
  state.started = new Date().toISOString();
  return Number($('seconds').value);
}
function end() {
  $('runModules').disabled = false;
  $('runContext').disabled = false;
}

$('runContext').onclick = async () => {
  const seconds = begin();
  try {
    let control;
    for (const item of CONTEXT) {
      const out = await experiment(
        'context',
        item.id,
        item.name,
        item.run,
        seconds,
        item.id === 'control' ? undefined : control
      );
      if (item.id === 'control') control = out;
    }
  } finally {
    await finish();
    end();
  }
};

$('runModules').onclick = async () => {
  const variants = await loadVariants();
  if (variants.length === 0) {
    $('status').textContent = 'No module variants are served from this page yet.';
    return;
  }
  const seconds = begin();
  const base = variants.find((v) => v.id === 'baseline') ?? variants[0];
  const urlsOf = (v) => ({
    wasmUrl: new URL(`../wasm/variants/${v.wasm}`, import.meta.url),
    glueUrl: new URL(`../wasm/variants/${v.glue}`, import.meta.url)
  });
  try {
    let control;
    let sinceControl = 0;
    const order = variants.filter((v) => v.id !== base.id);
    // The control runs first and again after every three variants, so a device that slows or speeds up shows in the controls.
    for (let i = -1; i < order.length; i++) {
      if (i === -1 || sinceControl === 3) {
        control = await experiment(
          'module',
          base.id,
          `${base.name} (control)`,
          urlsOf(base),
          seconds,
          i === -1 ? undefined : control
        );
        sinceControl = 0;
        if (i === -1) continue;
      }
      const v = order[i];
      await experiment(
        'module',
        v.id,
        v.name + (v.bitIdentical === false ? ' (changes output bits)' : ''),
        urlsOf(v),
        seconds,
        control
      );
      sinceControl++;
    }
    control = await experiment(
      'module',
      base.id,
      `${base.name} (control, end of session)`,
      urlsOf(base),
      seconds,
      control
    );
  } finally {
    await finish();
    end();
  }
};

(async () => {
  const variants = await loadVariants();
  $('variantCount').textContent = variants.length ? `${variants.length}` : 'none yet';
  for (const v of variants) {
    const li = document.createElement('li');
    li.textContent = `${v.id}: ${v.description ?? v.name} (${v.bytes ?? '?'} bytes${v.simd ? ', simd128' : ''}${v.bitIdentical === false ? ', changes output bits' : ''})`;
    $('variantList').append(li);
  }
})();
