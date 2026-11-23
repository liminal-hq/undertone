// Times the TypeScript reference engine against the WebAssembly engine (size, speed and SIMD builds) on the same songs: offline render speed, and main-thread cost in real time
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as wasmApi from '../dist/index.js';
import { createWorkletOutput, supportsSimd } from '../dist/worklet.js';
import { glue } from '../dist/wasm.js';
import { handleOfPattern } from '../dist/pattern.js';
import { defaultCpm } from '../dist/scheduler.js';
import { harnessPatterns } from './patterns.js';

const $ = (id) => document.getElementById(id);
const BPM = 110;
const SAMPLE_RATE = 48000;
const RUNS = 3;
const WARM_UP_MS = 2000;
const SONGS = ['light', 'representative', 'heavy'];

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
  return `${name} on ${os} (headtohead)`;
})();
$('label').value = defaultLabel;

// The reference engine is the root package built to `./reference/` by scripts/harness-reference.sh.
let reference = null;
try {
  reference = await import('./reference/index.js');
} catch (error) {
  $('reference').textContent =
    'The TypeScript reference is missing: run scripts/harness-reference.sh at the repository root, then reload ' +
    `(${error?.message ?? error}).`;
  $('run').disabled = true;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const f = (v, d = 1) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
const log = (text) => ($('log').textContent += `${text}\n`);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const state = { offline: [], realtime: [], skipped: [], started: null };

function addRow(table, cells) {
  const tr = document.createElement('tr');
  for (const [text, cls] of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    tr.append(td);
  }
  $(table).querySelector('tbody').append(tr);
}

function levels(channels) {
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    count += data.length;
  }
  return { peak, rms: Math.sqrt(sum / count) };
}

const channelsOf = (buffer) =>
  Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));

// The largest absolute sample difference between two renders (Infinity when their shapes differ).
function maxDifference(a, b) {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let c = 0; c < a.length; c++) {
    if (a[c].length !== b[c].length) return Infinity;
    for (let i = 0; i < a[c].length; i++) {
      const d = Math.abs(a[c][i] - b[c][i]);
      if (d > max) max = d;
    }
  }
  return max;
}

// A render module loaded straight from its glue, as the package's render path loads its own: a dynamic import, then `init`.
async function loadModule(glueUrl, wasmUrl) {
  const mod = await import(glueUrl);
  await mod.default({ module_or_path: new URL(wasmUrl, import.meta.url) });
  return mod;
}

// The same render the package's `renderToBuffer` makes (the main module collects the voices), but run in `mod`.
function renderIn(mod, pattern, options) {
  const voices = glue.collectVoices(handleOfPattern(pattern), {
    ...options,
    defaultCpm: defaultCpm()
  });
  const [numbers, strings] = voices.encoded();
  const settings = voices.options;
  voices.free();
  return mod.renderVoices(numbers, strings, settings).channels;
}

async function renderOnce(engine, song, seconds) {
  const options = { bpm: BPM, seconds, sampleRate: SAMPLE_RATE, seed: 'headtohead' };
  const pattern = harnessPatterns(engine.api)[song];
  const start = performance.now();
  const channels = engine.module
    ? renderIn(engine.module, pattern, options)
    : channelsOf(await engine.api.renderToBuffer(pattern, options));
  const ms = performance.now() - start;
  return { ms, channels, ...levels(channels) };
}

