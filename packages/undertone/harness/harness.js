// The device harness of the AudioWorklet backend: plays a looping pattern and reports underruns, the p99 of `process`, and drift
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Run it on the devices RF-29's acceptance names (a mid-range phone, a Steam Deck, Chromium with the CPU throttled six times in
// DevTools' Performance panel): `bun packages/undertone/harness/serve.ts`, then open the page it prints (for a phone, the
// machine's address on the same network; a phone needs https or `adb reverse tcp:8080 tcp:8080`, because an AudioWorklet needs a
// secure context). Press Start, leave it for the five minutes, and read the table. Everything measured is measured in the
// worklet, around the render call, with `performance.now()`; nothing here judges how it sounds, so listen as well.
//
// The acceptance (docs/rust-migration/milestones/M7-outputs.md, RF-29), which the table marks:
//   - no underrun in five minutes: no `process` call over its budget, and no block the host skipped;
//   - the 99th percentile of `process` at most 40% of the budget (128 frames at the sample rate);
//   - drift of zero frames against the host's clock.
//
// The page also exposes `window.undertoneHarness` for the headless check (check.ts): `result` is the final summary once it is done.

import * as undertone from '../dist/index.js';
import { createWorkletOutput } from '../dist/worklet.js';
import { harnessPatterns } from './patterns.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = {
  output: undefined,
  context: undefined,
  jank: undefined,
  poll: undefined,
  finish: undefined
};
window.undertoneHarness = { result: undefined, done: undefined };

function log(text) {
  $('log').textContent += `${text}\n`;
}

function fixed(value, digits = 3) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
}

/** Rows of [label, value, verdict]; verdict is 'ok', 'bad', or undefined. */
function render(rows) {
  const body = $('table').querySelector('tbody');
  body.replaceChildren(
    ...rows.map(([label, value, verdict]) => {
      const row = document.createElement('tr');
      const head = document.createElement('th');
      head.textContent = label;
      const cell = document.createElement('td');
      cell.textContent = value;
      if (verdict) cell.className = verdict;
      row.append(head, cell);
      return row;
    })
  );
}

/** The summary of a statistics snapshot, with the acceptance checks. */
function summarise(stats, context, elapsed) {
  const budget = stats.budgetMs;
  const p99 = stats.processMs?.p99 ?? null;
  const underruns = stats.overruns + stats.skippedBlocks;
  const checks = {
    noUnderrun: underruns === 0,
    p99Within40Percent: p99 !== null && p99 <= budget * 0.4,
    zeroDrift: stats.maxDriftFrames === 0
  };
  return {
    elapsedSeconds: elapsed,
    blocks: stats.blocks,
    expectedBlocks: Math.floor((elapsed * stats.sampleRate) / stats.quantumFrames),
    underruns,
    overruns: stats.overruns,
    skippedBlocks: stats.skippedBlocks,
    budgetMs: budget,
    timing: stats.timing,
    clockTicksPerMs: stats.clockTicksPerMs,
    processMs: stats.processMs,
    p99PercentOfBudget: p99 === null ? null : (p99 / budget) * 100,
    over40Percent: stats.over40Percent,
    queueMs: stats.queueMs,
    driftFrames: stats.driftFrames,
    maxDriftFrames: stats.maxDriftFrames,
    lateStarts: stats.lateStarts,
    maxLateFrames: stats.maxLateFrames,
    liveNodes: stats.liveNodes,
    errors: stats.errors,
    main: stats.main,
    sampleRate: stats.sampleRate,
    baseLatency: context.baseLatency,
    outputLatency: context.outputLatency,
    crossOriginIsolated: window.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    checks,
    passed: Object.values(checks).every(Boolean)
  };
}

