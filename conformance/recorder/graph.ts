// Layer 3: voices or a score booked on a recording context, written as the recorded node graph
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import {
  FakeAudioContext,
  FakeAudioParam,
  FakeAudioDestinationNode,
  FakeOfflineAudioContext,
  FakePeriodicWave
} from '../../src/test-utils/fakeAudioContext';
import type { AutomationCall } from '../../src/test-utils/fakeAudioContext';
import type { ControlPatch } from '../../src/types';
import type { RenderOptions } from '../../src/render';
import type { ScoreDefinition } from '../../src/score';
import { encodeValue, messageOf, nineDigits, nineDigitsText, programJson } from './format';
import type { CaseRecord, CorpusFile, Json } from './format';
import { build } from './programs';
import type { Program } from './interpret';
import type { Reference } from './reference';

/** What a layer 3 case does with its context before booking: the master bus and the channel count. */
export interface OutputSetup {
  /** `undefined`: voices go straight to the destination. `true` or an object: through `createMasterBus`. */
  master?: boolean | Record<string, unknown>;
  /** Output channels of the destination (default 2); more than two enables multichannel output. */
  channels?: number;
  /** The most channels the hardware offers (`maxChannelCount`); defaults to `channels`. */
  maxChannels?: number;
  /** Whether `enableMultichannel` is called on the context; defaults to `channels` being more than two. */
  multichannel?: boolean;
  /** Voices play through `createMonoFold`, which feeds the master bus when there is one. */
  monoFold?: boolean;
}

/** An instrument merged over a voice's patch, as `.voice(patch)` does: a preset by name, or an `fmVoice()` definition. */
export type Instrument =
  | { preset: 'glassBell' | 'roundBass' | 'softPad' | 'pluck' | 'lead' }
  | { fmVoice: Record<string, unknown> };

/**
 * A decoded sample registered before booking (`registerSample(name, { buffer, baseNote })`): the PCM a host
 * hands over, one array per channel. `before` is the index of the voice it is registered before (default 0, so
 * up front); a render case registers everything up front.
 */
export interface SampleSpec {
  name: string;
  sampleRate: number;
  channels: readonly (readonly number[])[];
  baseNote?: string | number;
  before?: number;
}

interface CaseBase {
  id: string;
  group: string;
  from: string;
  /** True for a case that records a 0.3.0 behaviour with every 0.4.0 option off (its graph equals 0.3.0's). */
  baseline?: boolean;
}

/** Voices booked directly on a realtime fake context: `patch` is a partial `VoiceParams`, `at` the start in seconds. */
export interface VoicesGraphCase extends CaseBase {
  kind: 'voices';
  voices: readonly {
    at: number;
    patch: ControlPatch;
    /** `.voice(patch)`: an instrument merged over the patch. */
    instrument?: Instrument;
    /** `.surround(angle)`: sets `channelGains` to `surroundGains(angle)`. */
    surround?: number;
  }[];
  output?: OutputSetup;
  /** The sample registry: what is registered, and when (see `SampleSpec`). */
  registry?: readonly SampleSpec[];
  /** Voice indices that `clearSamples()` is called before (ahead of that voice's registrations). */
  clearBefore?: readonly number[];
}

/** A program rendered offline on a recording context (the render options as JSON, without `context`). */
export interface RenderGraphCase extends CaseBase {
  kind: 'render';
  program: Program;
  render: Omit<RenderOptions, 'context'>;
  /** The sample registry, all registered before the render starts. */
  registry?: readonly SampleSpec[];
}

/**
 * A `score()` rendered offline on a recording context: the definition and the render options as JSON. The score
 * sets its own tempo, so the options leave out `bpm`, `cps`, and `seconds`.
 */
export interface ScoreGraphCase extends CaseBase {
  kind: 'score';
  definition: ScoreDefinition;
  render: Omit<RenderOptions, 'context' | 'bpm' | 'cps' | 'seconds'>;
}

export type GraphCase = VoicesGraphCase | RenderGraphCase | ScoreGraphCase;

/** The groups of layer 3, in file order. */
export const LAYER3_GROUPS = [
  'placement',
  'voices',
  'options',
  'instruments',
  'channels',
  'score',
  'samples'
] as const;

