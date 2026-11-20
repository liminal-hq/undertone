// The booking, scheduler, sample, and render exports against the TypeScript reference on the fake context, and their bounds
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, with Bun:
//   bun crates/undertone-wasm/tests/js/booking.ts
// Each check books the same thing twice, once through the reference (src/, on a FakeAudioContext) and once through the modules
// (replayed on another FakeAudioContext with replay.ts), and requires the two recorded graphs (conformance/recorder/graph.ts) to be
// the same JSON, or checks an export's own contract. Together with layer3.ts, layer4.ts, and wav.ts it reaches every export of the
// booking, the scheduler, the sample registry, and the render module. The last checks run a long loop and many one-shots and hold
// the engine's voices, the replayer's tables, and the instances' memory to fixed bounds.

import assert from 'node:assert/strict';
import { FakeAudioContext } from '../../../../src/test-utils/fakeAudioContext.ts';
import { describeGraph, track } from '../../../../conformance/recorder/graph';
import { loadReference } from '../../../../conformance/recorder/reference';
import { Fraction, Pattern, lib, wasm } from './harness.ts';
import { render } from './render.ts';
import { Replayer } from './replay.ts';
import type { GraphNames } from './replay.ts';

const ref = await loadReference();
const names = wasm.graphNames() as GraphNames;
let checks = 0;

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

/** A fake context for the reference, recorded, seeded as the engine is. */
function referenceContext() {
  const ctx = new FakeAudioContext();
  const created = track(ctx);
  ref.random.seedContext(ctx as never, 0);
  return { ctx, graph: () => JSON.stringify(describeGraph(ctx, created, null)) };
}

/** A fake context for the modules, its engine, its transport, and a replay after every call. */
function moduleContext() {
  const ctx = new FakeAudioContext();
  const created = track(ctx);
  const engine = new wasm.WasmEngine(ctx.sampleRate, 2, 2);
  const transport = new wasm.WasmTransport(ctx.sampleRate, {});
  const replayer = new Replayer(ctx as never, names);
  const run = <T>(call: () => T): T => {
    try {
      return call();
    } finally {
      replayer.replay(engine.take());
    }
  };
  return {
    ctx,
    engine,
    transport,
    replayer,
    run,
    graph: () => JSON.stringify(describeGraph(ctx, created, null)),
    free: () => {
      transport.free();
      engine.free();
    }
  };
}

/** A timer the reference's loop() takes, ticked by hand. */
function manualTimer() {
  const callbacks: (() => void)[] = [];
  return {
    timer: {
      setInterval: (callback: () => void) => callbacks.push(callback),
      clearInterval: (handle: unknown) => {
        callbacks[(handle as number) - 1] = () => undefined;
      }
    },
    tick: () => callbacks.forEach((callback) => callback())
  };
}

const notes = (source: string) => lib.note(source) as unknown as Pattern & { handle: unknown };

await check(
  'play(): one cycle at a tempo, its handle, and a stop, as the reference books them',
  () => {
    const a = referenceContext();
    a.ctx.currentTime = 0.5;
    const pattern = ref.lib.note('c3 e3 g3').decay(0.2).sustain(0.5);
    const handle = pattern.play({ ctx: a.ctx as never, bpm: 240 });
    handle.stop(0.7, { fade: 0.02 });
    const b = moduleContext();
    b.ctx.currentTime = 0.5;
    const mine = lib.note('c3 e3 g3') as unknown as Pattern;
    const shaped = (mine as never as { decay(x: number): Pattern }).decay(0.2) as never as {
      sustain(x: number): Pattern;
    };
    const played = b.run(() =>
      b.transport.play(b.engine, shaped.sustain(0.5).handle, 0.5, { bpm: 240 })
    );
    assert.equal(played.startTime, handle.startTime);
    assert.equal(played.endTime, handle.endTime);
    assert.equal(played.voices, 3);
    b.run(() => played.stop(b.engine, 0.7, 0.02));
    assert.equal(b.graph(), a.graph());
    played.free();
    b.free();
  }
);

