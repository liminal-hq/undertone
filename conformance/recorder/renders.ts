// Layer 4: the render cases' files, built from the reference (no audio) and checked without a browser
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { encodeValue, nineDigits, nineDigitsText, programJson, serialiseFile } from './format';
import type { CaseRecord, Json } from './format';
import { renderOnsets, scoreLines } from './graph';
import { build } from './programs';
import { BAND_COUNT, windowFrames } from './renderSummary';
import type { RenderSummary } from './renderSummary';
import { RENDER_QUANTUM, renderCases } from './rendersData';
import type { RenderCase } from './rendersData';
import type { Reference } from './reference';

/** The layer 4 file, under `conformance/cases/`. */
export const RENDERS_PATH = '4/renders.json';

/** What the browser run adds to a case: the browser's version and the summary of what it rendered. */
export interface BrowserRecord extends RenderSummary {
  /** The browser's version, as Playwright reports it (`149.0.7827.55`). */
  chromium: string;
}

/**
 * The part of a case that needs no browser: the program and options, and the onsets the reference books
 * (`score`, as layer 3's render cases record them). `conformance:check` regenerates it.
 */
export function renderHead(ref: Reference, spec: RenderCase): CaseRecord {
  const built = build(ref, spec.program);
  if ('error' in built) throw new Error(`${spec.id}: ${built.error}`);
  return {
    id: spec.id,
    from: spec.from,
    program: programJson(spec.program),
    render: encodeValue(spec.render),
    ...(spec.quirk === undefined ? {} : { quirk: spec.quirk }),
    score: scoreLines(renderOnsets(ref, built.pattern, spec.render))
  };
}

/**
 * Checks what Chromium's two quirks need (`docs/rust-migration/results/R-layer4.md`), without a browser: every voice
 * of a case not labelled with a quirk starts on a multiple of 128 frames at the case's sample rate, **exactly in a
 * double** (an onset such as 1.2000000000000002 s is a hair after its frame, which Chromium treats as a late gain
 * event, so the first sample is wrong), and no voice has a delay send with feedback. A case labelled with a quirk
 * really has it, so the label cannot go stale.
 */
export function checkRenderQuirks(ref: Reference, spec: RenderCase): string[] {
  const built = build(ref, spec.program);
  if ('error' in built) return [`${spec.id}: ${built.error}`];
  const sampleRate = spec.render.sampleRate ?? 48000;
  const voices = renderOnsets(ref, built.pattern, spec.render);
  let misaligned = 0;
  let feedback = 0;
  for (const voice of voices) {
    const quanta = (voice.at * sampleRate) / RENDER_QUANTUM;
    // The file holds the onset to nine significant digits, so it must also survive that.
    const printed = Number(nineDigitsText(voice.at));
    if (quanta !== Math.round(quanta) || printed !== voice.at) misaligned++;
    const patch = voice.patch as { delayLevel?: number; delayFeedback?: number };
    if ((patch.delayLevel ?? 0) > 0 && (patch.delayFeedback ?? 0) > 0) feedback++;
  }
  const problems: string[] = [];
  if (voices.length === 0) problems.push(`${spec.id}: the program books no voice`);
  if (spec.quirk !== 'mid-quantum-start' && misaligned > 0) {
    problems.push(
      `${spec.id}: ${misaligned} of ${voices.length} onsets are not exactly on a ${RENDER_QUANTUM}-frame boundary at ${sampleRate} Hz, exact in a double (Chromium starts such a voice at the wrong phase; choose the sample rate and cycle length so they align, or label the case \`mid-quantum-start\`)`
    );
  }
  if (spec.quirk !== 'delay-feedback' && feedback > 0) {
    problems.push(
      `${spec.id}: ${feedback} voices have a delay send with feedback (Chromium adds a quantum per pass; use feedback 0, or label the case \`delay-feedback\`)`
    );
  }
  if (spec.quirk === 'mid-quantum-start' && misaligned === 0) {
    problems.push(`${spec.id}: labelled \`mid-quantum-start\` but every onset is on a boundary`);
  }
  if (spec.quirk === 'delay-feedback' && feedback === 0) {
    problems.push(`${spec.id}: labelled \`delay-feedback\` but no voice has delay feedback`);
  }
  return problems;
}

