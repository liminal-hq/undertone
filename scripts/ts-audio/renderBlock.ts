// Runs one marked documentation block under an offline Web Audio engine and returns the WAV files its sound makes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as lib from '../../src/index';
import { seedContext } from '../../src/random';
import type { MasterBusOptions } from '../../src/masterBus';
import type { OfflineAudioContextLike, RenderedAudioBufferLike } from '../../src/types';
import type { WavOptions } from '../../src/wav';
import { prepareSnippet } from '../../docs/.vitepress/theme/live/sourceEngine';
import { standInFor, standInWav } from './standIns';

/** How a block's sound is made. */
export type BlockKind =
  /** The block renders itself (`.render()`, `encodeWav`); the renders it makes are the files. */
  | 'run'
  /** The block plays live (`.loop()`, `.play()`); each pattern it starts is rendered offline through the library's own render path. */
  | 'capture'
  /** The block drives its own `AudioContext` (`playParams`); that context is an offline one of `seconds` length, rendered after the block runs. */
  | 'direct';

/** One entry of docs/audio/manifest.json. */
export interface BlockSpec {
  /** The page the marked block is on, relative to the repository root. */
  page: string;
  kind: BlockKind;
  /** capture: whole cycles to render of each pattern the block starts. Default 4. */
  cycles?: number;
  /** capture: seconds rendered after the last cycle so releases and reverb ring out. Default 1. */
  tail?: number;
  /** capture: the output layouts to render, each its own file. Default `[2]`. A layout wider than stereo is rendered as it is; the stereo file is folded by the library itself. */
  channels?: Array<1 | 2 | 4 | 6 | 8>;
  /** capture: master bus options to render through when the block does not make a master bus itself, for a block whose stand-in samples add up past full scale (`gain` brings the mix down; `ceiling` is the library's own hard ceiling in dBFS). */
  master?: Omit<MasterBusOptions, 'output'>;
  /** direct: seconds of the offline context. Default 2. */
  seconds?: number;
  /** run: keep only the first this-many seconds of each render. */
  trimSeconds?: number;
  /** File names (without `.wav`), in the order the block makes them. */
  labels?: string[];
  /** A sentence added to the caption of every file. */
  note?: string;
}

/** One rendered file, ready to write. */
export interface RenderedFile {
  file: string;
  bytes: Uint8Array;
  sampleRate: number;
  channels: number;
  seconds: number;
  bitDepth: 16 | 24 | 32;
  /** Largest absolute sample, in dBFS (negative infinity for silence). */
  peakDb: number;
  /** Root mean square over every channel, in dBFS. */
  rmsDb: number;
  /** What the page should say about how this file was made, besides the engine, rate and layout. */
  note: string;
  /** Lines the block wrote with `console.log`. */
  logs: string[];
}

/** The offline context an engine supplies (the node-web-audio-api one in the script, a fake in the tests). */
export type OfflineContextConstructor = new (
  numberOfChannels: number,
  length: number,
  sampleRate: number
) => OfflineAudioContextLike;

export interface RenderEngine {
  OfflineAudioContext: OfflineContextConstructor;
}

const RATE = 48000;
const LAYOUT_NAMES: Record<number, string> = {
  1: 'mono',
  2: 'stereo',
  4: 'quad',
  6: '5.1',
  8: '7.1'
};
const STAND_IN_NOTE =
  'The sample files the code names are stand-ins made for this page, not recordings.';

interface Started {
  pattern: Parameters<typeof lib.renderToBuffer>[0];
  options: lib.LoopOptions;
  once: boolean;
}

interface Tuning {
  orbit: number;
  method: 'setRoomSize' | 'setDelay';
  args: number[];
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

const globals = globalThis as Record<string, unknown>;

function stats(channels: readonly Float32Array[]): { peakDb: number; rmsDb: number } {
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
      sum += value * value;
    }
    count += data.length;
  }
  const db = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, count))) };
}

function channelData(buffer: RenderedAudioBufferLike, seconds?: number): Float32Array[] {
  const frames =
    seconds === undefined
      ? buffer.length
      : Math.min(buffer.length, Math.round(seconds * buffer.sampleRate));
  return Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i).slice(0, frames)
  );
}

