// Summarises a rendered buffer for layer 4: per channel RMS, peak, octave-band RMS, and RMS per 100 ms window
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/** The octave bands' upper edges in Hz: band `i` holds frequencies below `BAND_EDGES[i]` and at or above the previous edge. */
export const BAND_EDGES = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

/** Bands in a summary: below 125 Hz, six octaves from 125 Hz to 8 kHz, and 8 kHz up to Nyquist. */
export const BAND_COUNT = BAND_EDGES.length + 1;

/** The length of a summary window in seconds. */
export const WINDOW_SECONDS = 0.1;

/** One channel's summary. Every number is a linear amplitude (full scale is 1). */
export interface ChannelSummary {
  /** Root mean square over the whole render. */
  rms: number;
  /** Largest absolute sample. */
  peak: number;
  /** RMS in each of the eight bands (`BAND_EDGES`), from a spectrum of the whole channel. */
  bands: number[];
  /** RMS of each consecutive 100 ms window (the last window may be shorter). */
  windows: number[];
}

/** What a render is reduced to. */
export interface RenderSummary {
  sampleRate: number;
  frames: number;
  channels: ChannelSummary[];
}

/** The window length in frames at a sample rate. */
export function windowFrames(sampleRate: number): number {
  return Math.max(1, Math.round(WINDOW_SECONDS * sampleRate));
}

/** The smallest power of two that is at least `n`. */
export function fftSize(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/** In-place radix-2 FFT of `re` and `im` (length a power of two); the twiddles come straight from `cos` and `sin`. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    for (let k = 0; k < half; k++) {
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

/**
 * RMS in each band. The channel is zero-padded to a power of two `M` (no window function), transformed, and the
 * power of bins `1..M/2-1` is summed by the bin's frequency `k * sampleRate / M`; band RMS is
 * `sqrt(2 * sum |X_k|^2 / (frames * M))`, so the bands' mean squares add up to the channel's (less DC and Nyquist).
 */
export function bandRms(samples: ArrayLike<number>, sampleRate: number): number[] {
  const frames = samples.length;
  const size = fftSize(frames);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < frames; i++) re[i] = samples[i];
  fft(re, im);
  const power = new Array<number>(BAND_COUNT).fill(0);
  for (let k = 1; k < size / 2; k++) {
    const hz = (k * sampleRate) / size;
    let band = 0;
    while (band < BAND_EDGES.length && hz >= BAND_EDGES[band]) band += 1;
    power[band] += re[k] * re[k] + im[k] * im[k];
  }
  return power.map((sum) => Math.sqrt((2 * sum) / (frames * size)));
}

/** RMS of each consecutive window of `windowLength` frames (the last may be shorter). */
export function windowRms(samples: ArrayLike<number>, windowLength: number): number[] {
  const out: number[] = [];
  for (let start = 0; start < samples.length; start += windowLength) {
    const end = Math.min(start + windowLength, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    out.push(Math.sqrt(sum / (end - start)));
  }
  return out;
}

/** Summarises rendered channels (each an array of samples). */
export function summarise(channels: ArrayLike<number>[], sampleRate: number): RenderSummary {
  const frames = channels[0]?.length ?? 0;
  return {
    sampleRate,
    frames,
    channels: channels.map((samples) => {
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < frames; i++) {
        const value = samples[i];
        peak = Math.max(peak, Math.abs(value));
        sum += value * value;
      }
      return {
        rms: Math.sqrt(sum / Math.max(frames, 1)),
        peak,
        bands: bandRms(samples, sampleRate),
        windows: windowRms(samples, windowFrames(sampleRate))
      };
    })
  };
}
