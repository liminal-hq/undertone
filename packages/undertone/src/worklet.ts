// The opt-in AudioWorklet backend: voices collected on the main thread, booked and rendered in a worklet (RF-29)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The default backend replays the engine's records on the caller's Web Audio context (D-09) and is untouched. This entry is a
// second, separate way to play: `createWorkletOutput(context)` adds an `AudioWorkletProcessor` that holds the worklet module's
// `WorkletEngine`, and `output.play(pattern)` / `output.loop(pattern)` collect the pattern's voices here, on the main thread
// (`collectVoices`, exactly as `renderToBuffer` does: foreign leaves, the tempo, `setcpm()`, and sample decoding all stay on
// this side, D-48), and post them with the frame they start at. The worklet books them as its clock reaches them and renders each
// block with the offline render's own maths. A loop goes on from cycle to cycle, as
// the Web Audio `loop()` does: the main thread collects each pass (`startCycle`, cycles N to N+cycles) and posts it a few seconds
// before it is due, and the worklet's clock keeps every pass sample-accurate. The main thread may stall for that lead without a gap.
//
// How it loads (D-47): the main thread compiles the worklet module once and posts the `WebAssembly.Module` in `processorOptions`;
// the worklet instantiates it synchronously (`initSync`). The module added to the worklet is made at run time, as a blob, from
// the `TextDecoder`/`TextEncoder` shim (the worklet scope has neither), the worklet module's glue text, and the processor
// (workletShim.ts, workletProcessor.ts), so nothing here depends on a bundler; the glue and the module are found with
// `new URL(..., import.meta.url)`, which bundlers copy as assets, and each can be given as an option instead.
//
// Two builds of that module ship (D-52): a SIMD one, which `createWorkletOutput` loads where `WebAssembly.validate` accepts a SIMD
// probe module (`supportsSimd()`), and the baseline one, the fallback, where it does not. They are bit-identical in output.
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

/** Where the worklet module (or the glue) comes from, when it is not next to this file. */
export type WorkletSource = WebAssembly.Module | BufferSource | Response | string | URL;

/** The valid output channel counts: the render's (1, 2, 4, 6, 8). */
export type WorkletChannels = 1 | 2 | 4 | 6 | 8;

/** Which worklet module an output runs: the package's SIMD or baseline build, or one the caller supplied. */
export type WorkletModuleKind = 'simd' | 'baseline' | 'custom';

/**
 * A module with one function that returns `i8x16.popcnt(i8x16.splat(0))`: it validates only where the engine implements the
 * WebAssembly SIMD proposal. (The probe the `wasm-feature-detect` library uses.)
 */
export const simdProbe: Uint8Array<ArrayBuffer> = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11
]);