await check(
  'loop(): ticks, a tempo change that the loop follows (D-33), and a cut stop, as the reference books them',
  () => {
    const a = referenceContext();
    const timer = manualTimer();
    const pattern = ref.lib.note('c3 e3 g3 b3');
    const looping = pattern.loop({ ctx: a.ctx as never, timer: timer.timer as never });
    const b = moduleContext();
    const handle = b.run(() => b.transport.loop(b.engine, lib.note('c3 e3 g3 b3').handle, 0, {}));
    assert.equal(b.transport.tickInterval, 0.1);
    for (let step = 1; step <= 40; step += 1) {
      const now = step * 0.1;
      if (step === 15) {
        ref.lib.setcpm(45);
        b.transport.setcpm(45);
      }
      a.ctx.currentTime = now;
      timer.tick();
      b.ctx.currentTime = now;
      b.run(() => b.transport.tick(b.engine, now));
    }
    assert.equal(b.transport.loopCount, 1);
    assert.ok(b.transport.isRunning(handle));
    assert.match(b.transport.scheduledUntil(handle) as string, /^\d+\/\d+$/);
    looping.stop({ voices: 'cut', fade: 0.02 });
    b.run(() => b.transport.stopLoop(b.engine, handle, 4, { voices: 'cut', fade: 0.02 }));
    assert.ok(!b.transport.isRunning(handle));
    ref.lib.resetTempo();
    b.transport.resetTempo();
    assert.equal(b.graph(), a.graph());
    const stats = b.transport.stats() as Record<string, number>;
    assert.equal(stats.ticks, 40);
    assert.ok(stats.voicesBooked > 10);
    b.transport.recordUnderrun();
    assert.equal((b.transport.stats() as Record<string, number>).underruns, stats.underruns + 1);
    b.transport.resetStats();
    assert.equal((b.transport.stats() as Record<string, number>).ticks, 0);
    assert.equal(b.transport.now, 4);
    handle.free();
    b.free();
  }
);

await check(
  'seek() moves a running loop; a play that fails rolls back what it booked (D-38)',
  () => {
    const b = moduleContext();
    const handle = b.run(() =>
      b.transport.loop(b.engine, lib.note('c3 e3 g3 b3').handle, 0, { bpm: 240 })
    );
    assert.equal(
      b.run(() => b.transport.seek(b.engine, handle, 0, 1, 2, 1)),
      true
    );
    assert.equal(b.transport.scheduledUntil(handle), '1/2');
    b.run(() => b.transport.stopLoop(b.engine, handle, 0, {}));
    assert.equal(
      b.run(() => b.transport.seek(b.engine, handle, 0, 0, 1, undefined)),
      false
    );
    // The second voice's room cannot be made (an infinite size): the call throws, and the first voice is cut (5 ms) at once.
    const half = (n: number) => ({ begin: new Fraction(n, 2), end: new Fraction(n + 1, 2) });
    const broken = new Pattern(() => [
      { whole: half(0), part: half(0), value: { note: 'c3' } },
      { whole: half(1), part: half(1), value: { note: 'e3', roomLevel: 0.5, roomSize: Infinity } }
    ]);
    assert.throws(() => b.run(() => b.transport.play(b.engine, broken.handle, 1, {})), /room/);
    assert.ok(b.graph().includes('cancel @1'), 'the booked voice is cut');
    handle.free();
    b.free();
  }
);

await check('a score plays and loops at its own tempo, as the reference books it', () => {
  const definition = {
    ticksPerSecond: 8,
    lengthTicks: 8,
    events: [
      { tick: 0, note: 'c4', gate: 2 },
      { tick: 4, midi: 64, level: 0.5, pan: -0.5 }
    ]
  };
  const a = referenceContext();
  const timer = manualTimer();
  const cue = ref.lib.score(definition as never);
  cue.play({ ctx: a.ctx as never });
  const looping = cue.loop({ ctx: a.ctx as never, timer: timer.timer as never });
  const b = moduleContext();
  const mine = wasm.score(definition);
  b.run(() => mine.play(b.transport, b.engine, 0, {}).free());
  const handle = b.run(() => mine.loop(b.transport, b.engine, 0, {}));
  for (let step = 1; step <= 25; step += 1) {
    a.ctx.currentTime = step * 0.1;
    timer.tick();
    b.run(() => b.transport.tick(b.engine, step * 0.1));
  }
  looping.stop();
  b.run(() => b.transport.stopLoop(b.engine, handle, 2.5, {}));
  assert.equal(b.graph(), a.graph());
  handle.free();
  mine.free();
  b.free();
});

