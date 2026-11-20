// Offline rendering through the lazily loaded render module, and booking on a caller's offline context
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The main module collects a render's voices as plain data; the render module (a second WebAssembly instance, loaded on the
// first render, M6-BOUNDARY section 13) renders them, or books them on a recorder for a caller's `OfflineAudioContext` (the
// `context` option), which the Web Audio backend's replayer plays onto that context. The entries say how the render module
// loads: the Node, Bun, and Deno entries instantiate it synchronously from disk on first use; the browser entries import it
// with a dynamic `import()` and fetch it, on the first render.

import type { OfflineContextInit, RenderOptions } from './engineTypes.js';
import { Pattern, handleOfPattern } from './pattern.js';
import type { Hap, TimeSpan } from './pattern.js';
import { connectRenderSamples, loadSamples, pendingKeysIn } from './samples.js';
import { defaultCpm } from './scheduler.js';
import type { ControlPatch, OfflineAudioContextLike, RenderedAudioBufferLike } from './types.js';
import { warnOnce } from './warn.js';
import { replayerFor } from './webaudio.js';
import { glue } from './wasm.js';
import type { WasmVoices } from '../wasm/undertone_wasm.js';
import type * as RenderModule from '../wasm/render/undertone_wasm_render.js';

/** The render module's glue, once instantiated. */
export type RenderGlue = typeof RenderModule;

/** How an entry loads the render module: synchronously (Node, Bun, Deno) or with a promise (browsers). */
export interface RenderLoader {
  sync?: () => RenderGlue;
  async: () => Promise<RenderGlue>;
}

let loader: RenderLoader | undefined;
let loaded: RenderGlue | undefined;
let loading: Promise<RenderGlue> | undefined;

/** Called by each entry with its way of loading the render module. */
export function setRenderLoader(how: RenderLoader): void {
  loader = how;
}

function ready(module: RenderGlue): RenderGlue {
  if (!loaded) {
    loaded = module;
    connectRenderSamples(module);
  }
  return loaded;
}

/** The render module, loading it on first use. */
export function loadRender(): Promise<RenderGlue> {
  if (loaded) return Promise.resolve(loaded);
  if (!loader)
    return Promise.reject(
      new Error('the render module has no loader: import an entry of the package')
    );
  loading ??= (loader.sync ? Promise.resolve().then(loader.sync) : loader.async()).then(
    ready,
    (error: unknown) => {
      loading = undefined;
      throw error;
    }
  );
  return loading;
}

/** The render module's warnings are its own set: `./testing`'s `resetWarnings` clears them too. */
export function resetRenderWarnings(): void {
  loaded?.resetWarnings();
}

/** A rendered result as the reference's `AudioBuffer` reads: its channels, rate, and length. */
function renderedBuffer(sampleRate: number, channels: Float32Array[]): RenderedAudioBufferLike {
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    getChannelData(channel: number): Float32Array {
      const data = channels[channel];
      if (data === undefined) throw new RangeError(`channel ${channel} is out of range`);
      return data;
    }
  };
}

/** The minimal pattern surface a render needs. */
interface RenderablePattern {
  query(span: TimeSpan): Hap<ControlPatch>[];
}

/** The pattern a render queries: a package `Pattern`, or anything with a `query` wrapped as one. */
function handleOf(pattern: RenderablePattern) {
  return handleOfPattern(
    pattern instanceof Pattern ? pattern : new Pattern((span) => pattern.query(span))
  );
}

/** The render's options for the module: the caller's, plus the `setcpm()` tempo. */
function moduleOptions(options: object): object {
  return { ...options, defaultCpm: defaultCpm() };
}

function defaultContext(init: OfflineContextInit): OfflineAudioContextLike {
  const Offline = (
    globalThis as {
      OfflineAudioContext?: new (
        numberOfChannels: number,
        length: number,
        sampleRate: number
      ) => OfflineAudioContextLike;
    }
  ).OfflineAudioContext;
  if (!Offline) {
    throw new Error(
      'renderToBuffer needs OfflineAudioContext, which is not available here; pass a `context` factory'
    );
  }
  return new Offline(init.numberOfChannels, init.length, init.sampleRate);
}

