// Tests that a marked documentation block is run offline and its sound comes out as WAV files, on the fake Web Audio context
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import { FakeAudioContext, FakeOfflineAudioContext } from '../../src/test-utils/fakeAudioContext';
import { renderBlock } from './renderBlock';
import type { BlockSpec, RenderEngine } from './renderBlock';
import { standInFor, standInWav } from './standIns';

/** The test's code literals are indented; a block's import lines must start a line. */
const run = (code: string, spec: BlockSpec, with_: RenderEngine) =>
  renderBlock(code.replace(/^[ \t]+/gm, ''), spec, with_);

const made: FakeOfflineAudioContext[] = [];

class OfflineFake extends FakeOfflineAudioContext {
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    super({ numberOfChannels, length, sampleRate });
    made.push(this);
  }
}

const engine: RenderEngine = { OfflineAudioContext: OfflineFake };
const globals = globalThis as Record<string, unknown>;
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

afterEach(() => {
  made.length = 0;
});

describe('renderBlock, a block that renders itself', () => {
  const code = `
    import { encodeWav, note } from '@liminal-hq/undertone';
    const loop = note('c3 e3').sound('triangle');
    const buffer = await loop.render({ cycles: 2, bpm: 120, tail: 1 });
    encodeWav(buffer, { bitDepth: 24 });
  `;

  it('returns the render as a WAV file in the bit depth the block asked for', async () => {
    const [file, ...rest] = await run(code, { page: 'p.md', kind: 'run' }, engine);
    expect(rest).toEqual([]);
    expect(file.file).toBe('render.wav');
    expect(file.sampleRate).toBe(48000);
    expect(file.channels).toBe(2);
    expect(file.seconds).toBeCloseTo(5, 6); // two 2 s cycles and a 1 s tail
    expect(file.bitDepth).toBe(24);
    const header = view(file.bytes);
    expect(String.fromCharCode(...file.bytes.slice(0, 4))).toBe('RIFF');
    expect(header.getUint16(22, true)).toBe(2);
    expect(header.getUint32(24, true)).toBe(48000);
    expect(header.getUint16(34, true)).toBe(24);
  });

  it('writes 16-bit when the block never encodes the render, one file per render, named by the labels', async () => {
    const two = `
      import { note } from '@liminal-hq/undertone';
      const a = note('c3').sound('triangle');
      await a.render({ cycles: 1 });
      await a.render({ cycles: 2, master: { ceiling: -1 } });
    `;
    const spec: BlockSpec = { page: 'p.md', kind: 'run', labels: ['first', 'second'] };
    const files = await run(two, spec, engine);
    expect(files.map((f) => f.file)).toEqual(['first.wav', 'second.wav']);
    expect(files.map((f) => f.bitDepth)).toEqual([16, 16]);
    expect(files.map((f) => f.seconds)).toEqual([2, 4]);
  });

  it('keeps only the first trimSeconds and says so', async () => {
    const [file] = await run(code, { page: 'p.md', kind: 'run', trimSeconds: 2 }, engine);
    expect(file.seconds).toBe(2);
    expect(file.note).toContain('Only the first 2 s of the 5 s render');
  });

  it('fails, naming the problem, when the block renders nothing or throws', async () => {
    await expect(run('const x = 1;', { page: 'p.md', kind: 'run' }, engine)).rejects.toThrow(
      'never rendered'
    );
    await expect(
      run('throw new Error("boom");', { page: 'p.md', kind: 'run' }, engine)
    ).rejects.toThrow('boom');
    await expect(
      run("import { nope } from '@liminal-hq/undertone';", { page: 'p.md', kind: 'run' }, engine)
    ).rejects.toThrow('nope');
  });
});