/** A summary's numbers to nine significant digits, as the file holds them. */
export function browserJson(record: BrowserRecord): Json {
  const round = (values: number[]): Json[] => values.map((value) => nineDigits(value));
  return {
    chromium: record.chromium,
    sampleRate: record.sampleRate,
    frames: record.frames,
    channels: record.channels.map((channel): Json => ({
      rms: nineDigits(channel.rms),
      peak: nineDigits(channel.peak),
      bands: round(channel.bands),
      windows: round(channel.windows)
    }))
  };
}

/** The bytes of the layer 4 file for these cases. */
export function serialiseRenders(cases: CaseRecord[]): string {
  return serialiseFile({ layer: 4, group: 'renders', cases });
}

/** The frames a render of this case has: whole cycles at the tempo plus the tail, rounded as `renderToBuffer` rounds. */
function expectedFrames(ref: Reference, spec: RenderCase): number {
  const cycleSeconds = ref.scheduler.cycleSecondsFor(spec.render.bpm, spec.render.cps);
  const seconds = (spec.render.cycles ?? 1) * cycleSeconds + (spec.render.tail ?? 0);
  return Math.max(1, Math.round(seconds * (spec.render.sampleRate ?? 48000)));
}

function isNumbers(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)
  );
}

/**
 * Checks the committed layer 4 file without a browser: every case of `rendersData.ts` is there with the program,
 * options, and score the reference makes now, and its browser record has the format (finite non-negative numbers,
 * the right counts of channels, bands, and windows, a version string).
 */
export function checkRenders(ref: Reference, casesDir: string): string[] {
  const problems: string[] = [];
  let file: { corpus?: unknown; layer?: unknown; group?: unknown; cases?: unknown };
  try {
    file = JSON.parse(readFileSync(join(casesDir, RENDERS_PATH), 'utf8'));
  } catch (error) {
    return [`${RENDERS_PATH}: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (file.corpus !== 1 || file.layer !== 4 || file.group !== 'renders') {
    problems.push(`${RENDERS_PATH}: the header is not corpus 1, layer 4, group renders`);
  }
  const committed = Array.isArray(file.cases) ? (file.cases as Record<string, unknown>[]) : [];
  const specs = renderCases();
  if (committed.length !== specs.length) {
    problems.push(`${RENDERS_PATH}: ${committed.length} cases, expected ${specs.length}`);
  }
  for (const spec of specs) {
    const entry = committed.find((c) => c.id === spec.id);
    if (entry === undefined) {
      problems.push(`${spec.id}: missing from ${RENDERS_PATH}`);
      continue;
    }
    problems.push(...checkRenderQuirks(ref, spec));
    const head = renderHead(ref, spec);
    for (const key of ['from', 'program', 'render', 'quirk', 'score']) {
      if (JSON.stringify(entry[key]) !== JSON.stringify(head[key])) {
        problems.push(
          `${spec.id}: \`${key}\` differs from the reference's (run the browser render)`
        );
      }
    }
    const browser = entry.browser as
      | (Partial<Record<keyof BrowserRecord, unknown>> & { channels?: Record<string, unknown>[] })
      | undefined;
    if (browser === undefined || typeof browser.chromium !== 'string' || browser.chromium === '') {
      problems.push(`${spec.id}: no browser version`);
      continue;
    }
    const sampleRate = spec.render.sampleRate ?? 48000;
    const frames = expectedFrames(ref, spec);
    if (browser.sampleRate !== sampleRate)
      problems.push(`${spec.id}: sampleRate is not ${sampleRate}`);
    if (browser.frames !== frames) problems.push(`${spec.id}: frames is not ${frames}`);
    const channelCount = spec.render.channels ?? 2;
    const channels = browser.channels ?? [];
    if (channels.length !== channelCount) {
      problems.push(`${spec.id}: ${channels.length} channels, expected ${channelCount}`);
    }
    const windows = Math.ceil(frames / windowFrames(sampleRate));
    for (const [index, channel] of channels.entries()) {
      const ok =
        typeof channel.rms === 'number' &&
        Number.isFinite(channel.rms) &&
        channel.rms >= 0 &&
        typeof channel.peak === 'number' &&
        Number.isFinite(channel.peak) &&
        channel.peak >= channel.rms &&
        isNumbers(channel.bands, BAND_COUNT) &&
        isNumbers(channel.windows, windows);
      if (!ok) {
        problems.push(
          `${spec.id}: channel ${index} is not rms, peak, ${BAND_COUNT} bands, and ${windows} windows of finite numbers`
        );
      }
    }
  }
  return problems;
}
