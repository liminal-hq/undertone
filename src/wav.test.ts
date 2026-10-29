// Tests for the WAV encoder: header bytes, sample formats, channel order, dither and errors
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { encodeWav } from './wav';

const mono = (...samples: number[]) => ({
  sampleRate: 48000,
  channels: [Float32Array.from(samples)]
});
const text = (b: Uint8Array, at: number, n = 4) => String.fromCharCode(...b.slice(at, at + n));
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

describe('encodeWav', () => {
  it('writes a canonical 16-bit stereo header', () => {
    const src = {
      sampleRate: 44100,
      channels: [Float32Array.from([0, 0.5]), Float32Array.from([0, -0.5])]
    };
    const b = encodeWav(src, { dither: false });
    const v = dv(b);
    expect(b.length).toBe(44 + 8);
    expect(text(b, 0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(b.length - 8);
    expect(text(b, 8)).toBe('WAVE');
    expect(text(b, 12)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 4);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(b, 36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(8);
    // Interleaved: L0 R0 L1 R1
    expect([v.getInt16(44, true), v.getInt16(46, true)]).toEqual([0, 0]);
    expect(v.getInt16(48, true)).toBe(Math.round(0.5 * 32767));
    expect(v.getInt16(50, true)).toBe(Math.round(-0.5 * 32768));
  });

  it('writes 32-bit float with format tag 3, a fact chunk and unclamped samples', () => {
    const b = encodeWav(mono(0.25, 2), { bitDepth: 32 });
    const v = dv(b);
    expect(v.getUint16(20, true)).toBe(3);
    expect(v.getUint16(34, true)).toBe(32);
    expect(text(b, 38)).toBe('fact');
    expect(v.getUint32(42, true)).toBe(4);
    expect(v.getUint32(46, true)).toBe(2);
    expect(text(b, 50)).toBe('data');
    expect(v.getUint32(54, true)).toBe(8);
    expect(v.getFloat32(58, true)).toBe(0.25);
    expect(v.getFloat32(62, true)).toBe(2);
  });

  it('uses WAVE_FORMAT_EXTENSIBLE with the PCM GUID and mask for 6 channels', () => {
    const channels = Array.from({ length: 6 }, () => new Float32Array(1));
    const b = encodeWav({ sampleRate: 48000, channels });
    const v = dv(b);
    expect(v.getUint32(16, true)).toBe(40);
    expect(v.getUint16(20, true)).toBe(0xfffe);
    expect(v.getUint16(22, true)).toBe(6);
    expect(v.getUint16(36, true)).toBe(22);
    expect(v.getUint16(38, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(0x60f);
    expect(Array.from(b.slice(44, 60))).toEqual([
      1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71
    ]);
    expect(text(b, 60)).toBe('data');
  });

  it('uses the float sub-format and 0x63F for 8 channels, with a fact chunk', () => {
    const channels = Array.from({ length: 8 }, () => new Float32Array(1));
    const b = encodeWav({ sampleRate: 48000, channels }, { bitDepth: 32 });
    const v = dv(b);
    expect(v.getUint16(20, true)).toBe(0xfffe);
    expect(v.getUint32(40, true)).toBe(0x63f);
    expect(v.getUint16(44, true)).toBe(3);
    expect(text(b, 60)).toBe('fact');
  });

  it('reorders 7.1 from Undertone order to WAV mask order', () => {
    const channels = Array.from({ length: 8 }, (_, i) => Float32Array.from([i / 10]));
    const b = encodeWav({ sampleRate: 48000, channels }, { bitDepth: 32 });
    const v = dv(b);
    const start = 60 + 12 + 8;
    const written = Array.from({ length: 8 }, (_, i) =>
      Math.round(v.getFloat32(start + i * 4, true) * 10)
    );
    // FL FR C LFE then RL RR (inputs 6,7) then SL SR (inputs 4,5)
    expect(written).toEqual([0, 1, 2, 3, 6, 7, 4, 5]);
  });

  it('does not reorder 7.1 when the caller supplies a mask', () => {
    const channels = Array.from({ length: 8 }, (_, i) => Float32Array.from([i / 10]));
    const b = encodeWav({ sampleRate: 48000, channels }, { bitDepth: 32, channelMask: 0x63f });
    const start = 60 + 12 + 8;
    expect(Math.round(dv(b).getFloat32(start + 16, true) * 10)).toBe(4);
  });

  it('leaves the mask 0 for unusual counts unless one is given', () => {
    const channels = Array.from({ length: 3 }, () => new Float32Array(1));
    expect(dv(encodeWav({ sampleRate: 48000, channels })).getUint32(40, true)).toBe(0);
    expect(
      dv(encodeWav({ sampleRate: 48000, channels }, { channelMask: 0x7 })).getUint32(40, true)
    ).toBe(7);
  });

  it('clamps out-of-range samples', () => {
    const b = encodeWav(mono(1, -1, 5, -5), { dither: false });
    const v = dv(b);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([
      32767, -32768, 32767, -32768
    ]);
  });

  it('packs 24-bit samples little-endian', () => {
    const b = encodeWav(mono(1, -1, 0), { bitDepth: 24 });
    const v = dv(b);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(9);
    // 0x7FFFFF, -0x800000, 0 — and one pad byte since the data size is odd.
    expect(Array.from(b.slice(44, 53))).toEqual([0xff, 0xff, 0x7f, 0x00, 0x00, 0x80, 0, 0, 0]);
    expect(b.length).toBe(44 + 9 + 1);
    expect(v.getUint32(4, true)).toBe(b.length - 8);
  });

  describe('dither', () => {
    const ramp = {
      sampleRate: 48000,
      channels: [Float32Array.from({ length: 256 }, (_, i) => i / 512)]
    };
    it('is deterministic for a seed and differs between seeds', () => {
      expect(encodeWav(ramp, { seed: 3 })).toEqual(encodeWav(ramp, { seed: 3 }));
      expect(encodeWav(ramp, { seed: 3 })).not.toEqual(encodeWav(ramp, { seed: 4 }));
      expect(encodeWav(ramp)).toEqual(encodeWav(ramp, { seed: 0 }));
    });

    it('is exact when switched off and within one LSB otherwise', () => {
      const exact = dv(encodeWav(ramp, { dither: false }));
      const dithered = dv(encodeWav(ramp));
      let differs = false;
      for (let i = 0; i < 256; i++) {
        const a = exact.getInt16(44 + i * 2, true);
        expect(a).toBe(Math.round((i / 512) * 32767));
        const d = dithered.getInt16(44 + i * 2, true) - a;
        expect(Math.abs(d)).toBeLessThanOrEqual(1);
        if (d !== 0) differs = true;
      }
      expect(differs).toBe(true);
    });

    it('does not dither 24-bit output', () => {
      expect(encodeWav(ramp, { bitDepth: 24, seed: 1 })).toEqual(
        encodeWav(ramp, { bitDepth: 24, seed: 2 })
      );
    });
  });

  it('accepts an AudioBuffer-like source', () => {
    const data = Float32Array.from([0.5]);
    const b = encodeWav(
      { numberOfChannels: 1, length: 1, sampleRate: 22050, getChannelData: () => data },
      { dither: false }
    );
    expect(dv(b).getUint32(24, true)).toBe(22050);
    expect(dv(b).getInt16(44, true)).toBe(16384);
  });

  it('throws clear errors', () => {
    expect(() => encodeWav({ sampleRate: 48000, channels: [] })).toThrow(/no channels/);
    const nine = Array.from({ length: 9 }, () => new Float32Array(1));
    expect(() => encodeWav({ sampleRate: 48000, channels: nine })).toThrow(/more than the 8/);
    expect(() =>
      encodeWav({ sampleRate: 48000, channels: [new Float32Array(2), new Float32Array(3)] })
    ).toThrow(/same length/);
    const huge = {
      sampleRate: 48000,
      channels: [{ length: 0x80000000 } as unknown as Float32Array]
    };
    expect(() => encodeWav(huge)).toThrow(/too long/);
  });
});