async function offline(seconds) {
  const engines = [
    { id: 'typescript', name: 'TypeScript', api: reference },
    { id: 'wasm', name: 'WebAssembly, size build', api: wasmApi },
    {
      id: 'wasm-speed',
      name: 'WebAssembly, speed build',
      api: wasmApi,
      glueUrl: '../wasm/worklet/undertone_worklet.js',
      wasmUrl: '../wasm/worklet/undertone_worklet_bg.wasm'
    },
    {
      id: 'wasm-simd',
      name: 'WebAssembly, speed build with SIMD',
      api: wasmApi,
      glueUrl: '../wasm/worklet/undertone_worklet_simd.js',
      wasmUrl: '../wasm/worklet/undertone_worklet_simd_bg.wasm',
      needsSimd: true
    }
  ];
  for (const engine of [...engines]) {
    if (engine.needsSimd && !supportsSimd()) {
      const note =
        'This browser rejects WebAssembly SIMD (WebAssembly.validate), so the SIMD row is skipped.';
      log(note);
      $('skipped').textContent = note;
      state.skipped.push({ engine: engine.id, reason: 'simd-unsupported' });
      engines.splice(engines.indexOf(engine), 1);
    } else if (engine.glueUrl) {
      try {
        engine.module = await loadModule(engine.glueUrl, engine.wasmUrl);
      } catch (error) {
        const reason = String(error?.message ?? error);
        log(`${engine.name}: could not load (${reason}); its rows are skipped.`);
        state.skipped.push({ engine: engine.id, reason: `load-failed: ${reason}` });
        engines.splice(engines.indexOf(engine), 1);
      }
    }
  }
  for (const song of SONGS) {
    $('status').textContent = `Offline, ${song}: warming up...`;
    for (const engine of engines) {
      try {
        await renderOnce(engine, song, seconds);
      } catch {
        // reported by the timed runs below
      }
    }
    const runs = Object.fromEntries(engines.map((e) => [e.id, []]));
    const failed = new Set();
    const out = {};
    // Alternating order, so thermal drift lands on every engine.
    for (let i = 0; i < RUNS; i++) {
      for (const engine of engines) {
        if (failed.has(engine.id)) continue;
        $('status').textContent = `Offline, ${song}: ${engine.name}, run ${i + 1} of ${RUNS}...`;
        try {
          const r = await renderOnce(engine, song, seconds);
          runs[engine.id].push(r.ms);
          out[engine.id] = r;
        } catch (error) {
          log(`${engine.name}, ${song}: ${error?.message ?? error}`);
          state.offline.push({ engine: engine.id, song, error: String(error?.message ?? error) });
          failed.add(engine.id);
        }
        await pause(200);
      }
    }
    const medians = {};
    for (const engine of engines) {
      if (failed.has(engine.id)) {
        addRow('table', [[engine.name], [song], ['failed', 'bad'], [], [], [], [], [], []]);
        continue;
      }
      medians[engine.id] = median(runs[engine.id]);
    }
    for (const engine of engines) {
      if (medians[engine.id] === undefined) continue;
      const m = medians[engine.id];
      const ratio =
        engine.id !== 'typescript' && medians.typescript ? m / medians.typescript : null;
      const cls = ratio === null ? '' : ratio < 0.9 ? 'good' : ratio > 1.1 ? 'bad' : '';
      const o = out[engine.id];
      // The speed and SIMD builds are the size build's crate, so their samples should match its exactly.
      const compared =
        engine.module && out.wasm ? maxDifference(o.channels, out.wasm.channels) : null;
      const same = compared === null ? null : compared === 0;
      addRow('table', [
        [engine.name],
        [song],
        [runs[engine.id].map((t) => f(t)).join(' / ')],
        [f(m)],
        [`${f(seconds / (m / 1000), 1)}x`],
        [f(o.peak, 4)],
        [f(o.rms, 4)],
        [ratio === null ? '(reference)' : `${f(ratio, 2)}x`, cls],
        [
          compared === null
            ? '-'
            : same
              ? 'identical'
              : `differs, max ${compared.toExponential(2)}`,
          compared === null ? '' : same ? 'good' : 'bad'
        ]
      ]);
      state.offline.push({
        engine: engine.id,
        song,
        audioSeconds: seconds,
        runsMs: runs[engine.id],
        medianMs: m,
        timesRealTime: seconds / (m / 1000),
        peak: o.peak,
        rms: o.rms,
        ratioToTypeScript: ratio,
        identicalToSizeBuild: same,
        maxDifferenceFromSizeBuild: compared
      });
    }
  }
  const comparable = SONGS.every((song) => {
    const a = state.offline.find((r) => r.song === song && r.engine === 'typescript');
    const b = state.offline.find((r) => r.song === song && r.engine === 'wasm');
    return a && b && Math.abs(a.peak - b.peak) < 1e-3;
  });
  log(
    comparable
      ? 'The peaks of the TypeScript and size-build renders agree within 0.001 for every song.'
      : 'The peaks differ by more than 0.001 for at least one song: read the Peak column before comparing the times.'
  );
}