/** Whether this browser (or runtime) accepts WebAssembly SIMD, which decides the worklet module `createWorkletOutput` loads. */
export function supportsSimd(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(simdProbe);
  } catch {
    return false;
  }
}

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
  /**
   * The worklet module (`undertone_worklet_bg.wasm`): a compiled module, its bytes, a `Response`, or a URL. Default: next to this
   * file, the SIMD build where the browser accepts SIMD and the baseline one elsewhere (D-52). Giving `wasm`, `glueUrl`, `glueText`
   * or `moduleUrl` turns that choice off: the module is the baseline build unless you supply another, and `output.module` says
   * `'custom'`. A glue file and its module go together (each names the other), so supply both when you supply either.
   */
  wasm?: WorkletSource;
  /** Where to fetch the worklet module's glue (`undertone_worklet.js`) from. Default: next to this file. */
  glueUrl?: string | URL;
  /** The worklet module's glue as text, when you have it already (nothing is fetched). */
  glueText?: string;
  /** A module you host yourself (made with `workletModuleSource`), for a page whose policy refuses `blob:` URLs. Skips the blob. */
  moduleUrl?: string | URL;
  /**
   * Which of the package's two worklet builds to load: `false` forces the baseline build, `true` forces the SIMD build (without
   * asking the browser, so it fails where SIMD is missing), and leaving it out chooses by `supportsSimd()`. Ignored when `wasm`,
   * `glueUrl`, `glueText` or `moduleUrl` is given. A context's worklet takes one build for good: a later output on the same context
   * uses the first's when this is left out, and throws when it asks for the other.
   */
  simd?: boolean;
  /** Tells whether the browser accepts SIMD, in place of `supportsSimd()` (tests, and pages that know better). */
  detectSimd?: () => boolean;
  /**
   * How `process` is timed. Chromium's worklet scope has no `performance.now()` (the statistics then report no times), so
   * `'spin'` starts a worker that writes its own `performance.now()` into a `SharedArrayBuffer` for the processor to read: a
   * clock with the browser's resolution (5 microseconds on an isolated page) that needs a cross-origin isolated page, and a core's worth of the device while it runs, which a small phone
   * may feel. Leave it out to run without; `output.timing` and `output.timingNote` say what you got.
   */
  clock?: 'spin';
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
  /** Whole cycles to play (a loop plays this many at a time, one pass after another). Default 1. */
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
  /** What timed `process`: `performance.now`, `spin-counter`, or `none` (no times are reported). */
  timing: 'performance.now' | 'spin-counter' | 'none';
  /** Ticks per millisecond of the spin counter: 1,000, as it counts microseconds (`null` for another clock). */
  clockTicksPerMs: number | null;
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
  /** What `process` is timed with: `performance.now` (where the scope has it), `spin-counter` (see `clock`), or `none` (no times). */
  readonly timing: 'performance.now' | 'spin-counter' | 'none';
  /** Why `timing` is not what `clock` asked for, when it is not. */
  readonly timingNote: string | undefined;
  /** Whether the page is cross-origin isolated (a `SharedArrayBuffer` ring would be possible; this backend uses the message port). */
  readonly crossOriginIsolated: boolean;
  /** Which worklet module is in use: the package's `'simd'` or `'baseline'` build, or `'custom'` when you supplied `wasm`, `glueUrl`, `glueText` or `moduleUrl`. */
  readonly module: WorkletModuleKind;
  /** Plays `cycles` cycles of the pattern once. */
  play(pattern: PlayablePattern, options?: WorkletPlayOptions): WorkletPlayback;
  /** Plays the pattern `cycles` cycles at a time, going on from cycle to cycle (cycles 0 to N, then N to 2N, ...) until stopped. */
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
/** How far past the context's clock a loop keeps passes posted, in seconds: how long the main thread may stall without a gap. */
const LOOP_LOOKAHEAD = 4;
/** How often a loop looks whether another pass is due, in milliseconds. */
const LOOP_POLL_MS = 100;
/** The most passes one look posts, so a very short pass cannot hold the main thread. */
const LOOP_PASSES_PER_TICK = 16;
const DEFAULT_TIMEOUT = 5000;

/** The module the worklet loads: the shim, the glue, then the processor. */
export function workletModuleSource(glueText: string): string {
  return [
    '// Undertone worklet backend: a TextDecoder/TextEncoder shim, the worklet module glue, and the processor.',
    workletShimSource,
    glueText,
    workletProcessorSource
  ].join('\n');
}

const added = new WeakMap<object, { adding: Promise<void>; kind: WorkletModuleKind }>();

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

/** The URL of the worklet module's glue and module, next to this file (a bundler copies each as an asset). */
function defaultGlueUrl(simd: boolean): URL {
  return simd
    ? new URL('../wasm/worklet/undertone_worklet_simd.js', import.meta.url)
    : new URL('../wasm/worklet/undertone_worklet.js', import.meta.url);
}
function defaultWasmUrl(simd: boolean): URL {
  return simd
    ? new URL('../wasm/worklet/undertone_worklet_simd_bg.wasm', import.meta.url)
    : new URL('../wasm/worklet/undertone_worklet_bg.wasm', import.meta.url);
}

