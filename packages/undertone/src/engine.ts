// Playing voices and the Web Audio helpers on a caller's context: playParams, the master bus, the orbit buses, the mono fold
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type {
  MasterBus,
  MasterBusOptions,
  OrbitBus,
  OutputOptions,
  PlaybackHandle,
  PlayParamsOptions
} from './engineTypes.js';
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  ControlPatch,
  DynamicsCompressorNodeLike,
  GainNodeLike,
  VoiceParams,
  WaveShaperNodeLike
} from './types.js';
import { decodePending } from './samples.js';
import { warnOnce } from './warn.js';
import { backendOf, nodeId, run } from './webaudio.js';
import type { Backend } from './webaudio.js';
import type { WasmPlayback } from '../wasm/undertone_wasm.js';

/** A playback handle over the module's, stopping through the context's engine. */
export function playbackHandle(backend: Backend, playback: WasmPlayback): PlaybackHandle {
  return {
    startTime: playback.startTime,
    endTime: playback.endTime,
    stop(when, options) {
      run(backend, (engine) => playback.stop(engine, when, options?.fade));
    }
  };
}

/** Books on a context: decodes what the context has not yet (samples.ts), then calls into its engine. */
export function book<T>(ctx: AudioContextLike, call: (backend: Backend) => T): T {
  const backend = backendOf(ctx);
  decodePending(ctx);
  return call(backend);
}

/**
 * Plays plain voice data — an array of (partial) VoiceParams, e.g. loaded from
 * a save file or built by an in-game sound editor — with no patterns involved.
 * Missing fields take the same defaults as a pattern event; the returned
 * handle can stop every voice early.
 */
export function playParams(
  ctx: AudioContextLike,
  voices: readonly ControlPatch[],
  options: PlayParamsOptions = {}
): PlaybackHandle {
  return book(ctx, (backend) => {
    const output = nodeId(backend, options.output);
    const playback = run(backend, (engine) =>
      engine.playParams(voices as ControlPatch[], options.when, output)
    );
    return playbackHandle(backend, playback);
  });
}

/** One resolved voice at `startTime` (the reference's `playVoice`; `./testing` exports it). */
export function playVoice(
  ctx: AudioContextLike,
  params: VoiceParams,
  startTime: number,
  options: OutputOptions = {}
): PlaybackHandle {
  return book(ctx, (backend) => {
    const output = nodeId(backend, options.output);
    const playback = run(backend, (engine) => engine.playVoice(params, startTime, output));
    return playbackHandle(backend, playback);
  });
}

/** Several resolved voices together, each offset by its own nudge from `when` (the reference's `playVoices`; `./testing`). */
export function playVoices(
  ctx: AudioContextLike,
  voices: VoiceParams[],
  when: number,
  options: OutputOptions = {}
): PlaybackHandle {
  return book(ctx, (backend) => {
    const output = nodeId(backend, options.output);
    const playback = run(backend, (engine) => engine.playParams(voices, when, output));
    return playbackHandle(backend, playback);
  });
}

/** Seeds a context's noise and reverb randomness (`./testing`'s `seedContext`). */
export function seedContext(ctx: AudioContextLike, seed: number | string): void {
  backendOf(ctx).engine.seed(seed);
}

/**
 * Creates a master bus: voices play into `bus.input`, pass a gain stage and a
 * limiter, and reach `output` (the speakers by default). Undertone writes
 * straight to the destination otherwise, so a dense mix can peak near or above
 * full scale; routing it through this keeps it in range.
 *
 * Nothing is created until you call this, and it is an ordinary object you
 * hold, so a game with several mix groups can make one per group. The limiter
 * is skipped, with a warning, when the output has more than two channels (a
 * dynamics compressor only handles stereo, so it would collapse a surround
 * mix) or when the context has no `createDynamicsCompressor`; the gain stage
 * still works.
 */
export function createMasterBus(ctx: AudioContextLike, options: MasterBusOptions = {}): MasterBus {
  const backend = backendOf(ctx);
  const target = options.output ?? ctx.destination;
  // A context without the limiter's or the ceiling's node gets the bus without it, as 0.3 built it; the module would make
  // the node regardless, so the option is taken out here and the warning given after the module's checks have passed.
  const noCompressor =
    options.limiter !== false &&
    (target.channelCount ?? 2) <= 2 &&
    typeof ctx.createDynamicsCompressor !== 'function';
  const ceiling = options.ceiling;
  const noCeiling =
    ceiling !== undefined &&
    ceiling <= 0 &&
    ceiling !== -Infinity &&
    typeof ctx.createWaveShaper !== 'function';
  const bus = run(backend, (engine) =>
    engine.createMasterBus({
      ...options,
      output: nodeId(backend, options.output),
      limiter: noCompressor ? false : options.limiter,
      ceiling: noCeiling ? undefined : ceiling
    })
  ) as { input: number; compressor?: number; clipper?: number };
  if (noCompressor) {
    warnOnce(
      'master-bus-no-compressor',
      'undertone: this audio context has no createDynamicsCompressor(), so the master bus has no limiter.'
    );
  }
  if (noCeiling) {
    warnOnce(
      'master-bus-no-wave-shaper',
      'undertone: this audio context has no createWaveShaper(), so the master bus has no ceiling.'
    );
  }
  const { replayer } = backend;
  return {
    input: replayer.node<GainNodeLike>(bus.input),
    ...(bus.compressor !== undefined && {
      compressor: replayer.node<DynamicsCompressorNodeLike>(bus.compressor)
    }),
    ...(bus.clipper !== undefined && { clipper: replayer.node<WaveShaperNodeLike>(bus.clipper) })
  };
}

