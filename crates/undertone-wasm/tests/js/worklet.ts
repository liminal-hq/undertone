// The render module's WorkletEngine against its own offline render: the same voices, streamed in blocks, sample for sample
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, with Bun:
//   bun crates/undertone-wasm/tests/js/worklet.ts
// The main module collects a pattern's voices (`collectVoices`), as `renderToBuffer` does; the render module renders them offline
// (`renderVoices`) and streams them through `WorkletEngine` (`book`, `queue`, `renderBlock`), the engine an AudioWorklet runs
// (RF-29, D-47, D-48). `book` must give the offline render's own samples, bit for bit; `queue` books as voices end, which can sum a
// mix in another order, so it is held to a few ulps. Registered samples, the refusals, and the module's clock are checked too.

import assert from 'node:assert/strict';
import { lib, wasm } from './harness.ts';
import { render } from './render.ts';

type Voices = { encoded(): [Float64Array, string[]]; options: object; free(): void };
type Engine = {
  book(numbers: Float64Array, strings: string[], startFrame: number): number;
  queue(
    numbers: Float64Array,
    strings: string[],
    startFrame: number,
    periodFrames?: number
  ): number;
  cancel(id: number): boolean;
  renderBlock(out: Float32Array[]): string | undefined;
  readonly frame: number;
  readonly liveNodes: number;
  readonly queueCount: number;
  free(): void;
};
const WorkletEngine = (render as unknown as { WorkletEngine: new (options: object) => Engine })
  .WorkletEngine;