const CREATORS = [
  ['createOscillator', 'oscillator'],
  ['createGain', 'gain'],
  ['createBiquadFilter', 'filter'],
  ['createStereoPanner', 'panner'],
  ['createChannelMerger', 'merger'],
  ['createBufferSource', 'bufferSource'],
  ['createConvolver', 'convolver'],
  ['createDelay', 'delay'],
  ['createDynamicsCompressor', 'compressor'],
  ['createWaveShaper', 'waveShaper']
] as const;

type NodeRecord = object & {
  connections?: { node: unknown; output: number; input: number }[];
  disconnectCount?: number;
  started?: number[];
  stopped?: number[];
  bufferHistory?: { time: number; buffer: unknown }[];
};

/** Wraps a context so every node it makes is kept in creation order (the destination is `n0`). */
export function track(ctx: FakeAudioContext): { kind: string; node: NodeRecord }[] {
  const created: { kind: string; node: NodeRecord }[] = [
    { kind: 'destination', node: ctx.destination }
  ];
  const target = ctx as unknown as Record<string, (...args: unknown[]) => object>;
  for (const [method, kind] of CREATORS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = (...args: unknown[]) => {
      const node = original.apply(ctx, args);
      created.push({ kind, node });
      return node;
    };
  }
  return created;
}

function callText(call: AutomationCall): string {
  const at = nineDigitsText(call.time);
  switch (call.method) {
    case 'setValueAtTime':
      return `set ${nineDigitsText(call.value)} @${at}`;
    case 'linearRampToValueAtTime':
      return `lin ${nineDigitsText(call.value)} @${at}`;
    case 'exponentialRampToValueAtTime':
      return `exp ${nineDigitsText(call.value)} @${at}`;
    case 'cancelScheduledValues':
      return `cancel @${at}`;
    case 'setTargetAtTime':
      return `target ${nineDigitsText(call.value)} @${at} tau ${nineDigitsText(call.timeConstant)}`;
  }
}

/** What the recorder reads of a rendered or created buffer. */
interface BufferData {
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

function isBuffer(value: unknown): value is BufferData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getChannelData' in value &&
    'numberOfChannels' in value
  );
}

/** The summary of one channel: root mean square, peak, and the first four samples (nine digits). */
function summarise(samples: ArrayLike<number>): Json {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  return {
    rms: nineDigits(samples.length === 0 ? 0 : Math.sqrt(sum / samples.length)),
    peak: nineDigits(peak),
    head: Array.from({ length: Math.min(4, samples.length) }, (_, i) => nineDigits(samples[i]))
  };
}

