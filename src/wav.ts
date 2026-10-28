// Encodes rendered audio as a WAV file: 16/24-bit PCM or 32-bit float, up to 8 channels
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { seededRandom } from './random.js';
import type { RenderedAudioBufferLike } from './types.js';

export interface WavOptions {
  /** Sample format: 16 or 24-bit integer PCM, or 32-bit IEEE float. Default 16. */
  bitDepth?: 16 | 24 | 32;
  /** Add TPDF dither before quantizing. 16-bit only. Default true. */
  dither?: boolean;
  /** Seed for the dither noise, so the same render always gives the same bytes. Default 0. */
  seed?: number | string;
  /** Speaker position mask for 3-8 channel files. Defaults follow the channel count. */
  channelMask?: number;
}

export type WavSource =
  RenderedAudioBufferLike | { sampleRate: number; channels: readonly Float32Array[] };

/** Speaker masks used when the caller gives none: mono, stereo, quad, 5.1 and 7.1. */
const DEFAULT_MASKS: Record<number, number> = {
  1: 0x4,
  2: 0x3,
  4: 0x33,
  6: 0x60f,
  8: 0x63f
};

/**
 * Undertone orders 7.1 as FL FR C LFE SL SR RL RR, but WAV stores channels in
 * speaker-mask bit order (FL FR FC LFE BL BR SL SR), so the side and rear pairs swap.
 */
const WAV_8_CHANNEL_ORDER = [0, 1, 2, 3, 6, 7, 4, 5];

const MAX_DATA_BYTES = 0xffffffff - 36;

function channelsOf(source: WavSource): { sampleRate: number; channels: readonly Float32Array[] } {
  if ('channels' in source) return source;
  const channels: Float32Array[] = [];
  for (let i = 0; i < source.numberOfChannels; i++) channels.push(source.getChannelData(i));
  return { sampleRate: source.sampleRate, channels };
}

/** Encodes audio as a WAV file and returns its bytes. */
export function encodeWav(source: WavSource, options: WavOptions = {}): Uint8Array {
  const { sampleRate, channels } = channelsOf(source);
  const bitDepth = options.bitDepth ?? 16;
  const isFloat = bitDepth === 32;
  const channelCount = channels.length;

  if (channelCount === 0) throw new Error('encodeWav: the source has no channels');
  if (channelCount > 8) {
    throw new Error(`encodeWav: ${channelCount} channels is more than the 8 WAV supports here`);
  }
  const frames = channels[0].length;
  if (channels.some((c) => c.length !== frames)) {
    throw new Error('encodeWav: every channel must have the same length');
  }

  const bytesPerSample = bitDepth / 8;
  const dataSize = frames * channelCount * bytesPerSample;
  if (dataSize > MAX_DATA_BYTES) {
    throw new Error('encodeWav: the audio is too long for a WAV file (over 4 GiB)');
  }

  const extensible = channelCount > 2;
  const defaultMask = DEFAULT_MASKS[channelCount] ?? 0;
  const mask = options.channelMask ?? defaultMask;
  const reorder = channelCount === 8 && options.channelMask === undefined;
  const order = reorder ? WAV_8_CHANNEL_ORDER : channels.map((_, i) => i);

  const fmtSize = extensible ? 40 : isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0;
  const pad = dataSize % 2;
  const headerSize = 12 + 8 + fmtSize + factSize + 8;
  const out = new Uint8Array(headerSize + dataSize + pad);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  const formatTag = isFloat ? 3 : 1;
  ascii(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : formatTag, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  let pos = 36;
  if (extensible) {
    view.setUint16(pos, 22, true); // cbSize
    view.setUint16(pos + 2, bitDepth, true); // valid bits per sample
    view.setUint32(pos + 4, mask, true);
    view.setUint16(pos + 8, formatTag, true); // sub-format GUID: tag + the standard KSDATAFORMAT tail
    out.set(
      [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
      pos + 10
    );
    pos += 24;
  } else if (isFloat) {
    view.setUint16(pos, 0, true); // cbSize
    pos += 2;
  }
  if (isFloat) {
    ascii(pos, 'fact');
    view.setUint32(pos + 4, 4, true);
    view.setUint32(pos + 8, frames, true);
    pos += 12;
  }
  ascii(pos, 'data');
  view.setUint32(pos + 4, dataSize, true);
  pos += 8;

  const dither = bitDepth === 16 && (options.dither ?? true);
  const random = dither ? seededRandom(options.seed ?? 0) : undefined;
  const negScale = 2 ** (bitDepth - 1);
  const posScale = negScale - 1;

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channelCount; c++) {
      const s = channels[order[c]][f];
      if (isFloat) {
        view.setFloat32(pos, s, true);
        pos += 4;
        continue;
      }
      let v = s < 0 ? s * negScale : s * posScale;
      if (random) v += random() - random();
      v = Math.max(-negScale, Math.min(posScale, Math.round(v)));
      if (bitDepth === 16) {
        view.setInt16(pos, v, true);
        pos += 2;
      } else {
        out[pos] = v & 0xff;
        out[pos + 1] = (v >> 8) & 0xff;
        out[pos + 2] = (v >> 16) & 0xff;
        pos += 3;
      }
    }
  }
  return out;
}