// Records the main thread's behaviour for `ms` while `start()` has an engine playing.
async function measureMainThread(ms) {
  const gaps = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 1);
  const tasks = [];
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    observer?.disconnect();
    observer = null;
  }
  const began = performance.now();
  await pause(ms);
  clearInterval(timer);
  const elapsed = performance.now() - began;
  observer?.disconnect();
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    seconds: elapsed / 1000,
    ticks: gaps.length,
    meanGapMs: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    p99GapMs: sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]
      : null,
    maxGapMs: sorted.length ? sorted[sorted.length - 1] : null,
    longTasksSupported: observer !== null,
    longTasks: tasks.length,
    longestTaskMs: tasks.length ? Math.max(...tasks) : null
  };
}

async function realtime(seconds) {
  const cases = [{ id: 'idle', name: 'nothing playing', song: '-' }];
  for (const song of SONGS) {
    cases.push({ id: 'typescript', name: 'TypeScript', song });
    cases.push({ id: 'wasm', name: 'WebAssembly (worklet)', song });
  }
  for (const c of cases) {
    $('status').textContent = `Real time: ${c.name}, ${c.song}...`;
    let stop = () => {};
    let context = null;
    try {
      if (c.id === 'typescript') {
        context = new AudioContext({ latencyHint: 'playback' });
        await context.resume();
        const handle = harnessPatterns(reference)[c.song].loop({ ctx: context, bpm: BPM });
        stop = () => handle.stop({ voices: 'cut' });
      } else if (c.id === 'wasm') {
        context = new AudioContext({ latencyHint: 'playback' });
        await context.resume();
        const output = await createWorkletOutput(context, {
          channels: 2,
          seed: 'headtohead',
          clock: 'spin'
        });
        const handle = output.loop(harnessPatterns(wasmApi)[c.song], { cycles: 4, bpm: BPM });
        await handle.ready;
        stop = () => {
          handle.stop();
          output.close();
        };
      }
      await pause(WARM_UP_MS);
      const r = await measureMainThread(seconds * 1000);
      addRow('rtTable', [
        [c.name],
        [c.song],
        [String(r.ticks)],
        [f(r.meanGapMs, 2)],
        [f(r.p99GapMs, 2)],
        [f(r.maxGapMs, 1)],
        [r.longTasksSupported ? String(r.longTasks) : 'n/a'],
        [r.longestTaskMs === null ? '-' : f(r.longestTaskMs, 0)]
      ]);
      state.realtime.push({ engine: c.id, song: c.song, ...r });
    } catch (error) {
      addRow('rtTable', [[c.name], [c.song], [`failed: ${error?.message ?? error}`, 'bad']]);
      state.realtime.push({ engine: c.id, song: c.song, error: String(error?.message ?? error) });
    } finally {
      stop();
      await context?.close().catch(() => {});
      await pause(500);
    }
  }
}

function finish() {
  const results = {
    label: $('label').value.trim() || defaultLabel,
    kind: 'headtohead',
    startedAt: state.started,
    finishedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    sampleRate: SAMPLE_RATE,
    crossOriginIsolated: self.crossOriginIsolated,
    bpm: BPM,
    audioSeconds: Number($('seconds').value),
    offline: state.offline,
    skipped: state.skipped,
    realtime: state.realtime
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
  for (const t of ['table', 'rtTable']) $(t).querySelector('tbody').replaceChildren();
  $('log').textContent = '';
  state.offline = [];
  state.realtime = [];
  state.skipped = [];
  $('skipped').textContent = '';
  state.started = new Date().toISOString();
  try {
    await offline(Number($('seconds').value));
    if ($('realtime').checked) await realtime(Number($('rtSeconds').value));
  } catch (error) {
    log(`stopped: ${error?.message ?? error}`);
  } finally {
    await finish();
    $('run').disabled = false;
  }
};