describe('renderBlock, a block that plays live', () => {
  it('renders the pattern the block loops, with its own tempo and the capture length', async () => {
    const code = `
      import { note } from '@liminal-hq/undertone';
      note('c4 e4').sound('triangle').loop({ bpm: 60 });
    `;
    const [file, ...rest] = await run(
      code,
      { page: 'p.md', kind: 'capture', cycles: 2, tail: 0.5 },
      engine
    );
    expect(rest).toEqual([]);
    expect(file.file).toBe('audio.wav');
    expect(file.seconds).toBeCloseTo(8.5, 6); // two 4 s cycles at 60 bpm and half a second of tail
    expect(file.bitDepth).toBe(16);
    // The block's own AudioContext is never the one that renders: the render makes its own offline context.
    expect(made.some((ctx) => ctx.rendered)).toBe(true);
  });

  it('renders the layouts asked for, and says the stereo file is folded by the library', async () => {
    const code = `
      import { note } from '@liminal-hq/undertone';
      note('c4').sound('triangle').surround(135).loop();
    `;
    const files = await run(
      code,
      { page: 'p.md', kind: 'capture', cycles: 1, tail: 0, channels: [2, 6] },
      engine
    );
    expect(files.map((f) => [f.file, f.channels])).toEqual([
      ['stereo.wav', 2],
      ['5.1.wav', 6]
    ]);
    expect(files[0].note).toContain('folded to two channels');
    expect(files[1].note).not.toContain('folded');
  });

  it('maps a master bus the block made onto the render, and uses the raw mix otherwise', async () => {
    const withBus = `
      import { createMasterBus, note } from '@liminal-hq/undertone';
      const ctx = new AudioContext();
      const bus = createMasterBus(ctx, { gain: 0.9 });
      note('c4').sound('triangle').loop({ ctx, output: bus.input });
    `;
    await run(withBus, { page: 'p.md', kind: 'capture', cycles: 1 }, engine);
    const rendering = made.filter((ctx) => ctx.rendered);
    expect(rendering).toHaveLength(1);
    expect(rendering[0].compressors.length).toBeGreaterThan(0); // the limiter of the bus

    made.length = 0;
    const raw = `
      import { note } from '@liminal-hq/undertone';
      note('c4').sound('triangle').loop();
    `;
    await run(raw, { page: 'p.md', kind: 'capture', cycles: 1 }, engine);
    expect(made.filter((ctx) => ctx.rendered)[0].compressors).toHaveLength(0);
  });

  it('fails when the block plays through an output it cannot map, or plays nothing', async () => {
    const unknown = `
      import { note } from '@liminal-hq/undertone';
      const ctx = new AudioContext();
      note('c4').loop({ ctx, output: ctx.createGain() });
    `;
    await expect(run(unknown, { page: 'p.md', kind: 'capture' }, engine)).rejects.toThrow(
      'cannot map'
    );
    await expect(run('const a = 1;', { page: 'p.md', kind: 'capture' }, engine)).rejects.toThrow(
      'never played or looped'
    );
  });

  it('repeats the room and delay the block set on an orbit bus on the render', async () => {
    const code = `
      import { getOrbitBus, note } from '@liminal-hq/undertone';
      const ctx = new AudioContext();
      const bus = getOrbitBus(ctx, 2);
      bus.setRoomSize(3);
      bus.setDelay(0.25, 0.4);
      note('c4').sound('triangle').room(0.5).orbit(2).loop({ ctx });
    `;
    await run(code, { page: 'p.md', kind: 'capture', cycles: 1 }, engine);
    const rendering = made.filter((ctx) => ctx.rendered)[0];
    expect(
      rendering.delays.some((delay) => delay.delayTime.calls.some((c) => c.value === 0.25))
    ).toBe(true);
    // The voice's own room size then replaces the block's, as it does when the block runs live (last writer wins).
    expect(rendering.convolvers.length).toBeGreaterThan(0);
  });
});

describe('renderBlock, a block that makes its own context', () => {
  it('renders the context the block played on, for the seconds the entry names', async () => {
    const code = `
      import { playParams } from '@liminal-hq/undertone';
      const ctx = new AudioContext();
      playParams(ctx, [{ soundType: 'sawtooth', pitch: 'a2', sustain: 0.6, duration: 1 }]);
    `;
    const [file] = await run(code, { page: 'p.md', kind: 'direct', seconds: 3 }, engine);
    expect(file.seconds).toBe(3);
    expect(file.file).toBe('audio.wav');
    expect(made.filter((ctx) => ctx.rendered)).toHaveLength(1);
    expect(made[0].oscillators.length).toBeGreaterThan(0);
  });

  it('fails when the block never made a context', async () => {
    await expect(run('const a = 1;', { page: 'p.md', kind: 'direct' }, engine)).rejects.toThrow(
      'never made an AudioContext'
    );
  });
});

describe('renderBlock, samples and globals', () => {
  const samples = `
    import { loadSamples, note, registerSamples } from '@liminal-hq/undertone';
    registerSamples({ bd: '/audio/808/kick.wav' });
    const ctx = new AudioContext();
    await loadSamples(ctx);
    console.log('loaded');
    note('c2').s('bd').loop({ ctx });
  `;

  it('answers a sample URL with a procedural stand-in, says so in the note, and passes console.log along', async () => {
    const [file] = await run(samples, { page: 'p.md', kind: 'capture', cycles: 1 }, engine);
    expect(file.note).toContain('stand-ins made for this page');
    expect(file.logs).toEqual(['loaded']);
  });

  it('fails on a sample URL it has no stand-in for', async () => {
    const missing = samples.replace('/audio/808/kick.wav', '/audio/other.wav');
    await expect(
      run(missing, { page: 'p.md', kind: 'capture', cycles: 1 }, engine)
    ).rejects.toThrow('404');
  });

  it('puts the globals and the pattern methods back, also after a failure', async () => {
    const saved = {
      ctx: globals.AudioContext,
      offline: globals.OfflineAudioContext,
      fetch: globals.fetch
    };
    class Marker extends FakeAudioContext {}
    globals.AudioContext = Marker;
    const { Pattern } = await import('../../src/index');
    const loop = Pattern.prototype.loop;
    await expect(
      run('throw new Error("x");', { page: 'p.md', kind: 'capture' }, engine)
    ).rejects.toThrow('x');
    expect(globals.AudioContext).toBe(Marker);
    expect(globals.OfflineAudioContext).toBe(saved.offline);
    expect(globals.fetch).toBe(saved.fetch);
    expect(Pattern.prototype.loop).toBe(loop);
    globals.AudioContext = saved.ctx;
  });
});

describe('standIns', () => {
  it('picks a stand-in by the file name and makes the same bytes each time', () => {
    expect(standInFor('/audio/808/kick.wav')).toBe('kick');
    expect(standInFor('/audio/snare.wav')).toBe('snare');
    expect(standInFor('/audio/pluck-e1.wav')).toBe('pluck');
    expect(standInFor('/audio/808/HAT.wav')).toBe('hat');
    expect(standInFor('/audio/vocal.wav')).toBeUndefined();
    expect(standInWav('/audio/vocal.wav')).toBeUndefined();
    const first = standInWav('/audio/snare.wav');
    expect(first).toBeDefined();
    expect(
      Buffer.from(first as Uint8Array).equals(
        Buffer.from(standInWav('/audio/snare.wav') as Uint8Array)
      )
    ).toBe(true);
  });
});