let checks = 0;
function check(name: string, run: () => void): void {
  run();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

const OPTIONS = { sampleRate: 8000, cycles: 2, tail: 0.5, seed: 'worklet' };

function collect(source: unknown, options: object = OPTIONS) {
  const voices = wasm.collectVoices(
    (source as { handle: unknown }).handle as never,
    options
  ) as unknown as Voices;
  const [numbers, strings] = voices.encoded();
  const settings = voices.options;
  voices.free();
  return { numbers, strings, settings };
}

function offline(collected: ReturnType<typeof collect>): Float32Array[] {
  const out = render.renderVoices(collected.numbers, collected.strings, collected.settings) as {
    channels: Float32Array[];
  };
  return out.channels;
}

/** `frames` frames from the engine in blocks of `block`, one array per channel. */
function stream(engine: Engine, channels: number, frames: number, block = 128): Float32Array[] {
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const scratch = Array.from({ length: channels }, () => new Float32Array(block));
  for (let at = 0; at < frames; at += block) {
    const take = Math.min(block, frames - at);
    const views = scratch.map((channel) => channel.subarray(0, take));
    assert.equal(engine.renderBlock(views), undefined);
    views.forEach((view, c) => out[c].set(view, at));
  }
  return out;
}

function worst(a: Float32Array[], b: Float32Array[]): number {
  assert.equal(a.length, b.length);
  let most = 0;
  a.forEach((channel, c) => {
    assert.equal(channel.length, b[c].length);
    for (let i = 0; i < channel.length; i += 1)
      most = Math.max(most, Math.abs(channel[i] - b[c][i]));
  });
  return most;
}

const song = lib
  .stack(
    lib.sound('white*4'),
    lib.note('c3 g3').sound('sawtooth'),
    lib.note('c4 e4 g4').sound('triangle')
  )
  .decay(0.05)
  .room(0.4)
  .delay(0.3);

check('streaming blocks of 128 equal the offline render, bit for bit', () => {
  for (const channels of [2, 6]) {
    const options = { ...OPTIONS, channels };
    const collected = collect(song, options);
    const expected = offline(collected);
    assert.ok(expected[0].some((s) => Math.abs(s) > 0.01));
    const engine = new WorkletEngine(options);
    assert.ok(engine.book(collected.numbers, collected.strings, 0) > 0);
    const got = stream(engine, channels, expected[0].length);
    assert.equal(worst(got, expected), 0, `${channels} channels`);
    assert.equal(engine.frame, expected[0].length);
    engine.free();
  }
});

check(
  'book at a later frame starts there, and a queue is the offline render to within a few ulps',
  () => {
    const collected = collect(song);
    const expected = offline(collected);
    const length = expected[0].length;
    const later = new WorkletEngine(OPTIONS);
    later.book(collected.numbers, collected.strings, 1000);
    const got = stream(later, 2, length + 1000);
    // Not the unshifted render: 1,000 frames is not a multiple of the 128-frame quantum the master bus works in (crates/
    // undertone-wasm-render/src/stream.rs holds the shifted-voices equality). Silent until it starts, then the same sound.
    assert.ok(got[0].subarray(0, 1000).every((s) => Math.abs(s) < 1e-9));
    const rms = (channel: Float32Array) =>
      Math.sqrt(channel.reduce((sum, s) => sum + s * s, 0) / channel.length);
    const ratio = rms(got[0].subarray(1000)) / rms(expected[0]);
    assert.ok(ratio > 0.97 && ratio < 1.03, `the loudness is the render's (${ratio})`);
    later.free();

    const queued = new WorkletEngine(OPTIONS);
    const id = queued.queue(collected.numbers, collected.strings, 0);
    assert.equal(queued.queueCount, 1);
    const heard = stream(queued, 2, length);
    assert.ok(worst(heard, expected) < 1e-6, 'a queue is the offline render to within a few ulps');
    assert.equal(queued.queueCount, 0);
    assert.equal(queued.cancel(id), false);
    queued.free();
  }
);

check('a queued loop repeats every period until it is cancelled', () => {
  const tune = lib.note('c4 e4 g4').sound('triangle').release(0.1);
  const collected = collect(tune, { sampleRate: 8000, cycles: 1, master: false });
  const period = 16001;
  const engine = new WorkletEngine({ sampleRate: 8000, master: false });
  const id = engine.queue(collected.numbers, collected.strings, 0, period);
  const loud = (channel: Float32Array, from: number) =>
    channel.subarray(from, from + 4000).some((s) => Math.abs(s) > 0.01);
  const heard = stream(engine, 2, period * 3);
  assert.ok(loud(heard[0], 0) && loud(heard[0], period) && loud(heard[0], 2 * period));
  assert.equal(engine.queueCount, 1);
  assert.equal(engine.cancel(id), true);
  assert.equal(engine.queueCount, 0);
  const after = stream(engine, 2, 16000);
  assert.ok(
    after[0].subarray(8000).every((s) => s === 0),
    'what was booked rings out, then silence'
  );
  assert.throws(
    () => engine.queue(collected.numbers, collected.strings, 0, 100),
    /period must be longer/
  );
  engine.free();
});

check(
  'a sample voice plays from the registry of the render module, and is skipped without it',
  () => {
    const pcm = {
      sampleRate: 8000,
      channels: [new Float32Array(2000).map((_, i) => Math.sin(i / 20))]
    };
    const collected = collect(lib.s('kick'), { sampleRate: 8000, cycles: 1, master: false });
    const silent = new WorkletEngine({ sampleRate: 8000, master: false });
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => void warnings.push(message);
    try {
      silent.book(collected.numbers, collected.strings, 0);
      assert.ok(stream(silent, 2, 1024)[0].every((s) => s === 0));
      assert.ok(
        warnings.some((message) => message.includes('kick')),
        warnings.join('|')
      );
    } finally {
      console.warn = warn;
    }
    render.registerSample('kick', pcm);
    const engine = new WorkletEngine({ sampleRate: 8000, master: false });
    engine.book(collected.numbers, collected.strings, 0);
    assert.ok(stream(engine, 2, 1024)[0].some((s) => Math.abs(s) > 0.01));
    render.clearSamples();
    silent.free();
    engine.free();
  }
);

check('the refusals: options, channels, voices, and the clock', () => {
  assert.throws(() => new WorkletEngine({ channels: 3 }), /channels must be 1, 2, 4, 6 or 8/);
  assert.throws(() => new WorkletEngine({ sampleRate: -1 }), /sampleRate must be positive/);
  const engine = new WorkletEngine({ sampleRate: 8000 });
  assert.throws(
    () => engine.book(new Float64Array([1, 0, 9]), [], 0),
    /not in the flat voice encoding/
  );
  assert.throws(() => engine.book(new Float64Array([0]), 'x' as never, 0), /must be an array/);
  assert.throws(() => engine.renderBlock([new Float32Array(128)]), /needs 2 channels, got 1/);
  assert.throws(
    () => engine.renderBlock([new Float32Array(128), new Float32Array(64)]),
    /one length/
  );
  assert.throws(() => engine.renderBlock([new Float32Array(128), [] as never]), /Float32Arrays/);
  assert.equal(engine.frame, 0);
  stream(engine, 2, 300);
  assert.equal(engine.frame, 300);
  assert.equal(engine.liveNodes > 0, true);
  engine.free();
});

console.log(`worklet: ${checks} checks passed`);
