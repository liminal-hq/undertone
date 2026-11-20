// Tests for the opt-in AudioWorklet backend: its message formats, scheduling, refusals, the worklet shim, and the processor itself
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The main-thread side runs against a fake context, node, and message port. The processor runs for real: the module the package
// builds for the worklet (shim, the render module's glue, processor) is evaluated in a bare `vm` context that has no `TextDecoder`,
// `TextEncoder`, `fetch`, `URL`, or `import.meta`, as the worklet scope has none, with a stand-in `AudioWorkletProcessor`.
// That proves the shim is present and enough, that the glue never reaches for the page's globals, and that what the processor
// renders equals what `renderToBuffer` renders. A headless browser run (harness/check.ts) does the same in a real worklet.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSamples,
  note,
  registerSample,
  renderToBuffer,
  resetTempo,
  s,
  setcpm,
  sound
} from '@liminal-hq/undertone';
import { resetWarnings } from '@liminal-hq/undertone/testing';
import {
  createWorkletOutput,
  workletModuleSource,
  type WorkletContextLike,
  type WorkletNodeLike,
  type WorkletOutputOptions
} from '@liminal-hq/undertone/worklet';
import { workletProcessorName, workletProcessorSource } from '../dist/workletProcessor.js';
import { workletShimSource } from '../dist/workletShim.js';

const wasmPath = new URL('../wasm/render/undertone_wasm_render_bg.wasm', import.meta.url);
const gluePath = new URL('../wasm/render/undertone_wasm_render.js', import.meta.url);
const wasmBytes = readFileSync(wasmPath);
const glueText = readFileSync(gluePath, 'utf8');

afterEach(() => {
  clearSamples();
  resetTempo();
  resetWarnings();
  vi.restoreAllMocks();
});

// --- the fakes of the main-thread side ---

class FakePort {
  sent: { message: Record<string, unknown>; transfer: Transferable[] }[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.sent.push({ message: message as Record<string, unknown>, transfer });
  }
  close(): void {
    this.closed = true;
  }
  /** What the worklet would send. */
  receive(message: unknown): void {
    this.onmessage?.({ data: message });
  }
  ofType(type: string) {
    return this.sent.filter((entry) => entry.message.type === type);
  }
}

