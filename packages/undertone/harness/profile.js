// Times a ladder of small patterns through the worklet, so a device's hot spots show as the differences between steps
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as undertone from '../dist/index.js';
import { createWorkletOutput } from '../dist/worklet.js';

const $ = (id) => document.getElementById(id);
const WARM_UP_MS = 2000;
const BPM = 110;
const { note, sound, stack } = undertone;

const label = (() => {
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
  return `${name} on ${os} (profile)`;
})();
$('label').value = label;

/** The ladder: each step is named for what it adds, and `above` names the step its cost is measured against. */
function ladder() {
  const drums = stack(
    note('c1*4').sound('sine').penv(18).pdecay(0.06).decay(0.22).gain(0.9),
    sound('white*8').decay(0.03).gain(0.25).lpf(9000),
    sound('~ white ~ white').decay(0.12).gain(0.35).lpf(5000)
  );
  const bass = note('c2 [c2 eb2] g1 [bb1 c2]')
    .sound('sawtooth')
    .lpf(380)
    .lpenv(1800)
    .lpd(0.14)
    .decay(0.18)
    .gain(0.5);
  const pad = note('<[c4,eb4,g4,bb4] [ab3,c4,eb4,g4] [f3,ab3,c4,eb4] [g3,b3,d4,f4]>')
    .sound('triangle')
    .attack(0.02)
    .release(0.5)
    .gain(0.35);
  const lead = note('g4 bb4 d5 c5 [eb5 d5] c5 bb4 g4')
    .sound('sine')
    .fm(2)
    .fmh(2)
    .decay(0.2)
    .gain(0.3);
  return [
    { name: 'nothing playing', pattern: note('~').sound('sine') },
    { name: 'drums (dry)', pattern: drums, above: 'nothing playing' },
    { name: 'bass (dry)', pattern: bass, above: 'nothing playing' },
    { name: 'chords (dry)', pattern: pad, above: 'nothing playing' },
    { name: 'lead, fm (dry)', pattern: lead, above: 'nothing playing' },
    { name: 'all four (dry)', pattern: stack(drums, bass, pad, lead), above: 'nothing playing' },
    { name: 'chords + delay', pattern: pad.delay(0.3), above: 'chords (dry)' },
    { name: 'chords + reverb', pattern: pad.room(0.5), above: 'chords (dry)' },
    { name: 'lead + reverb', pattern: lead.room(0.3), above: 'lead, fm (dry)' },
    {
      name: 'all four + reverb and delay',
      pattern: stack(drums, bass, pad.room(0.5).delay(0.3), lead.room(0.3).delay(0.4)),
      above: 'all four (dry)'
    }
  ];
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const f = (v, d = 3) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
const log = (text) => {
  $('log').textContent += `${text}\n`;
};

async function step(item, seconds) {
  const context = new AudioContext({ latencyHint: 'playback' });
  await context.resume();
  const output = await createWorkletOutput(context, {
    channels: 2,
    seed: 'profile',
    clock: 'spin'
  });
  output.onerror = (m) => log(`worklet (${item.name}): ${m}`);
  const loop = output.loop(item.pattern, { cycles: 4, bpm: BPM });
  await loop.ready;
  await pause(WARM_UP_MS);
  output.resetStats();
  await pause(seconds * 1000);
  const stats = await output.stats();
  loop.stop();
  output.close();
  await context.close();
  return {
    blocks: stats.blocks,
    mean: stats.processMs?.mean ?? null,
    p50: stats.processMs?.p50 ?? null,
    p99: stats.processMs?.p99 ?? null,
    max: stats.processMs?.max ?? null,
    overruns: stats.overruns,
    budgetMs: stats.budgetMs,
    liveNodes: stats.liveNodes,
    sampleRate: stats.sampleRate
  };
}

async function runAll() {
  $('run').disabled = true;
  $('copy').disabled = true;
  $('table').querySelector('tbody').replaceChildren();
  $('log').textContent = '';
  const seconds = Number($('seconds').value);
  const results = {
    label: $('label').value.trim() || label,
    kind: 'profile',
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    secondsPerStep: seconds,
    bpm: BPM,
    steps: {}
  };
  try {
    for (const item of ladder()) {
      $('status').textContent = `${item.name}...`;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${item.name}</td><td colspan="5">running...</td>`;
      $('table').querySelector('tbody').append(tr);
      try {
        const r = await step(item, seconds);
        results.steps[item.name] = { ...r, above: item.above ?? null };
        const base = item.above ? results.steps[item.above]?.mean : null;
        const delta =
          base === null || base === undefined || r.mean === null
            ? ''
            : `${r.mean - base >= 0 ? '+' : ''}${f(r.mean - base)} ms`;
        tr.innerHTML = `<td>${item.name}</td><td>${f(r.mean)}</td><td>${f(r.p50)}</td><td>${f(r.p99)}</td><td>${r.overruns} of ${r.blocks}</td><td>${delta}</td>`;
      } catch (error) {
        results.steps[item.name] = { error: String(error?.message ?? error) };
        tr.innerHTML = `<td>${item.name}</td><td colspan="5">failed: ${error?.message ?? error}</td>`;
      }
      await pause(500);
    }
  } finally {
    results.finishedAt = new Date().toISOString();
    const text = JSON.stringify(results, null, 2);
    $('copy').disabled = false;
    $('copy').onclick = () => navigator.clipboard?.writeText(text);
    try {
      const response = await fetch('/results', {
        method: 'POST',
        body: text,
        headers: { 'Content-Type': 'application/json' }
      });
      $('status').textContent = response.ok
        ? 'Done. Results sent.'
        : `Done, but the server refused the results (${response.status}); use Copy results.`;
    } catch (error) {
      $('status').textContent =
        `Done, but the results could not be sent (${error?.message ?? error}); use Copy results.`;
    }
    $('run').disabled = false;
  }
}

$('run').onclick = runAll;
