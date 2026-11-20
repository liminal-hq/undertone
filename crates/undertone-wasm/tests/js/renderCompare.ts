// The layer 4 comparison of a render with Chromium's summaries, shared by the module's runner (layer4.ts) and the package's
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// No module is loaded here, so the package's Vitest runner can import it without instantiating a second copy of the glue. The
// summary is the one conformance/recorder/renderSummary.ts makes of Chromium's render (RMS, peak, eight FFT bands, 0.1 s
// windows), held to the tolerances crates/undertone-engine/tests/layer4.rs enforces.

const FLOOR = 1e-4;
const BAND_EDGES = [125, 250, 500, 1000, 2000, 4000, 8000];
const WINDOW_SECONDS = 0.1;

interface Tolerance {
  rms: number;
  peak: number;
  band: number;
  window: number;
}

function tolerance(limiterOn: boolean): Tolerance {
  return limiterOn
    ? { rms: 0.05, peak: 0.1, band: 0.1, window: 0.05 }
    : { rms: 0.01, peak: 0.02, band: 0.1, window: 0.05 };
}

function quirkGuard(quirk: string): Tolerance {
  if (quirk === 'delay-feedback') return { rms: 0.25, peak: 0.75, band: 0.75, window: 7.5 };
  if (quirk === 'mid-quantum-start') return { rms: 0.05, peak: 0.25, band: 12.5, window: 0.25 };
  throw new Error(`unknown quirk label ${quirk}`);
}

interface Channel {
  rms: number;
  peak: number;
  bands: number[];
  windows: number[];
}

/** In-place radix-2 FFT, the algorithm of renderSummary.ts and the Rust layer 4 test. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    for (let k = 0; k < half; k += 1) {
      const angle = (-2 * Math.PI * k) / len;
      const wr = Math.cos(angle);
      const wi = Math.sin(angle);
      for (let start = 0; start < n; start += len) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

function summarise(samples: Float32Array, sampleRate: number): Channel {
  const frames = samples.length;
  let peak = 0;
  let sum = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
    sum += sample * sample;
  }
  let size = 1;
  while (size < frames) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(samples);
  fft(re, im);
  const power = new Array<number>(8).fill(0);
  for (let k = 1; k < size / 2; k += 1) {
    const hz = (k * sampleRate) / size;
    const band = BAND_EDGES.filter((edge) => hz >= edge).length;
    power[band] += re[k] * re[k] + im[k] * im[k];
  }
  const bands = power.map((p) => Math.sqrt((2 * p) / (frames * size)));
  const window = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate));
  const windows: number[] = [];
  for (let at = 0; at < frames; at += window) {
    const chunk = samples.subarray(at, Math.min(frames, at + window));
    let total = 0;
    for (const s of chunk) total += s * s;
    windows.push(Math.sqrt(total / chunk.length));
  }
  return { rms: Math.sqrt(sum / Math.max(1, frames)), peak, bands, windows };
}

function db(a: number, b: number): number {
  if (a === b) return 0;
  if (a === 0) return -Infinity;
  if (b === 0) return Infinity;
  return 20 * Math.log10(a / b);
}

interface Worst {
  db: number;
  at: number;
}

function take(worst: Worst, value: number, at: number): void {
  if (Math.abs(value) > Math.abs(worst.db) || (Number.isNaN(value) && !Number.isNaN(worst.db))) {
    worst.db = value;
    worst.at = at;
  }
}

/** A render's output against a case's Chromium summary: the failures (empty when within the tolerances) and a summary line. */
export function checkRender(
  spec: Record<string, unknown>,
  out: { sampleRate: number; channels: Float32Array[] }
): { failures: string[]; line: string } {
  const id = spec.id as string;
  const failures: string[] = [];
  const browser = spec.browser as {
    frames: number;
    sampleRate: number;
    channels: Channel[];
  };
  const options = spec.render as Record<string, unknown>;
  if (out.channels[0].length !== browser.frames) {
    failures.push(
      `${id}: ${out.channels[0].length} frames rendered, ${browser.frames} in the browser`
    );
    return { failures, line: id };
  }
  if (out.channels.some((channel) => channel.some((s) => !Number.isFinite(s)))) {
    failures.push(`${id}: a sample is not finite`);
    return { failures, line: id };
  }
  const mine = out.channels.map((channel) => summarise(channel, browser.sampleRate));
  const limit =
    typeof spec.quirk === 'string' ? quirkGuard(spec.quirk) : tolerance(options.master !== false);
  const worst = {
    rms: { db: 0, at: 0 },
    peak: { db: 0, at: 0 },
    band: { db: 0, at: 0 },
    window: { db: 0, at: 0 }
  };
  let compared = 0;
  if (mine.length !== browser.channels.length) {
    failures.push(`${id}: ${mine.length} channels, ${browser.channels.length} in the browser`);
    return { failures, line: id };
  }
  mine.forEach((m, c) => {
    const b = browser.channels[c];
    take(worst.rms, db(m.rms, b.rms), c);
    take(worst.peak, db(m.peak, b.peak), c);
    m.bands.forEach((x, i) => {
      if (Math.max(x, b.bands[i]) >= FLOOR) {
        take(worst.band, db(x, b.bands[i]), i);
        compared += 1;
      }
    });
    if (m.windows.length !== b.windows.length) failures.push(`${id}: window count`);
    m.windows.forEach((x, i) => {
      if (Math.max(x, b.windows[i]) >= FLOOR) {
        take(worst.window, db(x, b.windows[i]), i);
        compared += 1;
      }
    });
  });
  if (compared === 0) failures.push(`${id}: nothing was compared`);
  const line = (['rms', 'peak', 'band', 'window'] as const).map((what) => {
    const value = worst[what].db;
    if (Math.abs(value) > limit[what] || Number.isNaN(value)) {
      failures.push(
        `${id}: ${what} differs by ${value.toFixed(4)} dB at ${worst[what].at} (allowed ${limit[what]})`
      );
    }
    return `${what} ${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
  });
  return {
    failures,
    line: `${id}${typeof spec.quirk === 'string' ? ` [${spec.quirk}]` : ''}: ${line.join(', ')} dB`
  };
}
