// Layer 3 of the corpus through the WebAssembly modules: booked graphs replayed on the fake context and compared
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, with Bun:
//   bun crates/undertone-wasm/tests/js/layer3.ts [group ...]
// Every case of conformance/cases/3 is booked through the modules and replayed (replay.ts) on the repository's fake context
// (src/test-utils/fakeAudioContext.ts), whose graph the recorder's own `track` and `describeGraph` (conformance/recorder/graph.ts)
// describe, then compared with the corpus under the Rust layer 3 runner's comparator (crates/undertone/tests/corpus/layer3.rs):
// exact, except the absolute 1e-15 floor on wave coefficients and on the value of a gain automation call.
//   - voices cases: the main module's WasmEngine (`playVoice` per score line, with the case's output set-up and registry);
//   - render cases: the program built through the harness, its voices collected by the main module (`collectVoices`), and booked
//     by the render module's ContextRender on a fake offline context, window by window (renderToBuffer with `context`);
//   - score cases: the same from `score(definition).collectVoices(render)`;
//   - the cases the corpus records only as a message: the same inputs as the Rust runner's `book_message_only`.
// It prints the counts per group and the cases that needed the floor; any failure exits non-zero.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FakeAudioContext,
  FakeOfflineAudioContext
} from '../../../../src/test-utils/fakeAudioContext.ts';
import { describeGraph, track } from '../../../../conformance/recorder/graph';
import { build } from '../../../../conformance/recorder/programs';
import { messageOf } from '../../../../conformance/recorder/format';
import type { Json } from '../../../../conformance/recorder/format';
import type { Reference } from '../../../../conformance/recorder/reference';
import { compare, decodeJson } from './graphCompare.ts';
import { lib, scheduler, wasm, Pattern } from './harness.ts';
import { render } from './render.ts';
import { Replayer } from './replay.ts';
import type { GraphNames } from './replay.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const wasmRef = { root, lib, scheduler } as unknown as Reference;
const names = wasm.graphNames() as GraphNames;
/** `UNDERTONE_NEGATIVE_CONTROL=1` moves every booked `setValueAtTime` value, so nearly every case must fail. */
const PERTURB = process.env.UNDERTONE_NEGATIVE_CONTROL === '1';

type Case = Record<string, Json> & { id: string };

/** One score line, `v<k> @<seconds> <patch json>`. */
function parseLine(line: string): { at: number; patch: unknown } {
  const rest = line.slice(line.indexOf(' @') + 2);
  const space = rest.indexOf(' ');
  return { at: Number(rest.slice(0, space)), patch: decodeJson(JSON.parse(rest.slice(space + 1))) };
}

interface Sample {
  name: string;
  sampleRate: number;
  channels: number[][];
  baseNote?: string | number;
  before?: number;
}

function pcm(sample: Sample) {
  return {
    sampleRate: sample.sampleRate,
    channels: sample.channels.map((channel) => Float32Array.from(channel)),
    ...(sample.baseNote === undefined ? {} : { baseNote: sample.baseNote })
  };
}

type Booked = { graph: Json } | { error: string };