class FakeNode implements WorkletNodeLike {
  readonly port = new FakePort();
  onprocessorerror: ((event: unknown) => void) | null = null;
  connected: unknown[] = [];
  disconnected = false;
  constructor(
    readonly name: string,
    readonly options: Record<string, unknown>
  ) {}
  connect(destination: unknown): unknown {
    this.connected.push(destination);
    return destination;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

interface FakeContext extends WorkletContextLike {
  currentTime: number;
  modules: string[];
  decoded: number;
}

function fakeContext(extra: Partial<WorkletContextLike> = {}): FakeContext {
  const context = {
    currentTime: 1,
    sampleRate: 48000,
    destination: { channelCount: 2, maxChannelCount: 2 },
    modules: [] as string[],
    decoded: 0,
    audioWorklet: {
      addModule(url: string): Promise<void> {
        context.modules.push(url);
        return Promise.resolve();
      }
    },
    decodeAudioData(): Promise<unknown> {
      context.decoded += 1;
      return Promise.resolve({
        numberOfChannels: 1,
        sampleRate: 48000,
        getChannelData: () => new Float32Array(480).fill(0.25)
      });
    },
    ...extra
  };
  return context as FakeContext;
}

/** Options that make a ready fake node. */
function fakeOptions(extra: Partial<WorkletOutputOptions> = {}) {
  const nodes: FakeNode[] = [];
  const options: WorkletOutputOptions = {
    glueText: '/* the glue */',
    wasm: wasmBytes,
    createNode: (_context, name, nodeOptions) => {
      const node = new FakeNode(name, nodeOptions);
      nodes.push(node);
      // The processor says it is ready as soon as it exists.
      queueMicrotask(() => node.port.receive({ type: 'ready', timing: 'performance.now' }));
      return node;
    },
    ...extra
  };
  return { options, nodes };
}

describe('createWorkletOutput', () => {
  it('adds the module once per context, from a blob made at run time, and posts the compiled render module', async () => {
    const context = fakeContext();
    const urls: string[] = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = create(blob);
      urls.push(url);
      return url;
    });
    const first = fakeOptions({ channels: 2, seed: 'x', master: false });
    const output = await createWorkletOutput(context, first.options);
    const second = fakeOptions();
    await createWorkletOutput(context, second.options);

    expect(context.modules).toHaveLength(1);
    expect(context.modules[0]).toMatch(/^blob:/);
    expect(revoke).toHaveBeenCalledWith(urls[0]);
    const node = first.nodes[0];
    expect(node.name).toBe(workletProcessorName);
    expect(node.options).toMatchObject({
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    const settings = node.options.processorOptions as { module: unknown; options: object };
    expect(settings.module).toBeInstanceOf(WebAssembly.Module);
    expect(settings.options).toEqual({ sampleRate: 48000, channels: 2, seed: 'x', master: false });
    expect(node.connected).toEqual([context.destination]);
    expect(output.sampleRate).toBe(48000);
    expect(output.channels).toBe(2);
  });

  it('builds the worklet module from the shim, the glue, and the processor, in that order', () => {
    const source = workletModuleSource('GLUE_MARKER');
    const shim = source.indexOf(workletShimSource);
    const glue = source.indexOf('GLUE_MARKER');
    const processor = source.indexOf(workletProcessorSource);
    expect(shim).toBeGreaterThanOrEqual(0);
    expect(glue).toBeGreaterThan(shim);
    expect(processor).toBeGreaterThan(glue);
    // The shim and the processor never reach for the page's globals, which a worklet scope lacks.
    for (const text of [workletShimSource, workletProcessorSource]) {
      expect(text).not.toMatch(/import\.meta|\bfetch\b|new URL|\bdocument\b|\bwindow\b/);
    }
  });

  it('refuses what it cannot play, with a message that says why', async () => {
    const context = fakeContext();
    await expect(createWorkletOutput(context, { channels: 3 as never })).rejects.toThrow(
      'channels must be 1, 2, 4, 6 or 8, got 3'
    );
    await expect(
      createWorkletOutput(context, { ...fakeOptions().options, channels: 6 })
    ).rejects.toThrow('maxChannelCount is 2');
    const bare = fakeContext({ audioWorklet: undefined });
    await expect(createWorkletOutput(bare, fakeOptions().options)).rejects.toThrow(
      'no audioWorklet: an AudioWorklet needs a secure context'
    );
    // A processor that never starts is reported, not waited for forever.
    const silent = fakeOptions({
      timeoutMs: 20,
      createNode: (_c, name, o) => new FakeNode(name, o)
    });
    await expect(createWorkletOutput(fakeContext(), silent.options)).rejects.toThrow(
      'did not start within 20 ms'
    );
    // A processor that throws in its constructor is reported.
    const broken = fakeOptions({
      createNode: (_c, name, o) => {
        const node = new FakeNode(name, o);
        queueMicrotask(() => node.onprocessorerror?.({}));
        return node;
      }
    });
    await expect(createWorkletOutput(fakeContext(), broken.options)).rejects.toThrow(
      'the worklet processor failed'
    );
  });

  it('widens the destination for a multichannel output and connects where it is told', async () => {
    const wide = fakeContext({
      destination: { channelCount: 2, maxChannelCount: 8 }
    });
    const first = fakeOptions({ channels: 6 });
    await createWorkletOutput(wide, first.options);
    expect(wide.destination.channelCount).toBe(6);
    expect(wide.destination.channelInterpretation).toBe('discrete');
    const target = { name: 'a gain node' };
    const second = fakeOptions({ connect: target });
    await createWorkletOutput(fakeContext(), second.options);
    expect(second.nodes[0].connected).toEqual([target]);
    const third = fakeOptions({ connect: false });
    await createWorkletOutput(fakeContext(), third.options);
    expect(third.nodes[0].connected).toEqual([]);
  });

  it('gives the processor the bytes when the browser cannot send it a compiled module', async () => {
    let attempts = 0;
    const nodes: FakeNode[] = [];
    const { options } = fakeOptions({
      createNode: (_c, name, nodeOptions) => {
        attempts += 1;
        if (attempts === 1)
          throw Object.assign(new Error('cannot clone'), { name: 'DataCloneError' });
        const node = new FakeNode(name, nodeOptions);
        nodes.push(node);
        queueMicrotask(() => node.port.receive({ type: 'ready' }));
        return node;
      }
    });
    await createWorkletOutput(fakeContext(), options);
    expect(attempts).toBe(2);
    const settings = nodes[0].options.processorOptions as { module: unknown };
    expect(settings.module).not.toBeInstanceOf(WebAssembly.Module);
    expect(new Uint8Array(settings.module as ArrayBuffer).byteLength).toBeGreaterThan(1000);
  });
});

describe('play and loop', () => {
  async function ready(extra: Partial<WorkletOutputOptions> = {}, context = fakeContext()) {
    const { options, nodes } = fakeOptions(extra);
    const output = await createWorkletOutput(context, options);
    return { output, node: nodes[0], port: nodes[0].port, context };
  }

  it('posts the collected voices with the frame they start at, and transfers the numbers', async () => {
    const { output, port } = await ready();
    const playback = output.play(note('c4 e4').sound('triangle'), { cycles: 2, bpm: 60 });
    await playback.ready;
    const [{ message, transfer }] = port.ofType('play');
    // Context time 1 s plus the 0.15 s lead, at 48 kHz.
    expect(message.frame).toBe(Math.round(1.15 * 48000));
    expect(message.period).toBeUndefined();
    expect(message.numbers).toBeInstanceOf(Float64Array);
    expect((message.numbers as Float64Array)[0]).toBe(4);
    expect(message.strings).toEqual(expect.arrayContaining(['triangle']));
    expect(transfer).toEqual([(message.numbers as Float64Array).buffer]);
    // The voices' own start times are seconds from the pass: 60 bpm is four seconds a cycle.
    const starts = [];
    const numbers = message.numbers as Float64Array;
    // Each voice is its start, then a map (5, count, ...); the first start is 0.
    expect(numbers[1]).toBe(0);
    starts.push(numbers[1]);
    expect(starts).toEqual([0]);
  });

  it('starts at `when` when it is given', async () => {
    const { output, port } = await ready();
    await output.play(note('c4'), { when: 2.5 }).ready;
    expect(port.ofType('play')[0].message.frame).toBe(120000);
  });

  it('repeats a loop on the worklet clock: the period is the pass in frames, at the tempo asked for', async () => {
    const { output, port } = await ready();
    await output.loop(note('c4 e4'), { cycles: 2, bpm: 120 }).ready;
    await output.loop(note('c4'), { cps: 0.5 }).ready;
    setcpm(30);
    await output.loop(note('c4')).ready;
    resetTempo();
    await output.loop(note('c4')).ready;
    const periods = port.ofType('play').map((entry) => entry.message.period);
    // 120 bpm is a 2 s cycle: two cycles of 96,000 frames each; cps 0.5 is 96,000; setcpm(30) is 2 s a cycle; the default is 2 s.
    expect(periods).toEqual([192000, 96000, 96000, 96000]);
  });

  it('stops a loop with a cancel for its token, and does not post a pass that was stopped first', async () => {
    const { output, port } = await ready();
    const first = output.loop(note('c4'));
    await first.ready;
    const token = port.ofType('play')[0].message.token;
    first.stop();
    expect(port.ofType('cancel')[0].message).toEqual({ type: 'cancel', token });
    // A pass with nothing to wait for is posted at once, so a stop is a cancel behind it, in that order.
    const second = output.play(note('c4'));
    second.stop();
    await second.ready;
    expect(port.sent.map((entry) => entry.message.type)).toEqual([
      'play',
      'cancel',
      'play',
      'cancel'
    ]);
  });

  it('does not post a pass that was stopped while its sample was still being decoded', async () => {
    const { output, port, context } = await ready();
    registerSample('slow', { data: new ArrayBuffer(8) });
    const pass = output.play(s('slow'));
    pass.stop();
    await pass.ready;
    expect(context.decoded).toBe(1);
    expect(port.ofType('play')).toHaveLength(0);
    expect(port.ofType('cancel')).toHaveLength(1);
  });

  it('reports a bad option or a pattern that cannot be collected to the caller at once', async () => {
    const { output, port } = await ready();
    expect(() => output.play(note('c4'), { cycles: 1.5 })).toThrow(
      /cycles must be a positive whole number/
    );
    expect(() => output.play(note('c4'), { bpm: 120, cps: 1 })).toThrow(/Pass either bpm or cps/);
    expect(() =>
      output.play(
        {
          query() {
            throw new Error('a leaf that throws');
          }
        },
        {}
      )
    ).toThrow(/a leaf that throws/);
    expect(port.ofType('play')).toHaveLength(0);
  });

  it('collects a JavaScript leaf on this thread and sends plain voices', async () => {
    const { output, port } = await ready();
    const leaf = note('c4 e4').sound('sine');
    // Any object with a query() is a pattern: a foreign leaf is queried here, never in the worklet.
    const wrapped = { query: (span: Parameters<typeof leaf.query>[0]) => leaf.query(span) };
    await output.play(wrapped).ready;
    expect((port.ofType('play')[0].message.numbers as Float64Array)[0]).toBe(2);
  });

  it('refuses after it is closed, and a closed output posts nothing more', async () => {
    const { output, port, node } = await ready();
    output.close();
    expect(port.ofType('close')).toHaveLength(1);
    expect(node.disconnected).toBe(true);
    expect(port.closed).toBe(true);
    expect(() => output.play(note('c4'))).toThrow('this output is closed');
    output.close();
    expect(port.ofType('close')).toHaveLength(1);
  });

  it('decodes a sample a pass names before it posts the pass, and the worklet gets the sample first', async () => {
    const { output, port, context } = await ready();
    registerSample('kick', { data: new ArrayBuffer(8) });
    // Registered after the output existed: the worklet's registry is told at once (pending, no PCM yet).
    expect(port.ofType('sample').map((entry) => entry.message.op)).toEqual(['pending']);
    await output.play(s('kick')).ready;
    expect(context.decoded).toBe(1);
    const order = port.sent.map((entry) =>
      entry.message.type === 'sample'
        ? `sample:${String(entry.message.op)}`
        : String(entry.message.type)
    );
    expect(order).toEqual(['sample:pending', 'sample:load', 'play']);
    const load = port.ofType('sample')[1].message as {
      name: string;
      decoded: { sampleRate: number; channels: Float32Array[] };
    };
    expect(load.name).toBe('kick');
    expect(load.decoded.channels[0]).toHaveLength(480);
    // A sample registered with its PCM goes over at once, and the registry's clear is passed on.
    registerSample('snare', { buffer: { getChannelData: () => new Float32Array(10) } });
    expect(port.ofType('sample').at(-1)?.message).toMatchObject({ op: 'register', name: 'snare' });
    clearSamples();
    expect(port.ofType('sample').at(-1)?.message).toEqual({ type: 'sample', op: 'clear' });
    output.close();
    registerSample('after', { buffer: { getChannelData: () => new Float32Array(10) } });
    expect(port.ofType('sample').some((entry) => entry.message.name === 'after')).toBe(false);
  });

  it('passes an error from the worklet to onerror, and answers a statistics request with the main thread counts', async () => {
    const { output, port } = await ready();
    const errors: string[] = [];
    output.onerror = (message) => errors.push(message);
    port.receive({ type: 'error', message: 'a voice failed' });
    expect(errors).toEqual(['a voice failed']);
    await output.play(sound('sine*3')).ready;
    const asked = output.stats();
    const [{ message }] = port.ofType('stats');
    port.receive({ type: 'stats', id: message.id, blocks: 10, overruns: 0, errors: [] });
    const stats = await asked;
    expect(stats).toMatchObject({
      blocks: 10,
      overruns: 0,
      main: { passes: 1, voices: 3, samples: 0 }
    });
    expect(stats).not.toHaveProperty('type');
    expect(stats).not.toHaveProperty('id');
    output.resetStats();
    expect(port.ofType('reset-stats')).toHaveLength(1);
  });

  it('gives up on a statistics request the worklet does not answer', async () => {
    const { output } = await ready({ timeoutMs: 20 });
    await expect(output.stats()).rejects.toThrow(
      'did not answer a statistics request within 20 ms'
    );
  });
});

// --- the processor itself, in a worklet-like scope ---

interface Processor {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    posted: Record<string, unknown>[];
  };
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}

/**
 * A worklet-like scope: the shim, the render module's glue (made evaluable outside a module), and the processor, run in a `vm`
 * context with none of `TextDecoder`, `TextEncoder`, `fetch`, `URL`, or `performance` unless `clock` is given.
 */
function workletScope(options: { clock?: () => number; glue?: string } = {}) {
  const posted: Record<string, unknown>[] = [];
  class AudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      posted,
      postMessage: (message: Record<string, unknown>) => void posted.push(message)
    };
  }
  const registered = new Map<string, new (init: unknown) => Processor>();
  const sandbox: Record<string, unknown> = {
    AudioWorkletProcessor,
    registerProcessor: (name: string, processor: new (init: unknown) => Processor) =>
      void registered.set(name, processor),
    currentFrame: 0,
    sampleRate: 48000,
    console
  };
  if (options.clock !== undefined) sandbox.performance = { now: options.clock };
  const context = vm.createContext(sandbox);
  // `import.meta` and `export` are module syntax: the glue's default initialiser (which is never called) names `import.meta.url`.
  const glue = (options.glue ?? glueText)
    .replace(/^export \{[^}]*\};?\s*$/m, '')
    .replace(/^export (class|function|async function)/gm, '$1')
    .replace(/import\.meta\.url/g, 'undefined');
  vm.runInContext(workletModuleSource(glue), context);
  const Processor = registered.get(workletProcessorName);
  if (Processor === undefined) throw new Error('the processor did not register');
  return { sandbox, context, Processor, posted, registered };
}