/** Turns the nodes a context made into the layer 3 `graph` object. */
export function describeGraph(
  ctx: FakeAudioContext,
  created: { kind: string; node: NodeRecord }[],
  length: number | null
): Json {
  const names = new Map<unknown, string>();
  created.forEach(({ node }, index) => {
    names.set(node, `n${index}`);
    for (const [key, value] of Object.entries(node)) {
      if (value instanceof FakeAudioParam) names.set(value, `n${index}.${key}`);
    }
  });
  const buffers = new Map<unknown, string>();
  const bufferList: Json[] = [];
  const bufferId = (value: BufferData | Float32Array): string => {
    const known = buffers.get(value);
    if (known !== undefined) return known;
    const id = `b${buffers.size}`;
    buffers.set(value, id);
    if (value instanceof Float32Array) {
      bufferList.push({ id, kind: 'curve', length: value.length, channels: [summarise(value)] });
    } else {
      bufferList.push({
        id,
        kind: 'audio',
        length: value.length,
        sampleRate: value.sampleRate,
        channels: Array.from({ length: value.numberOfChannels }, (_, c) =>
          summarise(value.getChannelData(c))
        )
      });
    }
    return id;
  };
  const waves = new Map<unknown, string>();
  const waveList: Json[] = [];
  const waveId = (wave: FakePeriodicWave): string => {
    const known = waves.get(wave);
    if (known !== undefined) return known;
    const id = `w${waves.size}`;
    waves.set(wave, id);
    waveList.push({
      id,
      real: Array.from(wave.real, (v) => nineDigits(v)),
      imag: Array.from(wave.imag, (v) => nineDigits(v)),
      disableNormalization: wave.constraints?.disableNormalization ?? false
    });
    return id;
  };

  const counts: Record<string, Json> = {};
  const nodes: Json[] = created.map(({ kind, node }, index) => {
    counts[kind] = ((counts[kind] as number | undefined) ?? 0) + 1;
    const defaults = fresh(kind, node);
    const fields: Record<string, Json> = {};
    const params: Record<string, Json> = {};
    for (const [key, value] of Object.entries(node)) {
      if (SKIPPED_FIELDS.has(key) || typeof value === 'function') continue;
      if (value instanceof FakeAudioParam) {
        if (value.calls.length > 0) params[key] = value.calls.map(callText);
        continue;
      }
      if (value instanceof FakePeriodicWave) {
        fields.wave = waveId(value);
        continue;
      }
      if (value instanceof Float32Array) {
        fields[key] = bufferId(value);
        continue;
      }
      if (isBuffer(value)) {
        fields[key] = bufferId(value);
        continue;
      }
      if (value === null || value === undefined) continue;
      const fallback = (defaults as Record<string, unknown> | undefined)?.[key];
      if (JSON.stringify(encodeValue(value)) === JSON.stringify(encodeValue(fallback))) continue;
      fields[key] = encodeValue(value);
    }
    const record: Record<string, Json> = { id: `n${index}`, kind };
    if (Object.keys(fields).length > 0) record.fields = fields;
    if (Object.keys(params).length > 0) record.params = params;
    if (node.started?.length) record.start = node.started.map((t) => nineDigits(t));
    if (node.stopped?.length) record.stop = node.stopped.map((t) => nineDigits(t));
    if (node.bufferHistory?.length) {
      // What is heard from each time on: the last impulse response given at that time.
      const first = node.bufferHistory[0].time;
      const heard = new Map<number | 'first', string | null>();
      for (const { time, buffer } of node.bufferHistory) {
        heard.set(time === first ? 'first' : time, isBuffer(buffer) ? bufferId(buffer) : null);
      }
      record.heard = [...heard].map(([time, id]) => [
        time === 'first' ? time : nineDigits(time),
        id
      ]);
    }
    if (node.disconnectCount) record.disconnects = node.disconnectCount;
    const to = (node.connections ?? []).map(({ node: target, output, input }) => {
      const name = names.get(target) ?? 'unknown';
      return output === 0 && input === 0 ? name : `${name} out ${output} in ${input}`;
    });
    if (to.length > 0) record.to = to;
    return record;
  });

  // Waves created but never given to an oscillator are still part of what the engine did.
  for (const wave of ctx.periodicWaves) waveId(wave);

  return {
    sampleRate: ctx.sampleRate,
    length,
    channels: ctx.destination.channelCount,
    counts: { ...counts, total: created.length },
    nodes,
    buffers: bufferList,
    waves: waveList
  };
}

/** Fields of a fake node that are bookkeeping, not part of the graph. */
const SKIPPED_FIELDS = new Set([
  'connectedTo',
  'connections',
  'disconnectCount',
  'started',
  'stopped',
  'strictTimes',
  'bufferHistory',
  'current',
  'clock',
  'maxChannelCount'
]);

/** A fresh node of the same class, whose fields are the defaults a recorded node is compared with. */
function fresh(kind: string, node: NodeRecord): object | undefined {
  if (kind === 'destination') return new FakeAudioDestinationNode();
  const Constructor = node.constructor as new (inputs?: number) => object;
  const inputs = (node as { numberOfInputs?: number }).numberOfInputs;
  try {
    return new Constructor(inputs);
  } catch {
    return undefined;
  }
}

/**
 * The onsets a render books, in booking order: each cycle's `collectOnsets`, as `renderToBuffer` collects them
 * (a case with `seconds` drops onsets at or after it). Needs no audio, so the layer 4 files use it too.
 */
export function renderOnsets(
  ref: Reference,
  pattern: unknown,
  render: Omit<RenderOptions, 'context'>
): { at: number; patch: unknown }[] {
  const cycleSeconds = ref.scheduler.cycleSecondsFor(render.bpm, render.cps);
  const cycles = render.cycles ?? Math.ceil((render.seconds ?? cycleSeconds) / cycleSeconds);
  const voices: { at: number; patch: unknown }[] = [];
  for (let k = 0; k < cycles; k++) {
    const span = { begin: new ref.lib.Fraction(k), end: new ref.lib.Fraction(k + 1) };
    for (const voice of ref.scheduler.collectOnsets(
      pattern as never,
      span,
      0,
      cycleSeconds,
      render.gated ?? true
    )) {
      if (render.seconds === undefined || voice.startTime < render.seconds) {
        voices.push({ at: voice.startTime, patch: voice.params });
      }
    }
  }
  return voices;
}