function attempt(run: () => Json): Booked {
  try {
    return { graph: run() };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** A voices case on a realtime fake context through the main module's engine. */
function bookVoices(spec: Case): Booked {
  const output = (spec.output ?? {}) as Record<string, Json>;
  const ctx = new FakeAudioContext();
  const created = track(ctx);
  const channels = output.channels as number | undefined;
  if (channels !== undefined && channels !== 2) ctx.destination.channelCount = channels;
  const max = (output.maxChannels as number | undefined) ?? channels;
  if (max !== undefined && max !== 2) ctx.destination.maxChannelCount = max;
  const engine = new wasm.WasmEngine(
    ctx.sampleRate,
    ctx.destination.channelCount,
    ctx.destination.maxChannelCount
  );
  const replayer = new Replayer(ctx as never, names, PERTURB);
  const run = <T>(call: () => T): T => {
    try {
      return call();
    } finally {
      replayer.replay(engine.take());
    }
  };
  try {
    return attempt(() => {
      engine.seed(0);
      if (
        (output.multichannel as boolean | undefined) ??
        (channels !== undefined && channels > 2)
      ) {
        run(() => engine.enableMultichannel());
      }
      let into: number | undefined;
      const master = output.master;
      if (master !== undefined && master !== false && master !== null) {
        const bus = run(() =>
          engine.createMasterBus(master === true ? {} : decodeJson(master))
        ) as {
          input: number;
        };
        into = bus.input;
      }
      if (output.monoFold === true) into = run(() => engine.createMonoFold(into));
      const registry = (decodeJson(spec.registry ?? []) as Sample[]) ?? [];
      const clearBefore = (spec.clearBefore ?? []) as number[];
      ((spec.score ?? []) as string[]).map(parseLine).forEach((voice, index) => {
        if (clearBefore.includes(index)) wasm.clearSamples();
        for (const sample of registry) {
          if ((sample.before ?? 0) === index) wasm.registerSample(sample.name, pcm(sample));
        }
        engine.setTime(ctx.currentTime);
        run(() => engine.playVoice(voice.patch, voice.at, into).free());
      });
      return describeGraph(ctx, created, null);
    });
  } finally {
    engine.free();
  }
}

/** Voices the main module collected, booked by the render module on a fake offline context, window by window. */
function bookOnContext(
  voices: { encoded(): [Float64Array, string[]]; options: unknown; free(): void },
  registry: Sample[]
): Json {
  for (const sample of registry) render.registerSample(sample.name, pcm(sample));
  const [numbers, strings] = voices.encoded();
  const booking = new render.ContextRender(numbers, strings, voices.options);
  voices.free();
  try {
    const ctx = new FakeOfflineAudioContext({
      numberOfChannels: booking.channels,
      length: booking.length,
      sampleRate: booking.sampleRate
    });
    const created = track(ctx);
    const replayer = new Replayer(ctx as never, names, PERTURB);
    replayer.replay(booking.take());
    for (const pause of booking.pauses()) {
      // What `ctx.suspend(pause)` resolving does to the fake offline context: its clock is at the pause.
      ctx.currentTime = pause;
      try {
        booking.bookWindow(pause);
      } finally {
        replayer.replay(booking.take());
      }
    }
    return describeGraph(ctx, created, ctx.length);
  } finally {
    booking.free();
  }
}

function bookRender(spec: Case): Booked {
  const built = build(wasmRef, spec.program as never);
  if ('error' in built) return { error: built.error };
  const pattern = built.pattern as unknown as Pattern;
  return attempt(() =>
    bookOnContext(
      wasm.collectVoices(pattern.handle, decodeJson(spec.render)),
      (decodeJson(spec.registry ?? []) as Sample[]) ?? []
    )
  );
}

function bookScore(spec: Case): Booked {
  return attempt(() => {
    const cue = wasm.score(decodeJson(spec.definition));
    try {
      if (spec.cps !== undefined && (cue.cps !== spec.cps || cue.seconds !== spec.seconds)) {
        throw new Error(`the score has cps ${cue.cps} and seconds ${cue.seconds}`);
      }
      return bookOnContext(cue.collectVoices(decodeJson(spec.render)), []);
    } finally {
      cue.free();
    }
  });
}

/** The inputs of the cases the corpus records only as a message (the Rust runner's `book_message_only`). */
function bookMessageOnly(id: string): Booked {
  const engine = new wasm.WasmEngine(44100, 2, 2);
  const note = lib.note('a4') as unknown as Pattern;
  try {
    return attempt(() => {
      switch (id) {
        case 'options-ceiling-above-full-scale':
          engine.createMasterBus({ ceiling: 3 });
          break;
        case 'options-ceiling-not-a-level':
          engine.createMasterBus({ ceiling: Number.NaN });
          break;
        case 'options-window-not-positive':
          wasm.collectVoices(note.handle, { cps: 1, bookingWindow: 0 });
          break;
        case 'options-window-too-short':
          wasm.collectVoices(note.handle, { cps: 1, bookingWindow: 0.05, sampleRate: 1280 });
          break;
        case 'instruments-fmvoice-error-harmonicity':
          wasm.fmVoice({ harmonicity: 0 });
          break;
        case 'instruments-fmvoice-error-index':
          wasm.fmVoice({ modulationIndex: -1 });
          break;
        case 'instruments-layer-error-empty':
          wasm.layer(note.handle, [], {});
          break;
        case 'instruments-layer-error-stagger':
          wasm.layer(note.handle, [{}], { stagger: -1 });
          break;
        default:
          throw new Error(`no inputs are known for the message-only case ${id}`);
      }
      return null;
    });
  } finally {
    engine.free();
  }
}

function book(spec: Case): Booked {
  wasm.clearSamples();
  render.clearSamples();
  try {
    if (spec.definition !== undefined && spec.render !== undefined) return bookScore(spec);
    if (spec.error !== undefined) {
      return bookMessageOnly(spec.id);
    }
    if (spec.program !== undefined && spec.render !== undefined) return bookRender(spec);
    return bookVoices(spec);
  } finally {
    wasm.clearSamples();
    render.clearSamples();
  }
}

export function runGroup(group: string) {
  const file = JSON.parse(readFileSync(`${root}conformance/cases/3/${group}.json`, 'utf8')) as {
    cases: Case[];
  };
  let passed = 0;
  const floor: string[] = [];
  const failed: string[] = [];
  for (const spec of file.cases) {
    const booked = book(spec);
    if (spec.error !== undefined) {
      if ('error' in booked && booked.error === spec.error) passed += 1;
      else
        failed.push(
          `${spec.id}: expected the error ${JSON.stringify(spec.error)}, got ${JSON.stringify(booked)}`
        );
      continue;
    }
    if ('error' in booked) {
      failed.push(`${spec.id}: threw ${booked.error}`);
      continue;
    }
    const diff = compare(spec.graph, booked.graph, 'graph');
    if (diff === 'floor') {
      floor.push(spec.id);
      passed += 1;
    } else if (diff) failed.push(`${spec.id}: ${diff}`);
    else passed += 1;
  }
  return { group, total: file.cases.length, passed, floor, failed };
}

if (import.meta.main) {
  const groups =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : readdirSync(`${root}conformance/cases/3`)
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.replace(/\.json$/, ''));
  let total = 0;
  let passed = 0;
  let failures = 0;
  for (const group of groups) {
    const result = runGroup(group);
    total += result.total;
    passed += result.passed;
    failures += result.failed.length;
    console.log(
      `${group}: ${result.passed} of ${result.total} equal (${result.floor.length} only through the 1e-15 floor${result.floor.length ? `: ${result.floor.join(', ')}` : ''}), ${result.failed.length} failed`
    );
    for (const failure of result.failed.slice(0, 10)) console.log(`  FAIL ${failure}`);
  }
  console.log(`layer 3: ${passed} of ${total} equal, ${failures} failed`);
  if (PERTURB) {
    console.log(`negative control: ${failures} of ${total} cases differ (expected: most)`);
    if (failures < total / 2) process.exit(1);
  } else if (failures > 0 || passed !== total) process.exit(1);
}
