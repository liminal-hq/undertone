// The opt-in AudioWorklet backend: voices collected on the main thread, booked and rendered in a worklet (RF-29)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The default backend replays the engine's records on the caller's Web Audio context (D-09) and is untouched. This entry is a
// second, separate way to play: `createWorkletOutput(context)` adds an `AudioWorkletProcessor` that holds the render module's
// `WorkletEngine`, and `output.play(pattern)` / `output.loop(pattern)` collect the pattern's voices here, on the main thread
// (`collectVoices`, exactly as `renderToBuffer` does: foreign leaves, the tempo, `setcpm()`, and sample decoding all stay on
// this side, D-48), and post them with the frame they start at. The worklet books them as its clock reaches them and renders each
// block with the offline render's own maths. A loop repeats on the worklet's clock, so it keeps time when the main thread is busy.
//
// How it loads (D-47): the main thread compiles the render module once and posts the `WebAssembly.Module` in `processorOptions`;
// the worklet instantiates it synchronously (`initSync`). The module added to the worklet is made at run time, as a blob, from
// the `TextDecoder`/`TextEncoder` shim (the worklet scope has neither), the render module's glue text, and the processor
// (workletShim.ts, workletProcessor.ts), so nothing here depends on a bundler; the glue and the module are found with
// `new URL(..., import.meta.url)`, which bundlers copy as assets, and each can be given as an option instead.
//
// Voices travel over the processor's `MessagePort`, which is always available. A `SharedArrayBuffer` ring for a cross-origin
// isolated page is not built: the port's cost is measured by the harness first (packages/undertone/harness/).

import type { RenderOptions } from './engineTypes.js';
import { Pattern, handleOfPattern } from './pattern.js';
import type { Hap, TimeSpan } from './pattern.js';
import { connectSampleSink, loadSamples, pendingKeysIn } from './samples.js';
import { defaultCpm } from './scheduler.js';
import type { AudioContextLike, ControlPatch } from './types.js';
import { glue } from './wasm.js';
import type { WasmVoices } from '../wasm/undertone_wasm.js';
import { workletProcessorName, workletProcessorSource } from './workletProcessor.js';
import { workletShimSource } from './workletShim.js';

/** The minimal pattern surface `play` and `loop` need, as `renderToBuffer`'s. */
interface PlayablePattern {
  query(span: TimeSpan): Hap<ControlPatch>[];
}

/** The part of a `MessagePort` the backend uses. */
export interface WorkletPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close?(): void;
}

/** The part of an `AudioWorkletNode` the backend uses. */
export interface WorkletNodeLike {
  readonly port: WorkletPortLike;
  connect(destination: unknown): unknown;
  disconnect(): void;
  onprocessorerror: ((event: unknown) => void) | null;
}

/** The part of an `AudioContext` the backend uses: its clock, its destination, and its worklet. */
export interface WorkletContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: {
    channelCount: number;
    channelInterpretation?: string;
    readonly maxChannelCount?: number;
  };
  readonly audioWorklet?: { addModule(url: string): Promise<void> };
  decodeAudioData?(data: ArrayBuffer): Promise<unknown>;
}

/** Where the render module (or the glue) comes from, when it is not next to this file. */
export type WorkletSource = WebAssembly.Module | BufferSource | Response | string | URL;

/** The valid output channel counts: the render's (1, 2, 4, 6, 8). */
export type WorkletChannels = 1 | 2 | 4 | 6 | 8;

