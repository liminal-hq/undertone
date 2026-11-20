// Unit tests for the bring-your-own-assets sample registry (ported from src/samples.test.ts)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSamples,
  getSampleBaseNote,
  getSampleBuffer,
  isSampleRegistered,
  loadSamples,
  registerSample,
  registerSamples
} from '@liminal-hq/undertone';
import type { AudioBufferLike } from '@liminal-hq/undertone';
import { FakeAudioContext } from '../../../src/test-utils/fakeAudioContext';

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

  it('rejects an invalid baseNote eagerly, at registration time', () => {
    // Must throw here, not inside playVoice() during a loop's tick — a throw
    // there happens before the scheduler advances scheduledUntil, so it
    // would re-query and re-throw on the same window forever.
    expect(() => registerSample('piano', { buffer: FAKE_BUFFER, baseNote: 'h4' })).toThrow(
      /Invalid note name/
    );
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

describe('isSampleRegistered', () => {
  it('is false for a name that was never registered', () => {
    expect(isSampleRegistered('bd')).toBe(false);
  });

  it('is true for a bare registered name', () => {
    registerSample('bd', FAKE_BUFFER);
    expect(isSampleRegistered('bd')).toBe(true);
  });

  it('is true when the bank-prefixed key is registered, even if the bare name is not', () => {
    registerSample('RolandTR707_bd', FAKE_BUFFER);
    expect(isSampleRegistered('bd', 'RolandTR707')).toBe(true);
    expect(isSampleRegistered('bd')).toBe(false);
  });

  it('falls back to the bare name when the banked key is not registered', () => {
    registerSample('bd', FAKE_BUFFER);
    expect(isSampleRegistered('bd', 'RolandTR707')).toBe(true);
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

  it('does not permanently cache a failed decode — a later call retries instead of replaying it', async () => {
    registerSample('kick', { url: 'https://example.com/kick.wav' });
    const ctx = new FakeAudioContext();

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4))
      } as Response);

    await expect(loadSamples(ctx, ['kick'])).rejects.toThrow(/network blip/);
    await loadSamples(ctx, ['kick']); // must retry, not replay the cached rejection
    expect(getSampleBuffer(ctx, 'kick')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('registering a name again', () => {
  const lengthOf = (buffer: AudioBufferLike | undefined) => buffer?.getChannelData(0).length;

  it('decodes the new source, and never serves what was decoded for the old one', async () => {
    registerSample('kick', { data: new ArrayBuffer(8) });
    const ctx = new FakeAudioContext();
    await loadSamples(ctx, ['kick']);
    expect(lengthOf(getSampleBuffer(ctx, 'kick'))).toBe(8);

    registerSample('kick', { data: new ArrayBuffer(16) });
    expect(getSampleBuffer(ctx, 'kick')).toBeUndefined(); // the old buffer is not served; the new source decodes
    await loadSamples(ctx, ['kick']);
    expect(lengthOf(getSampleBuffer(ctx, 'kick'))).toBe(16);
  });

  it('decodes the new source when it is registered while the old one is still decoding', async () => {
    registerSample('kick', { data: new ArrayBuffer(8) });
    const ctx = new FakeAudioContext();
    const old = loadSamples(ctx, ['kick']);
    registerSample('kick', { data: new ArrayBuffer(16) });
    await loadSamples(ctx, ['kick']);
    await old;
    expect(lengthOf(getSampleBuffer(ctx, 'kick'))).toBe(16);
  });

  it('decodes again after the registry was cleared and the name registered anew', async () => {
    registerSample('kick', { data: new ArrayBuffer(8) });
    const ctx = new FakeAudioContext();
    await loadSamples(ctx, ['kick']);
    clearSamples();
    registerSample('kick', { data: new ArrayBuffer(12) });
    await loadSamples(ctx, ['kick']);
    expect(lengthOf(getSampleBuffer(ctx, 'kick'))).toBe(12);
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

describe('what a context keeps of a decoded sample', () => {
  /** A garbage collection on demand (Node's `gc`, switched on at run time), so a test can see what is still held. */
  async function collect(): Promise<void> {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    for (let round = 0; round < 3; round += 1) {
      await new Promise((done) => setTimeout(done, 0));
      gc();
    }
  }

  /** Decodes `kick` on `ctx` and returns a weak reference to the buffer, holding nothing itself. */
  async function decodeKick(ctx: FakeAudioContext): Promise<WeakRef<AudioBufferLike>> {
    let seen: WeakRef<AudioBufferLike> | undefined;
    // Not a spy: a mock records what it returned, which would hold the buffer itself.
    ctx.decodeAudioData = () => {
      const buffer = ctx.createBuffer(1, 8, 44100);
      seen = new WeakRef(buffer);
      return Promise.resolve(buffer);
    };
    registerSample('kick', { data: new ArrayBuffer(8) });
    await loadSamples(ctx, ['kick']);
    return seen as WeakRef<AudioBufferLike>;
  }

  it('lets go of a decoded buffer when the registry is cleared, though its context lives on', async () => {
    const ctx = new FakeAudioContext();
    const seen = await decodeKick(ctx);
    expect(seen.deref()).toBeDefined();
    clearSamples();
    await collect();
    expect(seen.deref()).toBeUndefined();
    expect(ctx.currentTime).toBe(0); // the context was alive throughout
  });

  it('lets go of a decoded buffer when the name is registered again', async () => {
    const ctx = new FakeAudioContext();
    const seen = await decodeKick(ctx);
    registerSample('kick', { data: new ArrayBuffer(16) });
    await collect();
    expect(seen.deref()).toBeUndefined();
    expect(ctx.currentTime).toBe(0);
  });

  it('retries a decode whose buffer could not be read, as it does a failed decode', async () => {
    const ctx = new FakeAudioContext();
    const buffer = { getChannelData: vi.fn(() => new Float32Array(4)) };
    buffer.getChannelData.mockImplementationOnce(() => {
      throw new Error('transient read failure');
    });
    const decode = vi
      .spyOn(ctx, 'decodeAudioData')
      .mockImplementation(() => Promise.resolve(buffer as never));
    registerSample('kick', { data: new ArrayBuffer(8) });
    await expect(loadSamples(ctx, ['kick'])).rejects.toThrow('transient read failure');
    await loadSamples(ctx, ['kick']); // the failure was not cached
    expect(decode).toHaveBeenCalledTimes(2);
    expect(getSampleBuffer(ctx, 'kick')).toBe(buffer);
  });

  it('retries a decode the module rejected, and keeps nothing of the rejected one', async () => {
    const ctx = new FakeAudioContext();
    const bad = { numberOfChannels: 0, getChannelData: () => new Float32Array(4) };
    const good = { getChannelData: () => new Float32Array(4) };
    const decode = vi
      .spyOn(ctx, 'decodeAudioData')
      .mockImplementationOnce(() => Promise.resolve(bad as never))
      .mockImplementation(() => Promise.resolve(good as never));
    registerSample('kick', { data: new ArrayBuffer(8) });
    await expect(loadSamples(ctx, ['kick'])).rejects.toThrow();
    expect(getSampleBuffer(ctx, 'kick')).toBeUndefined();
    await loadSamples(ctx, ['kick']); // retried, not served from a cache of the rejected buffer
    expect(decode).toHaveBeenCalledTimes(2);
    expect(getSampleBuffer(ctx, 'kick')).toBe(good);
  });

  it('warns once for a voice whose decoded buffer cannot be read', async () => {
    const ctx = new FakeAudioContext();
    vi.spyOn(ctx, 'decodeAudioData').mockImplementation(() =>
      Promise.resolve({
        getChannelData: () => {
          throw new Error('always failing');
        }
      } as never)
    );
    registerSample('kick', { data: new ArrayBuffer(8) });
    expect(getSampleBuffer(ctx, 'kick')).toBeUndefined();
    await new Promise((done) => setTimeout(done, 0));
    expect(getSampleBuffer(ctx, 'kick')).toBeUndefined(); // retried, fails again
    await new Promise((done) => setTimeout(done, 0));
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      'undertone: sample "kick" failed to load — voice skipped.'
    );
  });
});