function show(summary) {
  const checks = summary.checks;
  render([
    ['Elapsed', `${fixed(summary.elapsedSeconds, 0)} s`],
    ['Blocks rendered (expected from the clock)', `${summary.blocks} (${summary.expectedBlocks})`],
    [
      'Underruns (overruns + skipped blocks)',
      `${summary.underruns} (${summary.overruns} + ${summary.skippedBlocks})`,
      checks.noUnderrun ? 'ok' : 'bad'
    ],
    [
      'Clock',
      summary.timing === 'spin-counter'
        ? `a worker's counter in a SharedArrayBuffer, ${fixed(summary.clockTicksPerMs, 0)} ticks per ms`
        : summary.timing
    ],
    ['Block budget', `${fixed(summary.budgetMs)} ms (128 frames at ${summary.sampleRate} Hz)`],
    [
      'process, 99th percentile',
      summary.processMs
        ? `${fixed(summary.processMs.p99)} ms = ${fixed(summary.p99PercentOfBudget, 1)}% of budget (limit 40%)`
        : `no clock in the worklet: Chromium's worklet scope has no performance.now(), and the page is not cross-origin isolated (serve it with harness/serve.ts)`,
      checks.p99Within40Percent ? 'ok' : 'bad'
    ],
    [
      'process, median, 99.9th, max',
      summary.processMs
        ? `${fixed(summary.processMs.p50)}, ${fixed(summary.processMs.p999)}, ${fixed(summary.processMs.max)} ms`
        : 'n/a'
    ],
    ['Blocks over 40% of budget', String(summary.over40Percent)],
    [
      'Queueing a pass (decode and book), max',
      summary.queueMs ? `${fixed(summary.queueMs.max)} ms` : 'n/a'
    ],
    [
      'Drift against the host clock (max)',
      `${summary.driftFrames} frames (${summary.maxDriftFrames})`,
      checks.zeroDrift ? 'ok' : 'bad'
    ],
    ['Passes that arrived late', `${summary.lateStarts} (up to ${summary.maxLateFrames} frames)`],
    ['Nodes in the engine', String(summary.liveNodes)],
    [
      'Worklet errors',
      summary.errors.length === 0 ? 'none' : summary.errors.join(' | '),
      summary.errors.length === 0 ? 'ok' : 'bad'
    ],
    [
      'Base and output latency',
      `${fixed(summary.baseLatency)} s, ${fixed(summary.outputLatency)} s`
    ],
    ['Cross-origin isolated', String(summary.crossOriginIsolated)],
    [
      'Verdict',
      summary.passed
        ? 'meets the three acceptance limits'
        : 'does not meet them (see the red rows)',
      summary.passed ? 'ok' : 'bad'
    ]
  ]);
}

/** Busy-waits on the main thread for `ms` every second, to show that a loop keeps time without it. */
function startJank(ms) {
  if (ms <= 0) return undefined;
  return setInterval(() => {
    const until = performance.now() + ms;
    while (performance.now() < until);
  }, 1000);
}