function layoutName(channels: number): string {
  return LAYOUT_NAMES[channels] ?? `${channels}-channel`;
}

/**
 * Runs the code of one marked block against the library source, with an offline engine standing in for the browser's Web Audio, and
 * returns the WAV files its sound makes. See `BlockKind` for the three ways a block makes sound. Throws, naming the problem, when the
 * block fails or makes nothing to render.
 */
export async function renderBlock(
  code: string,
  spec: BlockSpec,
  engine: RenderEngine
): Promise<RenderedFile[]> {
  const logs: string[] = [];
  const started: Started[] = [];
  const renders: RenderedAudioBufferLike[] = [];
  const encoded = new Map<object, WavOptions>();
  const buses = new Map<object, Omit<MasterBusOptions, 'output'>>();
  const tuning: Tuning[] = [];
  const created: OfflineAudioContextLike[] = [];
  const standIns = new Set<string>();
  const directSeconds = spec.seconds ?? 2;

  // A context a block makes for itself is an offline one: a direct block renders it, the others only use it to prepare things.
  class BlockContext {
    constructor() {
      const seconds = spec.kind === 'direct' ? directSeconds : 1;
      const ctx = new engine.OfflineAudioContext(2, Math.round(seconds * RATE), RATE);
      created.push(ctx);
      return ctx;
    }
  }

  const shadow = {
    ...lib,
    encodeWav: (source: lib.WavSource, options?: WavOptions) => {
      encoded.set(source, options ?? {});
      return lib.encodeWav(source, options);
    },
    createMasterBus: (ctx: Parameters<typeof lib.createMasterBus>[0], options = {}) => {
      const bus = lib.createMasterBus(ctx, options);
      const { output: _output, ...tuned } = options as MasterBusOptions;
      void _output;
      buses.set(bus.input, tuned);
      return bus;
    },
    getOrbitBus: (ctx: Parameters<typeof lib.getOrbitBus>[0], orbit: number, output?: never) => {
      const bus = lib.getOrbitBus(ctx, orbit, output);
      return {
        reverbInput: bus.reverbInput,
        delayInput: bus.delayInput,
        setRoomSize(size: number) {
          tuning.push({ orbit, method: 'setRoomSize', args: [size] });
          bus.setRoomSize(size);
        },
        setDelay(time: number, feedback: number, when?: number) {
          tuning.push({ orbit, method: 'setDelay', args: [time, feedback] });
          bus.setDelay(time, feedback, when);
        }
      };
    }
  };

  const proto = lib.Pattern.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = { loop: proto.loop, play: proto.play, render: proto.render };
  const savedGlobals = ['AudioContext', 'OfflineAudioContext', 'fetch'].map(
    (name) => [name, globals[name]] as const
  );

  try {
    globals.AudioContext = BlockContext;
    globals.OfflineAudioContext = engine.OfflineAudioContext;
    globals.fetch = async (url: string) => {
      const wav = standInWav(String(url));
      if (!wav) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      standIns.add(standInFor(String(url)) as string);
      const copy = wav.slice().buffer;
      return { ok: true, status: 200, arrayBuffer: async () => copy };
    };
    if (typeof URL.createObjectURL !== 'function') {
      (URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:stand-in';
    }
    proto.loop = function (this: Started['pattern'], options: lib.LoopOptions = {}) {
      started.push({ pattern: this, options, once: false });
      return { stop: () => undefined };
    } as never;
    proto.play = function (this: Started['pattern'], options: lib.LoopOptions = {}) {
      started.push({ pattern: this, options, once: true });
      return { stop: () => undefined };
    } as never;
    proto.render = async function (this: unknown, ...args: unknown[]) {
      const buffer = (await original.render.apply(this, args)) as RenderedAudioBufferLike;
      renders.push(buffer);
      return buffer;
    } as never;
    lib.resetTempo();

    const consoleShadow = {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => logs.push(args.map(String).join(' '))
    };
    const body = prepareSnippet(code, shadow);
    await new AsyncFunction('__lib', 'console', body)(shadow, consoleShadow);

    const files: Array<{
      label: string;
      data: Float32Array[];
      bitDepth: 16 | 24 | 32;
      extra: string[];
    }> = [];
    const context =
      (seed: number | string) =>
      (init: { numberOfChannels: number; length: number; sampleRate: number }) => {
        const ctx = new engine.OfflineAudioContext(
          init.numberOfChannels,
          init.length,
          init.sampleRate
        );
        // What the block tuned by hand on its own bus is repeated on the render's, so the room and the delay it set are what is heard.
        seedContext(ctx, seed);
        for (const { orbit, method, args } of tuning) {
          const bus = lib.getOrbitBus(ctx, orbit) as unknown as Record<
            string,
            (...a: number[]) => void
          >;
          bus[method](...args);
        }
        return ctx;
      };

    if (spec.kind === 'run') {
      if (renders.length === 0) throw new Error('the block never rendered anything');
      renders.forEach((buffer, i) => {
        const data = channelData(buffer, spec.trimSeconds);
        const extra =
          spec.trimSeconds !== undefined && spec.trimSeconds < buffer.length / buffer.sampleRate
            ? [
                `Only the first ${spec.trimSeconds} s of the ${Math.round(buffer.length / buffer.sampleRate)} s render are kept here.`
              ]
            : [];
        const wavOptions = [...encoded].find(([source]) => source === buffer)?.[1];
        files.push({
          label: spec.labels?.[i] ?? (renders.length === 1 ? 'render' : `render-${i + 1}`),
          data,
          bitDepth: wavOptions?.bitDepth ?? 16,
          extra
        });
      });
    } else if (spec.kind === 'capture') {
      if (started.length === 0) throw new Error('the block never played or looped a pattern');
      const layouts = spec.channels ?? [2];
      let index = 0;
      for (const run of started) {
        let master: boolean | Omit<MasterBusOptions, 'output'> = false;
        if (run.options.output !== undefined) {
          const tuned = buses.get(run.options.output);
          if (!tuned) throw new Error('the block plays through an output this renderer cannot map');
          master = tuned;
        }
        if (master === false && spec.master !== undefined) master = spec.master;
        for (const channels of layouts) {
          const buffer = await lib.renderToBuffer(run.pattern, {
            cycles: spec.cycles ?? (run.once ? 1 : 4),
            tail: spec.tail ?? 1,
            bpm: run.options.bpm,
            cps: run.options.cps,
            sampleRate: RATE,
            channels,
            seed: 0,
            gated: !run.once,
            master,
            context: context(0)
          });
          const folded = channels === 2 && layouts.some((layout) => layout > 2);
          files.push({
            label:
              spec.labels?.[index] ??
              (layouts.length > 1
                ? layoutName(channels)
                : started.length > 1
                  ? `audio-${index + 1}`
                  : 'audio'),
            data: channelData(buffer),
            bitDepth: 16,
            extra: folded
              ? [
                  "The stereo file is the same pattern folded to two channels by the library's own surround fold."
                ]
              : []
          });
          index++;
        }
      }
    } else {
      const ctx = created[0];
      if (!ctx) throw new Error('the block never made an AudioContext');
      const buffer = await ctx.startRendering();
      files.push({
        label: spec.labels?.[0] ?? 'audio',
        data: channelData(buffer),
        bitDepth: 16,
        extra: []
      });
    }

    const notes = [
      ...(spec.note ? [spec.note] : []),
      ...(standIns.size > 0 ? [STAND_IN_NOTE] : [])
    ];
    return files.map(({ label, data, bitDepth, extra }) => {
      const source = { sampleRate: RATE, channels: data };
      const { peakDb, rmsDb } = stats(data);
      return {
        file: `${label}.wav`,
        bytes: lib.encodeWav(source, { bitDepth }),
        sampleRate: RATE,
        channels: data.length,
        seconds: data[0].length / RATE,
        bitDepth,
        peakDb,
        rmsDb,
        note: [...extra, ...notes].join(' '),
        logs
      };
    });
  } finally {
    proto.loop = original.loop;
    proto.play = original.play;
    proto.render = original.render;
    for (const [name, value] of savedGlobals) {
      if (value === undefined) delete globals[name];
      else globals[name] = value;
    }
    lib.resetTempo();
  }
}
