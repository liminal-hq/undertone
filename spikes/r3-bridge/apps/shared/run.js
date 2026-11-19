// Shared browser harness for the scratch apps: five programs on a recording context, one offline render, the timings
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { programs } from '../scripts/programs.mjs';
import { recordingContext } from '../scripts/recorder-context.mjs';

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * Runs the five programs. `api` is the namespace (or an object with `note`); `evaluate` turns a program into
 * a pattern (the playground style goes through `new Function`). `loadedAt` is the `performance.now()` at which the
 * module was ready (the bridge's `timing.ready`) and `startedAt` where its load began.
 */
export async function run(label, api, evaluate, startedAt, loadedAt) {
  const result = { label, userAgent: navigator.userAgent, rows: [] };
  // The first play() after import, on a real (offline) context: time from the module's load start to its return.
  const offline = new OfflineAudioContext(2, 44100, 44100);
  const first = programs[0];
  const t0 = performance.now();
  const playback = evaluate(api, first.build, first.source).play({ context: offline });
  const t1 = performance.now();
  result.firstPlay = {
    startTime: playback.startTime,
    currentTime: offline.currentTime,
    onTime: playback.startTime === offline.currentTime,
    playMs: t1 - t0,
    loadStartToBookedMs: t1 - startedAt,
    moduleReadyToBookedMs: t1 - loadedAt,
    instantiateMs: loadedAt - startedAt
  };
  const buffer = await offline.startRendering();
  const samples = buffer.getChannelData(0);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  result.renderPeak = peak;
  for (const program of programs) {
    const context = recordingContext();
    evaluate(api, program.build, program.source).play({ context });
    result.rows.push({ id: program.id, hash: await sha256(context.log.join('\n')) });
  }
  globalThis.__r3 = result;
  document.title = 'done';
  document.body.textContent = JSON.stringify(result);
  return result;
}

/** The ordinary way: call the program's builder with `note`. */
export const direct = (api, build) => build(api.note);

/** The playground's way: `new Function` over every export, the source as a bare expression. */
export function playgroundStyle(api, _build, source) {
  const names = Object.keys(api);
  const values = Object.values(api);
  const fn = new Function(...names, `"use strict";\nreturn (\n${source}\n);`);
  return fn(...values);
}
