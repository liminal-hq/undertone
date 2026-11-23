// Runs the speed probe and the three harness patterns in turn and posts the numbers to the server that served the page
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as undertone from '../dist/index.js';
import { createWorkletOutput } from '../dist/worklet.js';
import { harnessPatterns } from './patterns.js';
import { summarise } from './summary.js';

const $ = (id) => document.getElementById(id);
const PATTERNS = ['light', 'representative', 'heavy'];
const WARM_UP_MS = 3000;
const BPM = 110;

function guessLabel() {
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
  return `${name} on ${os}`.trim();
}
$('label').value = guessLabel();

const log = (text) => {
  $('log').textContent += `${text}\n`;
};
const row = (step, text, verdict) => {
  const tr = document.createElement('tr');
  const a = document.createElement('th');
  const b = document.createElement('td');
  a.textContent = step;
  b.textContent = text;
  if (verdict) b.className = verdict;
  tr.append(a, b);
  $('table').querySelector('tbody').append(tr);
  return b;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (list) => list.map((v) => Number(v.toFixed(1)));

function work(n) {
  let x = 0;
  for (let i = 1; i <= n; i++) x += Math.sin(i) * Math.sqrt(i);
  return x;
}

async function probe() {
  const page = [];
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    work(3_000_000);
    page.push(performance.now() - t);
  }
  const result = { jsLoopOnPageMs: round(page) };
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
  return result;
}

async function runPattern(name, seconds) {
  const context = new AudioContext({ latencyHint: 'playback' });
  await context.resume();
  const output = await createWorkletOutput(context, {
    channels: 2,
    seed: 'harness',
    clock: 'spin'
  });
  output.onerror = (message) => log(`worklet (${name}): ${message}`);
  const loop = output.loop(harnessPatterns(undertone)[name], { cycles: 4, bpm: BPM });
  await loop.ready;
  await pause(WARM_UP_MS);
  output.resetStats();
  const began = context.currentTime;
  await pause(seconds * 1000);
  const stats = await output.stats();
  const summary = summarise(stats, context, context.currentTime - began);
  loop.stop();
  output.close();
  await context.close();
  return summary;
}

async function runAll() {
  $('run').disabled = true;
  $('copy').disabled = true;
  $('table').querySelector('tbody').replaceChildren();
  $('log').textContent = '';
  const seconds = Number($('seconds').value);
  const results = {
    label: $('label').value.trim() || guessLabel(),
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    secondsPerPattern: seconds,
    bpm: BPM,
    runs: {}
  };
  try {
    $('status').textContent = 'Probe...';
    results.probe = await probe();
    const last = (list) => (Array.isArray(list) ? list[list.length - 1] : 'n/a');
    row(
      'Probe',
      `JS loop ${last(results.probe.jsLoopOnPageMs)} ms, WebAssembly render ${last(results.probe.wasmRenderTwoSecondsLightMs)} ms (2 s of Light)`
    );
    for (const name of PATTERNS) {
      $('status').textContent = `${name}: ${seconds + WARM_UP_MS / 1000} s...`;
      const cell = row(name, 'running...');
      try {
        const summary = await runPattern(name, seconds);
        results.runs[name] = summary;
        cell.textContent = `${summary.passed ? 'meets the three limits' : 'does not meet the limits'}: p99 ${summary.p99PercentOfBudget?.toFixed(1)}% of budget, mean ${summary.processMs?.mean?.toFixed(3)} ms, ${summary.overruns} overruns, drift ${summary.maxDriftFrames} frames, ${summary.blocks} blocks`;
        cell.className = summary.passed ? 'ok' : 'bad';
      } catch (error) {
        results.runs[name] = { error: String(error?.message ?? error) };
        cell.textContent = `failed: ${error?.message ?? error}`;
        cell.className = 'bad';
      }
      await pause(1000);
    }
  } finally {
    results.finishedAt = new Date().toISOString();
    window.undertoneMatrix = results;
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