/** A copy of `array` made in the vm context's own realm, as a message from the page would arrive. */
function inRealm<T extends Float64Array | Float32Array>(context: vm.Context, array: T): T {
  const Type = vm.runInContext(array.constructor.name, context) as new (
    items: ArrayLike<number>
  ) => T;
  return new Type(array);
}

describe('the worklet shim', () => {
  it('gives a scope with no TextDecoder or TextEncoder what the glue uses', () => {
    const sandbox: Record<string, unknown> = {};
    const context = vm.createContext(sandbox);
    expect(vm.runInContext('typeof TextDecoder + typeof TextEncoder', context)).toBe(
      'undefinedundefined'
    );
    vm.runInContext(workletShimSource, context);
    const run = (code: string): unknown => vm.runInContext(code, context);
    expect(run('typeof TextDecoder + typeof TextEncoder')).toBe('functionfunction');
    expect(run("new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode()")).toBe('');
    // Decodes a view into a larger buffer (wasm memory), multi-byte characters, and a surrogate pair.
    expect(
      run(`(function () {
        const memory = new Uint8Array(32).fill(0x7a);
        memory.set(new TextEncoder().encode('a\\u00e9\\u20ac\\u{1f3b5}'), 3);
        return new TextDecoder().decode(memory.subarray(3, 3 + 1 + 2 + 3 + 4));
      })()`)
    ).toBe('aé€\u{1f3b5}');
    expect(run("Array.from(new TextEncoder().encode('\\u20ac'))")).toEqual([0xe2, 0x82, 0xac]);
    // encodeInto stops before a character that does not fit, and says what it read and wrote.
    expect(
      run(
        "(function () { const view = new Uint8Array(4); return new TextEncoder().encodeInto('a\\u20ac\\u20ac', view); })()"
      )
    ).toEqual({ read: 2, written: 4 });
    // A malformed sequence throws with `fatal` and is replaced without it.
    expect(() =>
      run("new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff]))")
    ).toThrow(/not valid utf-8/);
    expect(run('new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62]))')).toBe('a�b');
    expect(() => run("new TextDecoder('latin1')")).toThrow(/utf-8 only/);
  });

  it('leaves a scope that has them alone', () => {
    const context = vm.createContext({ TextDecoder, TextEncoder });
    vm.runInContext(workletShimSource, context);
    expect(vm.runInContext('TextDecoder', context)).toBe(TextDecoder);
    expect(vm.runInContext('TextEncoder', context)).toBe(TextEncoder);
  });
});