async function start() {
  $('start').disabled = true;
  $('log').textContent = '';
  const channels = Number($('channels').value);
  const bpm = Number($('bpm').value);
  const rate = Number($('rate').value);
  try {
    const context = new AudioContext(
      rate > 0 ? { sampleRate: rate, latencyHint: 'playback' } : { latencyHint: 'playback' }
    );
    await context.resume();
    state.context = context;
    log(
      `context: ${context.sampleRate} Hz, state ${context.state}, base latency ${fixed(context.baseLatency)} s`
    );
    const output = await createWorkletOutput(context, { channels, seed: 'harness', clock: 'spin' });
    output.onerror = (message) => log(`worklet: ${message}`);
    log(`timing: ${output.timing}${output.timingNote ? ` (${output.timingNote})` : ''}`);
    state.output = output;
    state.patterns = harnessPatterns(undertone);
    state.loop = output.loop(state.patterns[$('pattern').value], { cycles: 4, bpm });
    await state.loop.ready;
    log('looping 4 cycles at ' + bpm + ' bpm');
    state.jank = startJank(Number($('jank').value));
    // The first seconds fill the caches and book the first reverb; the statistics restart after a short warm-up so a one-off
    // does not hide in the 99th percentile of five minutes. The warm-up is reported, not hidden.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const warmUp = await output.stats();
    log(
      `warm-up (3 s, not counted): ${warmUp.blocks} blocks, ${warmUp.overruns} overruns, ${warmUp.skippedBlocks} skipped, p99 ${fixed(warmUp.processMs?.p99)} ms, longest queueing ${fixed(warmUp.queueMs?.max)} ms`
    );
    output.resetStats();
    const began = context.currentTime;
    state.statsBegan = began;
    $('stop').disabled = false;
    $('copy').disabled = false;
    state.live = true;
    let last;
    const finish = async () => {
      clearInterval(state.poll);
      if (state.jank !== undefined) clearInterval(state.jank);
      state.loop?.stop();
      state.live = false;
      const stats = await output.stats();
      const summary = summarise(stats, context, context.currentTime - state.statsBegan);
      show(summary);
      window.undertoneHarness.result = summary;
      last = summary;
      log(JSON.stringify(summary, null, 2));
      output.close();
      await context.close();
      $('start').disabled = false;
      $('stop').disabled = true;
      return summary;
    };
    state.finish = finish;
    const done = new Promise((resolve) => {
      state.poll = setInterval(async () => {
        try {
          const elapsed = context.currentTime - began;
          // Read each time, so changing the duration while it runs moves the end.
          const seconds = Number($('seconds').value);
          $('progress').value = Math.min(1, elapsed / seconds);
          const stats = await output.stats();
          show(summarise(stats, context, context.currentTime - state.statsBegan));
          if (elapsed >= seconds) resolve(await finish());
        } catch (error) {
          log(`stats: ${error.message}`);
        }
      }, 1000);
    });
    window.undertoneHarness.done = done;
    $('copy').onclick = () =>
      navigator.clipboard?.writeText(
        JSON.stringify(last ?? window.undertoneHarness.result, null, 2)
      );
  } catch (error) {
    log(`failed: ${error?.stack ?? error}`);
    $('start').disabled = false;
    window.undertoneHarness.result = { error: String(error?.message ?? error) };
  }
}

/**
 * Changes made while a run is going. The pattern and the tempo restart the loop on the same context (the passes already posted
 * are cancelled, and the next pass starts a moment later), the jank restarts its timer, and the duration moves the end. The
 * statistics (and the time they are measured over) start again at each change, so the numbers on screen are for the settings in force now. The channel count and
 * the sample rate belong to the audio context, so they apply at the next Start.
 */
function changed(what) {
  if (!state.live || !state.output) return;
  try {
    if (what === 'pattern' || what === 'bpm') {
      const bpm = Number($('bpm').value);
      state.loop?.stop();
      state.loop = state.output.loop(state.patterns[$('pattern').value], { cycles: 4, bpm });
      log(`${what} changed: looping ${$('pattern').value} at ${bpm} bpm`);
    } else if (what === 'jank') {
      if (state.jank !== undefined) clearInterval(state.jank);
      state.jank = startJank(Number($('jank').value));
      log(`jank changed: ${$('jank').value} ms every second`);
    } else {
      log(`seconds changed: ${$('seconds').value}`);
      return;
    }
    state.output.resetStats();
    // The numbers on screen are for the settings in force now, so their clock starts again too.
    state.statsBegan = state.context.currentTime;
  } catch (error) {
    log(`change failed: ${error?.message ?? error}`);
  }
}
for (const id of ['pattern', 'bpm', 'jank', 'seconds'])
  $(id).addEventListener('change', () => changed(id));

$('start').onclick = start;
$('stop').onclick = () => state.finish?.();
for (const [key, id] of [
  ['pattern', 'pattern'],
  ['seconds', 'seconds'],
  ['channels', 'channels'],
  ['bpm', 'bpm'],
  ['jank', 'jank'],
  ['rate', 'rate']
]) {
  if (params.has(key)) $(id).value = params.get(key);
}
if (params.has('auto')) {
  $('seconds').value = params.get('auto');
  start();
}