/** Options of `createWorkletOutput`. */
export interface WorkletOutputOptions {
  /** Output channels. Default 2. More than two needs a destination that can be that wide (`maxChannelCount`). */
  channels?: WorkletChannels;
  /** Seeds noise and reverb, as a render's `seed`. */
  seed?: string | number;
  /** The master bus, as a render's `master` (on by default). */
  master?: RenderOptions['master'];
  /** Holds each note for its share of the cycle, as `loop()` does (default), or lets envelopes run their course. */
  gated?: boolean;
  /** Where to connect the node: the context's destination (default), another node, or `false` to connect it yourself. */
  connect?: unknown;
  /** How far ahead of now a pass starts when `when` is not given, in seconds. Default 0.15. */
  leadTime?: number;
  /** The render module (`undertone_wasm_render_bg.wasm`): a compiled module, its bytes, a `Response`, or a URL. Default: next to this file. */
  wasm?: WorkletSource;
  /** Where to fetch the render module's glue (`undertone_wasm_render.js`) from. Default: next to this file. */
  glueUrl?: string | URL;
  /** The render module's glue as text, when you have it already (nothing is fetched). */
  glueText?: string;
  /** A module you host yourself (made with `workletModuleSource`), for a page whose policy refuses `blob:` URLs. Skips the blob. */
  moduleUrl?: string | URL;
  /** How long to wait for the processor to start or to answer a statistics request, in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Makes the node (tests give a fake; the default is `new AudioWorkletNode(...)`). */
  createNode?: (
    context: WorkletContextLike,
    name: string,
    options: Record<string, unknown>
  ) => WorkletNodeLike;
}

/** What `play` and `loop` accept. */
export interface WorkletPlayOptions {
  /** Whole cycles to play (a loop repeats these). Default 1. */
  cycles?: number;
  /** Tempo in beats per minute, four beats to a cycle. */
  bpm?: number;
  /** Tempo in cycles per second. Without `bpm` or `cps` the `setcpm()` tempo, then 120 bpm. */
  cps?: number;
  /** The context time, in seconds, the pass starts at. Default: now plus `leadTime`. */
  when?: number;
  /** As the output's `gated`, for this pass. */
  gated?: boolean;
}

/** A pass or a loop that was started. */
export interface WorkletPlayback {
  /** Resolves once the voices have been posted to the worklet (after any sample they name has been decoded). */
  readonly ready: Promise<void>;
  /** Stops a loop from booking more: what the worklet booked already (up to about 100 ms ahead) plays out. */
  stop(): void;
}

/** A summary of times in milliseconds (5 microsecond buckets in the worklet). */
export interface WorkletTimes {
  count: number;
  mean: number | null;
  p50: number | null;
  p99: number | null;
  p999: number | null;
  max: number | null;
}

/** What the processor measured, and the counts that say whether it kept up. */
export interface WorkletStats {
  /** `performance.now` when the worklet scope has it; `none` when it does not (no times are reported). */
  timing: 'performance.now' | 'none';
  sampleRate: number;
  quantumFrames: number;
  /** The time one block may take: 128 frames at the sample rate, in milliseconds. */
  budgetMs: number;
  blocks: number;
  /** Time in each `process` call, booking included. `null` when the scope has no clock. */
  processMs: WorkletTimes | null;
  /** Time spent decoding and queueing a posted pass. */
  queueMs: WorkletTimes | null;
  /** Blocks whose `process` took longer than the budget: a likely glitch. */
  overruns: number;
  /** Blocks that took more than 40% of the budget (the acceptance limit is on the 99th percentile). */
  over40Percent: number;
  /** Blocks the host skipped: its clock went on by more than the engine rendered. */
  skippedBlocks: number;
  /** How many frames the engine's clock is behind the host's now (zero when no block was skipped). */
  driftFrames: number;
  maxDriftFrames: number;
  /** Passes that arrived after their start frame. */
  lateStarts: number;
  maxLateFrames: number;
  engineFrame: number;
  hostFrame: number;
  /** Nodes the engine holds now: it should stay flat as voices end. */
  liveNodes: number;
  queues: number;
  /** The first messages of voices or messages that failed. */
  errors: string[];
  /** The main thread's own counts. */
  main: { passes: number; voices: number; samples: number };
}

/** The statistics the processor sends (without the main thread's counts). */
type ProcessorStats = Omit<WorkletStats, 'main'> & { type: 'stats'; id: number };

