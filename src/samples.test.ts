// Unit tests for the bring-your-own-assets sample registry
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSamples,
  getSampleBaseNote,
  getSampleBuffer,
  loadSamples,
  registerSample,
  registerSamples
} from './samples';
import { FakeAudioContext } from './test-utils/fakeAudioContext';
import type { AudioBufferLike } from './types';

const FAKE_BUFFER: AudioBufferLike = { getChannelData: () => new Float32Array(4) };

beforeEach(() => {
  clearSamples();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerSample / registerSamples', () => {
  it('accepts an already-decoded buffer directly, with no decode step needed', () => {
    registerSample('bd', FAKE_BUFFER);
    const ctx = new FakeAudioContext();
    expect(getSampleBuffer(ctx, 'bd')).toBe(FAKE_BUFFER);
  });

  it('registers many samples at once', () => {
    registerSamples({ bd: FAKE_BUFFER, sd: { buffer: FAKE_BUFFER } });
    const ctx = new FakeAudioContext();
    expect(getSampleBuffer(ctx, 'bd')).toBe(FAKE_BUFFER);
    expect(getSampleBuffer(ctx, 'sd')).toBe(FAKE_BUFFER);
  });

  it('stores baseNote metadata alongside the source', () => {
    registerSample('piano', { buffer: FAKE_BUFFER, baseNote: 'c4' });
    expect(getSampleBaseNote('piano')).toBe('c4');
  });

  it('returns undefined baseNote for a sample that never set one', () => {
    registerSample('bd', FAKE_BUFFER);
    expect(getSampleBaseNote('bd')).toBeUndefined();
  });
});

describe('getSampleBuffer', () => {
  it('warns once and skips (returns undefined) for an unregistered name', () => {
    const ctx = new FakeAudioContext();
    expect(getSampleBuffer(ctx, 'nope')).toBeUndefined();
    expect(getSampleBuffer(ctx, 'nope')).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('nope'));
  });

  it('decodes on demand for a registered sample with raw data, returning undefined the first synchronous call', async () => {
    registerSample('kick', { data: new ArrayBuffer(8) });
    const ctx = new FakeAudioContext();
    expect(getSampleBuffer(ctx, 'kick')).toBeUndefined(); // decode kicked off, not ready yet
    await loadSamples(ctx, ['kick']);
    expect(getSampleBuffer(ctx, 'kick')).toBeDefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('caches the decoded buffer per context', async () => {
    registerSample('kick', { data: new ArrayBuffer(8) });
    const ctx = new FakeAudioContext();
    await loadSamples(ctx, ['kick']);
    const first = getSampleBuffer(ctx, 'kick');
    const second = getSampleBuffer(ctx, 'kick');
    expect(first).toBe(second);
  });

  it("prefers the bank-prefixed key over the bare name when it's registered", () => {
    registerSample('RolandTR707_bd', FAKE_BUFFER);
    const other: AudioBufferLike = { getChannelData: () => new Float32Array(8) };
    registerSample('bd', other);
    const ctx = new FakeAudioContext();
    expect(getSampleBuffer(ctx, 'bd', 'RolandTR707')).toBe(FAKE_BUFFER);
  });

  it('falls back to the bare name when the banked key is not registered', () => {
    registerSample('bd', FAKE_BUFFER);
    const ctx = new FakeAudioContext();
    expect(getSampleBuffer(ctx, 'bd', 'RolandTR707')).toBe(FAKE_BUFFER);
  });
});

describe('loadSamples', () => {
  it('preloads every registered sample when called with no names', async () => {
    registerSamples({ bd: { data: new ArrayBuffer(4) }, sd: { data: new ArrayBuffer(4) } });
    const ctx = new FakeAudioContext();
    await loadSamples(ctx);
    expect(getSampleBuffer(ctx, 'bd')).toBeDefined();
    expect(getSampleBuffer(ctx, 'sd')).toBeDefined();
  });

  it('rejects for a name that was never registered', async () => {
    const ctx = new FakeAudioContext();
    await expect(loadSamples(ctx, ['nope'])).rejects.toThrow(/not registered/);
  });
});

describe('clearSamples', () => {
  it('empties the registry so a previously-registered name is unregistered again', () => {
    registerSample('bd', FAKE_BUFFER);
    clearSamples();
    const ctx = new FakeAudioContext();
    expect(getSampleBuffer(ctx, 'bd')).toBeUndefined();
  });
});