/**
 * A gain node that folds everything sent to it down to mono before passing it
 * to `output` (the speakers by default), the way a phone speaker or a mono
 * Bluetooth speaker plays a stereo mix. Pass its result as `output` to
 * `play()` or `loop()`, or in front of a master bus, to check that a
 * natively stereo cue still balances on one speaker.
 *
 * The fold-down is Web Audio's standard speakers down-mix, `0.5 × (L + R)`:
 * a centred voice (equal-power pan, left and right at about 0.707) keeps
 * its level, and a voice panned fully to one side drops by 6 dB.
 */
export function createMonoFold(ctx: AudioContextLike, output?: AudioNodeLike): GainNodeLike {
  const backend = backendOf(ctx);
  const id = run(backend, (engine) => engine.createMonoFold(nodeId(backend, output)));
  return backend.replayer.node<GainNodeLike>(id);
}

/**
 * Opts a context's destination into its full hardware channel count with
 * discrete channel interpretation, so channelGains address real speakers.
 * Call once, e.g. right after creating your AudioContext; without it (or on
 * plain stereo hardware) multichannel voices fold down to stereo instead.
 * Returns the resulting output channel count.
 */
export function enableMultichannel(ctx: AudioContextLike): number {
  // Done here, as 0.3 did it, so the hardware count is read when this is called (the engine reads the destination once); the
  // engine is told the new count before its next booking.
  const destination = ctx.destination;
  const max = destination.maxChannelCount ?? 0;
  if (max > 2) {
    destination.channelCount = Math.min(max, 8);
    destination.channelInterpretation = 'discrete';
  }
  return destination.channelCount ?? 2;
}

const busesByContext = new WeakMap<AudioContextLike, Map<AudioNodeLike, Map<number, OrbitBus>>>();

/**
 * The shared reverb/delay bus for one orbit number on `ctx`, created lazily on
 * first use. Every voice sending to the same (ctx, output, orbit) triple shares
 * one convolver and one delay line — the songs this was built for stack 15-20
 * simultaneous voices, and a convolver per voice would be unshippable.
 * setRoomSize()/setDelay() are last-writer-wins across every voice sharing the
 * orbit, which is exactly why a track gives each distinct room size its own
 * orbit number.
 *
 * `output` is where the bus's wet signal lands (default `ctx.destination`).
 * Buses are keyed by it too, so a game that plays through its own mix node
 * gets one bus per node, not a fresh convolver on every sound.
 */
export function getOrbitBus(
  ctx: AudioContextLike,
  orbit: number,
  output: AudioNodeLike = ctx.destination
): OrbitBus {
  let forContext = busesByContext.get(ctx);
  if (!forContext) {
    forContext = new Map();
    busesByContext.set(ctx, forContext);
  }
  let forOutput = forContext.get(output);
  if (!forOutput) {
    forOutput = new Map();
    forContext.set(output, forOutput);
  }
  let bus = forOutput.get(orbit);
  if (!bus) {
    const backend = backendOf(ctx);
    const id = nodeId(backend, output);
    const [reverb, delay] = run(backend, (engine) => engine.getOrbitBus(orbit, id));
    bus = {
      reverbInput: backend.replayer.node<GainNodeLike>(reverb),
      delayInput: backend.replayer.node<GainNodeLike>(delay),
      setRoomSize(size) {
        run(backend, (engine) => engine.setRoomSize(orbit, id, size));
      },
      setDelay(time, feedback, when) {
        run(backend, (engine) => engine.setDelay(orbit, id, time, feedback, when));
      }
    };
    forOutput.set(orbit, bus);
  }
  return bus;
}

/** A source of numbers uniform in [0, 1), such as `Math.random` or `seededRandom(seed)`. */
export type RandomSource = () => number;

const IR_CHANNELS = 2;
const IR_DECAY_FLOOR = 0.001;

/**
 * Procedurally generates a synthetic reverb impulse response: exponentially-
 * decaying noise, the standard textbook algorithmic-reverb technique — not
 * derived from any sampled room or Strudel's own IR data.
 */
export function buildImpulseResponse(
  ctx: AudioContextLike,
  seconds: number,
  random: RandomSource = Math.random
): AudioBufferLike {
  // The random source is a JavaScript function, which cannot cross into the module, so the buffer is filled here, as 0.3
  // filled it; `seededRandom` gives the module's numbers, so a seeded response equals the engine's own.
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(IR_CHANNELS, length, ctx.sampleRate);
  const decayRate = -Math.log(IR_DECAY_FLOOR);
  for (let channel = 0; channel < IR_CHANNELS; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const envelope = Math.exp(-decayRate * (i / length));
      data[i] = (random() * 2 - 1) * envelope;
    }
  }
  return buffer;
}