await check(
  'playParams, the orbit bus, and a host node adopted as the output, as the reference books them',
  () => {
    const voices = [
      { pitch: 'a3', soundType: 'sawtooth', roomLevel: 0.3, delayLevel: 0.2, orbit: 1 },
      { pitch: 'e4', nudgeTime: 0.05, cutGroup: 1 },
      { pitch: 'c4', cutGroup: 1 }
    ];
    const a = referenceContext();
    const own = a.ctx.createGain();
    ref.lib.playParams(a.ctx as never, voices, { when: 0.25 });
    ref.lib.playParams(a.ctx as never, [{ pitch: 'g3' }], { output: own as never });
    const bus = ref.lib.getOrbitBus(a.ctx as never, 2);
    bus.setRoomSize(5);
    bus.setDelay(0.2, 0.4, 0.5);
    const b = moduleContext();
    const mine = b.ctx.createGain();
    const id = b.engine.adopt();
    b.replayer.adopt(id, mine);
    const handle = b.run(() => b.engine.playParams(voices, 0.25, undefined));
    assert.equal(handle.voices, 3);
    b.run(() => b.engine.playParams([{ pitch: 'g3' }], undefined, id).free());
    const [reverbInput, delayInput] = b.run(() => b.engine.getOrbitBus(2, undefined));
    assert.ok(reverbInput > 0 && delayInput > reverbInput);
    b.run(() => b.engine.setRoomSize(2, undefined, 5));
    b.run(() => b.engine.setDelay(2, undefined, 0.2, 0.4, 0.5));
    assert.equal(b.graph(), a.graph());
    assert.equal(b.engine.voiceCount, 4);
    handle.free();
    b.free();
  }
);

await check(
  'createMasterBus, enableMultichannel, createMonoFold, and the destination channels, as the reference books them',
  () => {
    const a = referenceContext();
    a.ctx.destination.maxChannelCount = 6;
    ref.lib.enableMultichannel(a.ctx as never);
    const bus = ref.lib.createMasterBus(a.ctx as never, {
      gain: 0.8,
      ceiling: -1,
      limiter: { ratio: 8 }
    });
    const fold = ref.lib.createMonoFold(a.ctx as never, bus.input as never);
    ref.lib.playParams(a.ctx as never, [{ pitch: 'c4', channelGains: [0, 0, 1, 0, 0, 0] }], {
      output: fold as never
    });
    const b = moduleContext();
    b.engine.free();
    b.ctx.destination.maxChannelCount = 6;
    const engine = new wasm.WasmEngine(b.ctx.sampleRate, 2, 6);
    const replayer = new Replayer(b.ctx as never, names);
    const run = <T>(call: () => T): T => {
      try {
        return call();
      } finally {
        replayer.replay(engine.take());
      }
    };
    assert.equal(
      run(() => engine.enableMultichannel()),
      6
    );
    const mine = run(() =>
      engine.createMasterBus({ gain: 0.8, ceiling: -1, limiter: { ratio: 8 } })
    ) as {
      input: number;
      compressor?: number;
      clipper?: number;
    };
    assert.equal(mine.compressor, undefined, 'a surround output skips the limiter');
    const folded = run(() => engine.createMonoFold(mine.input));
    run(() =>
      engine
        .playParams([{ pitch: 'c4', channelGains: [0, 0, 1, 0, 0, 0] }], undefined, folded)
        .free()
    );
    engine.setDestinationChannels(6);
    assert.equal(b.graph(), a.graph());
    engine.free();
    b.transport.free();
  }
);

await check(
  'buildImpulseResponse with a seed gives the reference seededRandom source its samples',
  () => {
    const a = referenceContext();
    const ir = ref.lib.buildImpulseResponse(a.ctx as never, 0.01, ref.lib.seededRandom(7));
    const b = moduleContext();
    const id = b.run(() => b.engine.buildImpulseResponse(0.01, 7));
    const source = b.ctx.createBufferSource();
    const node = b.engine.adopt();
    b.replayer.adopt(node, source);
    // Hand the buffer to a node so the graph names it: a voice's buffer source, set by a record of its own.
    b.replayer.replay([new Float64Array([9, node, id, 0, 0, 0]), new Float32Array()]);
    const data = (source.buffer as { getChannelData(c: number): Float32Array }).getChannelData(1);
    assert.deepEqual(Array.from(data), Array.from(ir.getChannelData(1)));
    b.free();
  }
);