/** Adds the processor to the context's worklet once. */
function addProcessor(
  context: WorkletContextLike,
  options: WorkletOutputOptions,
  kind: WorkletModuleKind
): Promise<void> {
  const worklet = context.audioWorklet;
  if (worklet === undefined) {
    return Promise.reject(
      new Error(
        'this context has no audioWorklet: an AudioWorklet needs a secure context (https or localhost) and a browser that has it'
      )
    );
  }
  const known = added.get(worklet);
  if (known !== undefined) return known.adding;
  const adding = (async () => {
    if (options.moduleUrl !== undefined) {
      await worklet.addModule(String(options.moduleUrl));
      return;
    }
    const text =
      options.glueText ?? (await readText(options.glueUrl ?? defaultGlueUrl(kind === 'simd')));
    const source = workletModuleSource(text);
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await worklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  added.set(worklet, { adding, kind });
  adding.catch(() => {
    // A failed add is not kept: the next output tries again.
    if (added.get(worklet)?.adding === adding) added.delete(worklet);
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

/**
 * The worker's source: it writes the worker's own `performance.now()`, in microseconds, into a shared buffer as fast as it can
 * (a 32-bit counter that wraps after 35 minutes, and the processor takes spans as signed differences). The counter must be time
 * and not the number of loop turns: the browser compiles a hot loop again as it runs, and a count of turns changed its rate by
 * a factor of 1.6 to 3 within seconds (found by a headless Chromium run, so every span measured with it was wrong by that much).
 */
const spinWorkerSource = `onmessage = (event) => {
  const counter = new Int32Array(event.data);
  for (;;) Atomics.store(counter, 0, (performance.now() * 1000) | 0);
};`;

/** The ticks of the spin counter in a millisecond: it counts microseconds. */
const SPIN_TICKS_PER_MS = 1000;

/**
 * Starts the clock worker and checks that it runs. Needs a cross-origin isolated page (that is what makes `SharedArrayBuffer`
 * exist) and workers from blobs.
 */
async function startSpinClock(): Promise<
  | { note: string }
  | { worker: { terminate(): void }; buffer: SharedArrayBuffer; ticksPerMs: number }
> {
  const scope = globalThis as {
    crossOriginIsolated?: boolean;
    Worker?: new (url: string) => Worker;
  };
  if (scope.crossOriginIsolated !== true || typeof SharedArrayBuffer === 'undefined') {
    return {
      note: 'the spin clock needs a cross-origin isolated page (serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp)'
    };
  }
  if (scope.Worker === undefined)
    return { note: 'the spin clock needs Worker, which is not available here' };
  const buffer = new SharedArrayBuffer(8);
  const counter = new Int32Array(buffer);
  const url = URL.createObjectURL(new Blob([spinWorkerSource], { type: 'text/javascript' }));
  let worker: Worker;
  try {
    worker = new scope.Worker(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    return {
      note: `the spin clock's worker could not start: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  URL.revokeObjectURL(url);
  worker.postMessage(buffer);
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  await wait(60);
  const c0 = Atomics.load(counter, 0);
  await wait(40);
  if (Atomics.load(counter, 0) === c0) {
    worker.terminate();
    return { note: 'the spin clock did not count (its worker did not run)' };
  }
  return { worker, buffer, ticksPerMs: SPIN_TICKS_PER_MS };
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
 * when the processor has instantiated the worklet module and said it is ready.
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

  // Which build: a supplied module, glue, or hosted module wins and is left alone; else the caller's `simd`, else the first output
  // on this context (its glue is already in the worklet and each glue names its own module), else what the browser accepts.
  const supplied =
    options.wasm !== undefined ||
    options.glueUrl !== undefined ||
    options.glueText !== undefined ||
    options.moduleUrl !== undefined;
  const settled =
    context.audioWorklet === undefined ? undefined : added.get(context.audioWorklet)?.kind;
  let kind: WorkletModuleKind;
  if (supplied) kind = 'custom';
  else if (options.simd !== undefined) kind = options.simd ? 'simd' : 'baseline';
  else if (settled !== undefined) kind = settled === 'custom' ? 'baseline' : settled;
  else kind = (options.detectSimd ?? supportsSimd)() ? 'simd' : 'baseline';
  if (settled !== undefined && settled !== 'custom' && kind !== 'custom' && kind !== settled) {
    throw new Error(
      `this context's worklet already has the ${settled} build of the worklet module, and a worklet takes one build for good; asked for ${kind}`
    );
  }

  // The worklet module, compiled once on this thread; its bytes are kept to post when the worklet cannot take a module.
  const [adding, source] = await Promise.all([
    addProcessor(context, options, kind),
    readBytes(options.wasm ?? defaultWasmUrl(kind === 'simd'))
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
  let timing: 'performance.now' | 'spin-counter' | 'none' = 'none';
  let timingNote: string | undefined;
  let spinner: { terminate(): void } | undefined;
  const main = { passes: 0, voices: 0, samples: 0 };
  const output: { onerror: ((message: string) => void) | null } = { onerror: null };

  node.port.onmessage = (event) => {
    const message = event.data as { type?: string; message?: string; id?: number };
    if (message.type === 'ready') {
      timing =
        (message as { timing?: string }).timing === 'performance.now' ? 'performance.now' : 'none';
      ready?.();
    } else if (message.type === 'stats' && message.id !== undefined)
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

  if (options.clock === 'spin' && timing === 'none') {
    const spun = await startSpinClock();
    if ('note' in spun) {
      timingNote = spun.note;
    } else {
      spinner = spun.worker;
      timing = 'spin-counter';
      node.port.postMessage({ type: 'clock', buffer: spun.buffer, ticksPerMs: spun.ticksPerMs });
    }
  }

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
  /** Collects the pass that holds cycles `startCycle` on (as many as `cycles`), here and now: errors are the caller's. */
  const collect = (
    pattern: PlayablePattern,
    playOptions: WorkletPlayOptions,
    startCycle: number
  ) => {
    const voices: WasmVoices = glue.collectVoices(handleOf(pattern), {
      cycles: playOptions.cycles ?? 1,
      startCycle: startCycle > 0 ? startCycle : undefined,
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
    return { numbers, strings, count };
  };
  type Collected = ReturnType<typeof collect>;

  /** The samples a pass names that have not been decoded: the worklet cannot decode, and its registry is fed by the link above. */
  const undecoded = (data: Collected): string[] => pendingKeysIn(data.strings);
  const decode = (keys: string[]): Promise<void> =>
    loadSamples(context as unknown as AudioContextLike, keys);

  /** Posts one pass of voices to the worklet to start at `frame`. */
  const postPass = (data: Collected, token: number, frame: number): void => {
    main.passes += 1;
    main.voices += data.count;
    post({ type: 'play', token, numbers: data.numbers, strings: data.strings, frame }, [
      data.numbers.buffer
    ]);
  };

  // `play`: one pass, collected here, synchronously, as `renderToBuffer` collects: a bad option, a pattern that throws, or a
  // JavaScript leaf is reported to the caller of play() and loop() at once.
  const startOnce = (
    pattern: PlayablePattern,
    playOptions: WorkletPlayOptions
  ): WorkletPlayback => {
    if (closed) throw new Error('this output is closed');
    const data = collect(pattern, playOptions, 0);
    const token = (tokens += 1);
    let stopped = false;
    const posted = (async () => {
      // Nothing to wait for means no await: the pass is posted before play() returns, and a stop() is a cancel behind it.
      const pending = undecoded(data);
      if (pending.length > 0) await decode(pending);
      if (stopped || closed) return;
      const when = playOptions.when ?? context.currentTime + leadTime;
      postPass(data, token, Math.round(when * context.sampleRate));
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

  // `loop`: the pattern goes on from cycle to cycle, as the Web Audio `loop()` does. Pass k holds cycles k*cycles to
  // (k+1)*cycles, collected here with `startCycle` (so a pattern that changes from cycle to cycle, `<c3 e3 g3>`, keeps
  // changing), and posted to start at the frame the passes before it add up to: that frame is worked out from the pass number,
  // so the rounding never builds up. The worklet plays what it was given, so the main thread keeps it supplied: it posts passes
  // until they reach `LOOP_LOOKAHEAD` seconds past the context's clock, and looks again every `LOOP_POLL_MS`.
  const startLoop = (
    pattern: PlayablePattern,
    playOptions: WorkletPlayOptions
  ): WorkletPlayback => {
    if (closed) throw new Error('this output is closed');
    const cycles = playOptions.cycles ?? 1;
    const passFrames = cycles * cycleSeconds(playOptions) * context.sampleRate;
    const first = collect(pattern, playOptions, 0);
    // The tokens of the passes posted that may not have played out yet, so that stop() can cancel what is still waiting.
    const live: { token: number; end: number }[] = [{ token: (tokens += 1), end: Infinity }];
    let stopped = false;
    let base: number | undefined;
    let nextPass = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: { resolve(): void; reject(error: Error): void } | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const halted = () => stopped || closed;
    const tick = async (): Promise<void> => {
      timer = undefined;
      let made = 0;
      while (!halted() && made < LOOP_PASSES_PER_TICK) {
        const reach = (context.currentTime + LOOP_LOOKAHEAD) * context.sampleRate;
        if (base !== undefined && base + nextPass * passFrames >= reach) break;
        const pass = nextPass;
        nextPass += 1;
        made += 1;
        const data = pass === 0 ? first : collect(pattern, playOptions, pass * cycles);
        const pending = undecoded(data);
        if (pending.length > 0) await decode(pending);
        if (halted()) break;
        base ??= (playOptions.when ?? context.currentTime + leadTime) * context.sampleRate;
        const start = base + pass * passFrames;
        const entry = pass === 0 ? live[0] : { token: (tokens += 1), end: 0 };
        if (pass !== 0) live.push(entry);
        entry.end = start + passFrames;
        postPass(data, entry.token, Math.round(start));
        if (pass === 0) settle?.resolve();
      }
      // What has played out needs no cancel.
      const now = context.currentTime * context.sampleRate;
      for (let i = live.length - 1; i >= 0; i -= 1) if (live[i].end < now) live.splice(i, 1);
      if (!halted()) timer = setTimeout(poll, LOOP_POLL_MS);
    };
    const poll = (): void => {
      tick().catch((error: unknown) => {
        // A pass that cannot be collected or decoded ends the loop: what was posted plays out.
        stopped = true;
        const failure = error instanceof Error ? error : new Error(String(error));
        output.onerror?.(failure.message);
        settle?.reject(failure);
      });
    };
    ready.catch(() => undefined);
    poll();
    return {
      ready,
      stop() {
        if (stopped) return;
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        for (const { token } of live) post({ type: 'cancel', token });
        settle?.resolve();
      }
    };
  };

  return {
    node,
    sampleRate: context.sampleRate,
    channels,
    get timing() {
      return timing;
    },
    get timingNote() {
      return timingNote;
    },
    crossOriginIsolated:
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    module: kind,
    play: (pattern, playOptions = {}) => startOnce(pattern, playOptions),
    loop: (pattern, playOptions = {}) => startLoop(pattern, playOptions),
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
      spinner?.terminate();
      node.disconnect();
      node.port.onmessage = null;
      node.port.close?.();
    }
  };
}