/** The score text: one line per voice, `v<k> @<seconds> <json of the patch>`. */
export function scoreLines(voices: readonly { at: number; patch: unknown }[]): string[] {
  return voices.map(
    (voice, index) =>
      `v${index} @${nineDigitsText(voice.at)} ${JSON.stringify(encodeValue(voice.patch))}`
  );
}

function configure(ref: Reference, ctx: FakeAudioContext, setup: OutputSetup | undefined): void {
  const { channels, maxChannels, multichannel } = setup ?? {};
  if (channels !== undefined && channels !== 2) ctx.destination.channelCount = channels;
  const max = maxChannels ?? channels;
  if (max !== undefined && max !== 2) ctx.destination.maxChannelCount = max;
  if (multichannel ?? (channels !== undefined && channels > 2)) {
    ref.lib.enableMultichannel(ctx as never);
  }
}

/** The patch an instrument gives: a preset's, or the conversion of an `fmVoice()` definition. */
function instrumentPatch(ref: Reference, instrument: Instrument): ControlPatch {
  if ('preset' in instrument) return { ...ref.lib.fmPresets[instrument.preset] };
  return ref.lib.fmVoice(instrument.fmVoice);
}

/** Registers a decoded sample in the reference's registry, as a host that has decoded it would. */
function registerDecoded(ref: Reference, make: FakeAudioContext, sample: SampleSpec): void {
  const length = sample.channels[0]?.length ?? 0;
  const buffer = make.createBuffer(sample.channels.length, length, sample.sampleRate);
  sample.channels.forEach((values, channel) => {
    buffer.getChannelData(channel).set(Float32Array.from(values));
  });
  ref.lib.registerSample(sample.name, {
    buffer,
    ...(sample.baseNote === undefined ? {} : { baseNote: sample.baseNote })
  });
}

/** Books a voices case on a fresh recording context and describes its graph. */
function recordVoicesCase(ref: Reference, spec: VoicesGraphCase): CaseRecord {
  const ctx = new FakeAudioContext();
  const created = track(ctx);
  // Noise and reverb draw from the context's seeded source, as a render does (seed 0).
  ref.random.seedContext(ctx as never, 0);
  configure(ref, ctx, spec.output);
  let output: unknown;
  const master = spec.output?.master;
  if (master !== undefined && master !== false) {
    const bus = ref.lib.createMasterBus(
      ctx as never,
      master === true ? {} : (master as Record<string, never>)
    );
    output = bus.input;
  }
  if (spec.output?.monoFold) {
    output = ref.lib.createMonoFold(ctx as never, (output ?? ctx.destination) as never);
  }
  // `.voice(patch)`: the instrument's fields overwrite the note's, and the score keeps what was booked.
  const voices = spec.voices.map((voice) => ({
    at: voice.at,
    patch: {
      ...voice.patch,
      ...(voice.instrument === undefined ? {} : instrumentPatch(ref, voice.instrument)),
      ...(voice.surround === undefined
        ? {}
        : { channelGains: ref.lib.surroundGains(voice.surround) })
    }
  }));
  const registry = spec.registry ?? [];
  voices.forEach((voice, index) => {
    if (spec.clearBefore?.includes(index)) ref.lib.clearSamples();
    for (const sample of registry) {
      if ((sample.before ?? 0) === index) registerDecoded(ref, ctx, sample);
    }
    ref.engine.playVoice(ctx as never, ref.engine.resolveParams(voice.patch), voice.at, {
      output: output as never
    });
  });
  return {
    ...head(spec),
    ...(spec.output === undefined ? {} : { output: spec.output as Json }),
    ...(spec.registry === undefined ? {} : { registry: encodeValue(spec.registry) }),
    ...(spec.clearBefore === undefined ? {} : { clearBefore: [...spec.clearBefore] }),
    score: scoreLines(voices),
    graph: describeGraph(ctx, created, null)
  };
}