/** An output that plays patterns in an AudioWorklet. */
export interface WorkletOutput {
  /** The `AudioWorkletNode`. */
  readonly node: WorkletNodeLike;
  readonly sampleRate: number;
  readonly channels: number;
  /** Whether the page is cross-origin isolated (a `SharedArrayBuffer` ring would be possible; this backend uses the message port). */
  readonly crossOriginIsolated: boolean;
  /** Plays `cycles` cycles of the pattern once. */
  play(pattern: PlayablePattern, options?: WorkletPlayOptions): WorkletPlayback;
  /** Repeats the pattern's first `cycles` cycles until stopped. */
  loop(pattern: PlayablePattern, options?: WorkletPlayOptions): WorkletPlayback;
  /** The worklet's statistics. */
  stats(): Promise<WorkletStats>;
  /** Starts the statistics again (after a warm-up, say). */
  resetStats(): void;
  /** Called with a message when the worklet reports a failure (a voice that could not be booked, a bad message). */
  onerror: ((message: string) => void) | null;
  /** Disconnects the node, frees the engine and its samples, and stops the processor. */
  close(): void;
}

const DEFAULT_LEAD = 0.15;
const DEFAULT_TIMEOUT = 5000;

/** The module the worklet loads: the shim, the glue, then the processor. */
export function workletModuleSource(glueText: string): string {
  return [
    '// Undertone worklet backend: a TextDecoder/TextEncoder shim, the render module glue, and the processor.',
    workletShimSource,
    glueText,
    workletProcessorSource
  ].join('\n');
}

const added = new WeakMap<object, Promise<void>>();

async function readText(source: string | URL): Promise<string> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`could not fetch ${String(source)}: ${response.status}`);
  return response.text();
}

async function readBytes(source: WebAssembly.Module | BufferSource | Response | string | URL) {
  if (source instanceof WebAssembly.Module) return source;
  if (typeof source === 'string' || source instanceof URL) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`could not fetch ${String(source)}: ${response.status}`);
    return response.arrayBuffer();
  }
  if (typeof Response !== 'undefined' && source instanceof Response) return source.arrayBuffer();
  return source;
}

/** The URL of the render module's glue and module, next to this file (a bundler copies each as an asset). */
function defaultGlueUrl(): URL {
  return new URL('../wasm/render/undertone_wasm_render.js', import.meta.url);
}
function defaultWasmUrl(): URL {
  return new URL('../wasm/render/undertone_wasm_render_bg.wasm', import.meta.url);
}

/** Adds the processor to the context's worklet once. */
function addProcessor(context: WorkletContextLike, options: WorkletOutputOptions): Promise<void> {
  const worklet = context.audioWorklet;
  if (worklet === undefined) {
    return Promise.reject(
      new Error(
        'this context has no audioWorklet: an AudioWorklet needs a secure context (https or localhost) and a browser that has it'
      )
    );
  }
  const known = added.get(worklet);
  if (known !== undefined) return known;
  const adding = (async () => {
    if (options.moduleUrl !== undefined) {
      await worklet.addModule(String(options.moduleUrl));
      return;
    }
    const text = options.glueText ?? (await readText(options.glueUrl ?? defaultGlueUrl()));
    const source = workletModuleSource(text);
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await worklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  added.set(worklet, adding);
  adding.catch(() => {
    // A failed add is not kept: the next output tries again.
    if (added.get(worklet) === adding) added.delete(worklet);
  });
  return adding;
}

/** The seconds one cycle lasts, as the render module works it out (four beats to a cycle, `setcpm()` as a fallback). */
function cycleSeconds(options: WorkletPlayOptions): number {
  if (options.cps !== undefined) return 1 / options.cps;
  if (options.bpm !== undefined) return 240 / options.bpm;
  const cpm = defaultCpm();
  return cpm !== undefined ? 60 / cpm : 2;
}

function handleOf(pattern: PlayablePattern) {
  return handleOfPattern(
    pattern instanceof Pattern ? pattern : new Pattern((span) => pattern.query(span))
  );
}

function isCloneError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'DataCloneError'
  );
}