await check(
  'the sample registry: register, pending, load, base notes, banks, skipping, and clearing',
  () => {
    const pcm = { sampleRate: 8000, channels: [new Float32Array([0.5, -0.5, 0.25])] };
    wasm.registerSamples(
      ['bd', 'kit_sd'],
      [
        { ...pcm, baseNote: 'a3' },
        { ...pcm, baseNote: 220 }
      ]
    );
    assert.equal(wasm.getSampleBaseNote('bd'), 'a3');
    assert.equal(wasm.getSampleBaseNote('sd', 'kit'), 220);
    assert.equal(wasm.resolveRegisteredKey('sd', 'kit'), 'kit_sd');
    assert.equal(wasm.resolveRegisteredKey('nope'), undefined);
    wasm.registerPendingSample('later', 'c3');
    assert.ok(wasm.isSampleRegistered('later'));
    const b = moduleContext();
    assert.equal(b.engine.isVoiceSkipped({ sampleName: 'later' }), true);
    wasm.loadSample('later', pcm);
    assert.equal(b.engine.isVoiceSkipped({ sampleName: 'later' }), false);
    assert.throws(() => wasm.loadSample('ghost', pcm), /Sample "ghost" is not registered/);
    assert.throws(
      () => wasm.registerSample('bad', { sampleRate: 8000, channels: [] }),
      /no channels/
    );
    wasm.clearSamples();
    assert.ok(!wasm.isSampleRegistered('bd'));
    b.free();
  }
);

await check(
  'the render module: its version, a score rendered from collected voices, and a voice list it refuses',
  () => {
    assert.equal(render.undertoneVersion(), wasm.undertoneVersion());
    const cue = wasm.score({
      ticksPerSecond: 4,
      lengthTicks: 4,
      events: [{ tick: 0, note: 'a4' }]
    });
    const voices = cue.collectVoices({ sampleRate: 8000, tail: 0.5, master: false });
    assert.equal(voices.length, 1);
    const [numbers, strings] = voices.encoded();
    const out = render.renderVoices(numbers, strings, voices.options) as {
      sampleRate: number;
      channels: Float32Array[];
    };
    assert.equal(out.sampleRate, 8000);
    assert.equal(out.channels.length, 2);
    assert.equal(out.channels[0].length, 12000);
    assert.ok(out.channels[0].some((s) => s !== 0));
    assert.throws(
      () => render.renderVoices(new Float64Array([1, 0, 9]), [], {}),
      /not in the flat voice encoding/
    );
    assert.throws(() => cue.collectVoices({ bpm: 120 }), /Pass either bpm or cps, not both/);
    voices.free();
    cue.free();
  }
);

await check(
  'a long loop keeps the engine, the replayer, and the memory bounded (10 minutes of ticks)',
  () => {
    const b = moduleContext();
    const handle = b.run(() =>
      b.transport.loop(b.engine, lib.sound('sine [white pink] sawtooth triangle').handle, 0, {
        bpm: 480
      })
    );
    let most = 0;
    let held = 0;
    const memory = wasm.memoryBytes();
    for (let step = 1; step <= 6000; step += 1) {
      b.ctx.currentTime = step * 0.1;
      b.run(() => b.transport.tick(b.engine, step * 0.1));
      most = Math.max(most, b.engine.voiceCount);
      held = Math.max(held, b.replayer.held);
    }
    const stats = b.transport.stats() as Record<string, number>;
    assert.ok(stats.voicesBooked >= 6000, `${stats.voicesBooked} voices booked`);
    assert.ok(most < 40, `the engine kept ${most} voices at once`);
    assert.ok(held < 400, `the replayer held ${held} nodes and buffers at once`);
    assert.ok(
      wasm.memoryBytes() - memory < 8 * 1024 * 1024,
      'the instance memory stayed within 8 MiB of growth'
    );
    handle.free();
    b.free();
  }
);

await check('many one-shots on one engine keep it bounded too', () => {
  const b = moduleContext();
  for (let i = 0; i < 5000; i += 1) {
    const now = i * 0.05;
    b.engine.setTime(now);
    b.run(() =>
      b.engine.playVoice({ pitch: 'c4', duration: 0.01, release: 0.01 }, now, undefined).free()
    );
  }
  assert.ok(b.engine.voiceCount < 10);
  assert.ok(b.replayer.held < 60, `${b.replayer.held} held`);
  b.free();
});

console.log(`# ${checks} checks passed`);