function head(spec: GraphCase): CaseRecord {
  return {
    id: spec.id,
    group: spec.group,
    from: spec.from,
    ...(spec.baseline ? { baseline: true } : {})
  };
}

/** Renders a program offline on a recording context and describes its graph. */
async function recordRenderCase(ref: Reference, spec: RenderGraphCase): Promise<CaseRecord> {
  const built = build(ref, spec.program);
  if ('error' in built)
    return { ...head(spec), program: programJson(spec.program), error: built.error };
  let context: FakeOfflineAudioContext | undefined;
  let created: { kind: string; node: NodeRecord }[] = [];
  const options: RenderOptions = {
    ...spec.render,
    context: (init) => {
      context = new FakeOfflineAudioContext(init);
      created = track(context);
      return context as never;
    }
  };
  const scratch = new FakeAudioContext();
  for (const sample of spec.registry ?? []) registerDecoded(ref, scratch, sample);
  await ref.lib.renderToBuffer(built.pattern as never, options);
  if (context === undefined) throw new Error(`${spec.id}: the render made no context`);
  const voices = renderOnsets(ref, built.pattern, spec.render);
  return {
    ...head(spec),
    program: programJson(spec.program),
    render: encodeValue(spec.render),
    ...(spec.registry === undefined ? {} : { registry: encodeValue(spec.registry) }),
    score: scoreLines(voices),
    graph: describeGraph(context, created, context.length)
  };
}

/**
 * Renders a score offline on a recording context and describes its graph. The case keeps the definition and
 * the options even when the score throws, so a runner can reproduce the message; a case that books keeps the
 * score's `cps` and `seconds` and the onsets the render booked.
 */
async function recordScoreCase(ref: Reference, spec: ScoreGraphCase): Promise<CaseRecord> {
  const inputs = { definition: encodeValue(spec.definition), render: encodeValue(spec.render) };
  try {
    const cue = ref.lib.score(spec.definition);
    let context: FakeOfflineAudioContext | undefined;
    let created: { kind: string; node: NodeRecord }[] = [];
    await cue.render({
      ...spec.render,
      context: (init) => {
        context = new FakeOfflineAudioContext(init);
        created = track(context);
        return context as never;
      }
    });
    if (context === undefined) throw new Error(`${spec.id}: the render made no context`);
    const cycleSeconds = ref.scheduler.cycleSecondsFor(undefined, cue.cps);
    const voices: { at: number; patch: unknown }[] = [];
    for (let k = 0; k < (spec.render.cycles ?? 1); k++) {
      const span = { begin: new ref.lib.Fraction(k), end: new ref.lib.Fraction(k + 1) };
      for (const voice of ref.scheduler.collectOnsets(
        cue.pattern as never,
        span,
        0,
        cycleSeconds,
        spec.render.gated ?? true
      )) {
        voices.push({ at: voice.startTime, patch: voice.params });
      }
    }
    return {
      ...head(spec),
      ...inputs,
      cps: cue.cps,
      seconds: cue.seconds,
      score: scoreLines(voices),
      graph: describeGraph(context, created, context.length)
    };
  } catch (error) {
    return { ...head(spec), ...inputs, error: messageOf(error) };
  }
}

/** Records one layer 3 case; a case whose booking throws records the message. */
export async function recordGraphCase(ref: Reference, spec: GraphCase): Promise<CaseRecord> {
  // The reference's registry is process-wide: every case starts and ends with it empty.
  ref.lib.clearSamples();
  try {
    if (spec.kind === 'score') return await recordScoreCase(ref, spec);
    return spec.kind === 'voices' ? recordVoicesCase(ref, spec) : await recordRenderCase(ref, spec);
  } catch (error) {
    return { ...head(spec), error: messageOf(error) };
  } finally {
    ref.lib.clearSamples();
  }
}

/** Records every layer 3 file of the first subset. */
export async function recordLayer3(
  ref: Reference,
  cases: readonly GraphCase[]
): Promise<CorpusFile[]> {
  const files: CorpusFile[] = [];
  for (const group of LAYER3_GROUPS) {
    const records: CaseRecord[] = [];
    for (const spec of cases.filter((candidate) => candidate.group === group)) {
      records.push(await recordGraphCase(ref, spec));
    }
    files.push({ layer: 3, group, cases: records });
  }
  return files;
}