/** Renders collected voices: in the render module, or booked on the caller's offline context. */
export async function renderVoices(
  voices: WasmVoices,
  options: RenderOptions
): Promise<RenderedAudioBufferLike> {
  const [numbers, strings] = voices.encoded() as [Float64Array, string[]];
  const settings = voices.options as object;
  voices.free();
  const module = await loadRender();
  const pending = pendingKeysIn(strings);
  if (options.context === undefined) {
    if (pending.length > 0) {
      // A fresh render has decoded nothing; the module's samples are decoded with the platform's context when there is one.
      const Offline = (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext;
      if (Offline !== undefined)
        await loadSamples(
          defaultContext({ numberOfChannels: 1, length: 1, sampleRate: 44100 }),
          pending
        );
    }
    const out = module.renderVoices(numbers, strings, settings) as {
      sampleRate: number;
      channels: Float32Array[];
    };
    return renderedBuffer(out.sampleRate, out.channels);
  }
  return renderOnContext(module, numbers, strings, settings, options, pending);
}

/** `renderToBuffer(pattern, { context })`: the render booked on the caller's offline context and rendered there. */
async function renderOnContext(
  module: RenderGlue,
  numbers: Float64Array,
  strings: string[],
  settings: object,
  options: RenderOptions,
  pending: string[]
): Promise<RenderedAudioBufferLike> {
  let plan = new module.ContextRender(numbers, strings, settings);
  const ctx = (options.context ?? defaultContext)({
    numberOfChannels: plan.channels,
    length: plan.length,
    sampleRate: plan.sampleRate
  });
  // A fresh context has decoded nothing, and a sample voice with no buffer is skipped; the plan is made again once the
  // samples have their PCM (its windows ask which voices really book), or without windows on a context that cannot pause.
  await loadSamples(ctx, pending);
  const canSuspend = typeof ctx.suspend === 'function' && typeof ctx.resume === 'function';
  if (options.bookingWindow !== undefined && !canSuspend) {
    warnOnce(
      'render-no-suspend',
      'undertone: this offline context has no suspend() and resume(), so bookingWindow is ignored and every voice is booked up front.'
    );
  }
  if (pending.length > 0 || (options.bookingWindow !== undefined && !canSuspend)) {
    plan.free();
    plan = new module.ContextRender(
      numbers,
      strings,
      canSuspend ? settings : { ...settings, bookingWindow: undefined }
    );
  }
  const replayer = replayerFor(ctx);
  const replay = () => replayer.replay(plan.take() as unknown[]);
  replay();
  let failure: { error: unknown } | undefined;
  const pauses: Promise<void>[] = [];
  for (const time of plan.pauses()) {
    if (time === 0) {
      try {
        plan.bookWindow(0);
      } finally {
        replay();
      }
      continue;
    }
    pauses.push(
      (ctx.suspend as (time: number) => Promise<void>).call(ctx, time).then(
        () => {
          try {
            plan.bookWindow(time);
          } catch (error) {
            failure ??= { error };
          } finally {
            replay();
          }
          return (ctx.resume as () => Promise<void>).call(ctx);
        },
        (error: unknown) => {
          failure ??= { error };
        }
      )
    );
  }
  try {
    const rendered = await ctx.startRendering();
    await Promise.all(pauses);
    if (failure) throw failure.error;
    if (!options.wrap || !((options.tail ?? 0) > 0)) return rendered;
    const channels: Float32Array[] = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(rendered.getChannelData(c));
    const folded = plan.finish(channels) as Float32Array[];
    const out = ctx.createBuffer(
      folded.length,
      folded[0].length,
      rendered.sampleRate
    ) as RenderedAudioBufferLike;
    folded.forEach((data, c) => out.getChannelData(c).set(data));
    return out;
  } finally {
    plan.free();
  }
}

/**
 * Renders a pattern offline to an audio buffer, with no real-time clock and a seeded random source, so the same pattern,
 * tempo and `seed` give the same samples on the same engine. The render runs in the WebAssembly engine; pass a `context`
 * factory to book it on an `OfflineAudioContext` of your own instead. Pass the result to `encodeWav` to write a file.
 *
 * Room size is fixed per orbit for the whole render (the last one booked wins),
 * because a reverb's impulse response cannot be scheduled.
 */
export async function renderToBuffer(
  pattern: RenderablePattern,
  options: RenderOptions = {}
): Promise<RenderedAudioBufferLike> {
  return renderVoices(glue.collectVoices(handleOf(pattern), moduleOptions(options)), options);
}

/** A score's render: its own voices, at its own tempo. */
export function renderScore(
  collect: (options: object) => WasmVoices,
  options: RenderOptions
): Promise<RenderedAudioBufferLike> {
  return Promise.resolve().then(() => renderVoices(collect(moduleOptions(options)), options));
}