describe('the processor in a worklet-like scope', () => {
  it('evaluates the real glue with no TextDecoder, fetch, or URL, and registers the processor under its name', () => {
    const { sandbox, registered } = workletScope();
    expect([...registered.keys()]).toEqual(['undertone-worklet']);
    // The shim made the codecs; the glue found nothing else to take from the page.
    expect((sandbox.TextDecoder as { name: string }).name).toBe('ShimTextDecoder');
    for (const name of ['fetch', 'URL', 'performance', 'Request', 'Response']) {
      expect(sandbox[name]).toBeUndefined();
    }
  });

  it('plays what the main thread posted, as the offline render does, and reports its statistics', async () => {
    // The pass the main thread would post, and the offline render of the same pattern and options.
    const sampleRate = 8000;
    const pattern = note('c3 g3 c4').sound('sawtooth').decay(0.05).lpf(1200);
    const rendered = await renderToBuffer(pattern, { sampleRate, cycles: 1, seed: 'p' });
    const { options, nodes } = fakeOptions();
    const context = fakeContext({ sampleRate });
    const output = await createWorkletOutput(context, { ...options, seed: 'p' });
    await output.play(pattern, { when: 0 }).ready;
    const play = nodes[0].port.ofType('play')[0].message;

    let now = 0;
    const clock = () => (now += 0.01); // a clock that says every call took 10 microseconds
    const { Processor, context: scopeContext, sandbox } = workletScope({ clock });
    sandbox.sampleRate = sampleRate;
    const module = vm.runInContext('WebAssembly', scopeContext) as typeof WebAssembly;
    const processor = new Processor({
      processorOptions: {
        module: new module.Module(wasmBytes),
        options: { sampleRate, channels: 2, seed: 'p' }
      }
    });
    const send = (message: unknown) => processor.port.onmessage?.({ data: message });
    send({
      ...play,
      numbers: inRealm(scopeContext, play.numbers as Float64Array),
      strings: play.strings,
      frame: 40
    });
    const blocks = 140;
    const heard = [new Float32Array(blocks * 128), new Float32Array(blocks * 128)];
    const out = [
      inRealm(scopeContext, new Float32Array(128)),
      inRealm(scopeContext, new Float32Array(128))
    ];
    for (let block = 0; block < blocks; block += 1) {
      sandbox.currentFrame = 40 + block * 128;
      expect(processor.process([], [out])).toBe(true);
      heard[0].set(out[0], block * 128);
      heard[1].set(out[1], block * 128);
    }
    // The first block anchored the clocks at frame 40; the pass was posted for frame 40, so it starts with the engine.
    const expected = [rendered.getChannelData(0), rendered.getChannelData(1)];
    expect(expected[0].length).toBeLessThanOrEqual(heard[0].length);
    let worst = 0;
    for (let channel = 0; channel < 2; channel += 1) {
      for (let i = 0; i < expected[channel].length; i += 1) {
        worst = Math.max(worst, Math.abs(heard[channel][i] - expected[channel][i]));
      }
    }
    expect(heard[0].some((sample) => Math.abs(sample) > 0.01)).toBe(true);
    expect(worst).toBeLessThan(1e-6);

    send({ type: 'stats', id: 7 });
    const stats = processor.port.posted.find((message) => message.type === 'stats') as Record<
      string,
      unknown
    >;
    expect(stats).toMatchObject({
      id: 7,
      timing: 'performance.now',
      blocks,
      overruns: 0,
      skippedBlocks: 0,
      driftFrames: 0,
      lateStarts: 0,
      queues: 0,
      errors: []
    });
    expect(stats.engineFrame).toBe(blocks * 128);
    expect((stats.processMs as Record<string, number>).count).toBe(blocks);
    expect((stats.processMs as Record<string, number>).p99).toBeGreaterThan(0);
    expect(stats.budgetMs as number).toBeCloseTo(16, 5);
    send({ type: 'close' });
    expect(processor.process([], [out])).toBe(false);
  });

  it('counts a block the host skipped as drift, books later passes for the host clock, and reports a late pass', async () => {
    const { Processor, context: scopeContext, sandbox, posted } = workletScope({ clock: () => 0 });
    const module = vm.runInContext('WebAssembly', scopeContext) as typeof WebAssembly;
    const processor = new Processor({
      processorOptions: {
        module: new module.Module(wasmBytes),
        options: { sampleRate: 48000, channels: 2 }
      }
    });
    const out = [
      inRealm(scopeContext, new Float32Array(128)),
      inRealm(scopeContext, new Float32Array(128))
    ];
    sandbox.currentFrame = 1000;
    processor.process([], [out]);
    sandbox.currentFrame = 1128;
    processor.process([], [out]);
    sandbox.currentFrame = 1128 + 3 * 128; // two blocks never came
    processor.process([], [out]);
    processor.port.onmessage?.({ data: { type: 'stats', id: 1 } });
    expect(posted.find((message) => message.type === 'stats')).toMatchObject({
      skippedBlocks: 2,
      driftFrames: 256,
      maxDriftFrames: 256,
      blocks: 3
    });
    // A pass whose start frame has gone by is late, and the stats say by how much (in engine frames).
    processor.port.onmessage?.({
      data: {
        type: 'play',
        token: 1,
        numbers: inRealm(scopeContext, new Float64Array([0])),
        strings: [],
        frame: 100
      }
    });
    expect(posted.find((message) => message.type === 'queued')).toMatchObject({
      token: 1,
      late: true
    });
    // An empty pass is accepted; a malformed one is an error message, and the sound goes on.
    processor.port.onmessage?.({
      data: {
        type: 'play',
        token: 2,
        numbers: inRealm(scopeContext, new Float64Array([1, 0, 9])),
        strings: [],
        frame: 5000
      }
    });
    expect(posted.find((message) => message.type === 'error')?.message).toMatch(
      /flat voice encoding/
    );
    expect(processor.process([], [out])).toBe(true);
  });

  it('holds a pass that arrives before the first block, and drops it when it is cancelled first', () => {
    const { Processor, context: scopeContext, sandbox, posted } = workletScope();
    const module = vm.runInContext('WebAssembly', scopeContext) as typeof WebAssembly;
    const processor = new Processor({
      processorOptions: {
        module: new module.Module(wasmBytes),
        options: { sampleRate: 48000, channels: 2 }
      }
    });
    expect(posted[0]).toMatchObject({ type: 'ready', timing: 'none', channels: 2 });
    const pass = (token: number) => ({
      type: 'play',
      token,
      numbers: inRealm(scopeContext, new Float64Array([0])),
      strings: [],
      frame: 100000
    });
    processor.port.onmessage?.({ data: pass(1) });
    processor.port.onmessage?.({ data: pass(2) });
    processor.port.onmessage?.({ data: { type: 'cancel', token: 1 } });
    expect(posted.filter((message) => message.type === 'queued')).toHaveLength(0);
    const out = [
      inRealm(scopeContext, new Float32Array(128)),
      inRealm(scopeContext, new Float32Array(128))
    ];
    sandbox.currentFrame = 5000;
    processor.process([], [out]);
    expect(
      posted.filter((message) => message.type === 'queued').map((message) => message.token)
    ).toEqual([2]);
    // No clock in the scope: the statistics say so and report no times.
    processor.port.onmessage?.({ data: { type: 'stats', id: 3 } });
    expect(posted.find((message) => message.type === 'stats')).toMatchObject({
      timing: 'none',
      processMs: null,
      queueMs: null,
      queues: 0
    });
    processor.port.onmessage?.({ data: { type: 'nonsense' } });
    expect(posted.find((message) => message.type === 'error')?.message).toBe(
      'unknown message type nonsense'
    );
  });
});