/**
 * Makes an output that plays patterns in an `AudioWorklet` on `context`.
 *
 * Opt-in: the package's default is the Web Audio backend. Call it after the package has loaded (`import '@liminal-hq/undertone'`,
 * or `await init()` from `./init`). It adds the processor to the context's worklet (once per context), starts it, and resolves
 * when the processor has instantiated the render module and said it is ready.
 */
export async function createWorkletOutput(
  context: WorkletContextLike,
  options: WorkletOutputOptions = {}
): Promise<WorkletOutput> {
  const channels = options.channels ?? 2;
  if (![1, 2, 4, 6, 8].includes(channels)) {
    throw new Error(`channels must be 1, 2, 4, 6 or 8, got ${String(channels)}`);
  }
  const leadTime = options.leadTime ?? DEFAULT_LEAD;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const connectTo = options.connect === undefined ? context.destination : options.connect;
  if (connectTo === context.destination && channels > 2) {
    const widest = context.destination.maxChannelCount ?? 2;
    if (widest < channels) {
      throw new Error(
        `a ${String(channels)}-channel output needs a destination that can be that wide, and this one's maxChannelCount is ${String(widest)}`
      );
    }
    context.destination.channelCount = channels;
    context.destination.channelInterpretation = 'discrete';
  }

  // The engine's own options: the sample rate is the context's, and the length options of a render do not apply.
  const engineOptions: Record<string, unknown> = { sampleRate: context.sampleRate, channels };
  if (options.seed !== undefined) engineOptions.seed = options.seed;
  if (options.master !== undefined) engineOptions.master = options.master;

  // The render module, compiled once on this thread; its bytes are kept to post when the worklet cannot take a module.
  const [adding, source] = await Promise.all([
    addProcessor(context, options),
    readBytes(options.wasm ?? defaultWasmUrl())
  ]);
  void adding;
  const compiled =
    source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const bytes = source instanceof WebAssembly.Module ? undefined : source;

  const make =
    options.createNode ??
    ((ctx: WorkletContextLike, name: string, nodeOptions: Record<string, unknown>) => {
      const Node = (
        globalThis as {
          AudioWorkletNode?: new (c: unknown, n: string, o: unknown) => WorkletNodeLike;
        }
      ).AudioWorkletNode;
      if (Node === undefined) throw new Error('AudioWorkletNode is not available here');
      return new Node(ctx, name, nodeOptions);
    });
  const nodeOptions = (module: unknown): Record<string, unknown> => ({
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: { module, options: engineOptions }
  });
  let node: WorkletNodeLike;
  try {
    node = make(context, workletProcessorName, nodeOptions(compiled));
  } catch (error) {
    // A browser that cannot send a compiled module to a worklet gets the bytes, which the processor compiles itself.
    if (!isCloneError(error) || bytes === undefined) throw error;
    node = make(context, workletProcessorName, nodeOptions(bytes));
  }

  let ready: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const waiting = new Map<number, (stats: ProcessorStats) => void>();
  let nextId = 0;
  let closed = false;
  const main = { passes: 0, voices: 0, samples: 0 };
  const output: { onerror: ((message: string) => void) | null } = { onerror: null };

  node.port.onmessage = (event) => {
    const message = event.data as { type?: string; message?: string; id?: number };
    if (message.type === 'ready') ready?.();
    else if (message.type === 'stats' && message.id !== undefined)
      waiting.get(message.id)?.(message as unknown as ProcessorStats);
    else if (message.type === 'error') output.onerror?.(String(message.message));
  };
  node.onprocessorerror = () => {
    failed?.(new Error('the worklet processor failed (its constructor or process threw)'));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    started,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`the worklet processor did not start within ${String(timeoutMs)} ms`)),
        timeoutMs
      );
    })
  ]).finally(() => clearTimeout(timer));

  const post = (message: unknown, transfer: Transferable[] = []): void => {
    if (!closed) node.port.postMessage(message, transfer);
  };
  // The worklet keeps its own sample registry (a third copy beside the two modules'): it gets every sample, as they arrive.
  const unlink = connectSampleSink({
    registerSample(name, source) {
      main.samples += 1;
      post({ type: 'sample', op: 'register', name, source });
    },
    registerPendingSample(name, base) {
      post({ type: 'sample', op: 'pending', name, base });
    },
    loadSample(name, decoded) {
      main.samples += 1;
      post({ type: 'sample', op: 'load', name, decoded });
    },
    clearSamples() {
      post({ type: 'sample', op: 'clear' });
    }
  });

  if (connectTo !== false) node.connect(connectTo);

  let tokens = 0;
  const start = (
    pattern: PlayablePattern,
    playOptions: WorkletPlayOptions,
    repeat: boolean
  ): WorkletPlayback => {
    if (closed) throw new Error('this output is closed');
    const cycles = playOptions.cycles ?? 1;
    // Collected here, synchronously, as `renderToBuffer` collects: a bad option, a pattern that throws, or a JavaScript leaf is
    // reported to the caller of play() and loop() at once.
    const voices: WasmVoices = glue.collectVoices(handleOf(pattern), {
      cycles,
      bpm: playOptions.bpm,
      cps: playOptions.cps,
      sampleRate: context.sampleRate,
      channels,
      seed: options.seed,
      master: options.master,
      gated: playOptions.gated ?? options.gated,
      defaultCpm: defaultCpm()
    });
    const [numbers, strings] = voices.encoded() as [Float64Array, string[]];
    const count = voices.length;
    voices.free();
    const period = repeat ? cycles * cycleSeconds(playOptions) * context.sampleRate : undefined;
    const token = (tokens += 1);
    let stopped = false;
    const posted = (async () => {
      // A sample the voices name that has not been decoded is decoded first (the worklet cannot decode); its PCM reaches the
      // worklet's registry through the sample link above, before the voices do.
      const pending = pendingKeysIn(strings);
      if (pending.length > 0) await loadSamples(context as unknown as AudioContextLike, pending);
      if (stopped || closed) return;
      const when = playOptions.when ?? context.currentTime + leadTime;
      main.passes += 1;
      main.voices += count;
      post(
        {
          type: 'play',
          token,
          numbers,
          strings,
          frame: Math.round(when * context.sampleRate),
          period
        },
        [numbers.buffer]
      );
    })();
    posted.catch((error: unknown) => {
      output.onerror?.(error instanceof Error ? error.message : String(error));
    });
    return {
      ready: posted,
      stop() {
        stopped = true;
        post({ type: 'cancel', token });
      }
    };
  };

  return {
    node,
    sampleRate: context.sampleRate,
    channels,
    crossOriginIsolated:
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    play: (pattern, playOptions = {}) => start(pattern, playOptions, false),
    loop: (pattern, playOptions = {}) => start(pattern, playOptions, true),
    stats() {
      const id = (nextId += 1);
      return new Promise<WorkletStats>((resolve, reject) => {
        const limit = setTimeout(() => {
          waiting.delete(id);
          reject(
            new Error(
              `the worklet did not answer a statistics request within ${String(timeoutMs)} ms`
            )
          );
        }, timeoutMs);
        waiting.set(id, (stats) => {
          clearTimeout(limit);
          waiting.delete(id);
          const answer: Partial<ProcessorStats> = { ...stats };
          delete answer.type;
          delete answer.id;
          resolve({ ...(answer as Omit<ProcessorStats, 'type' | 'id'>), main: { ...main } });
        });
        post({ type: 'stats', id });
      });
    },
    resetStats() {
      post({ type: 'reset-stats' });
    },
    get onerror() {
      return output.onerror;
    },
    set onerror(listener) {
      output.onerror = listener;
    },
    close() {
      if (closed) return;
      post({ type: 'close' });
      closed = true;
      unlink();
      node.disconnect();
      node.port.onmessage = null;
      node.port.close?.();
    }
  };
}
