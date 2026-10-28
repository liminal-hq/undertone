// Realizes voice parameters as an actual Web Audio node graph with scheduled envelopes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type {
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  ControlPatch,
  GainNodeLike,
  VoiceParams
} from './types.js';
import { getOrbitBus } from './effects.js';
import { noteToFrequency } from './pitch.js';
import { buildNoiseBuffer } from './noise.js';
import { getSampleBaseNote, getSampleBuffer } from './samples.js';
import { foldChannelGains, MAX_CHANNELS } from './surround.js';

const DEFAULT_PARAMS: VoiceParams = {
  soundType: 'sine',
  pitch: undefined,
  sampleName: undefined,
  sampleBank: undefined,
  gainLevel: 0.8,
  attack: 0.01,
  decay: 0.1,
  sustain: 0,
  release: 0.05,
  filterCutoff: undefined,
  filterEnvAmount: 0,
  filterAttack: 0,
  filterDecay: 0,
  filterSustain: 1,
  filterRelease: 0,
  hpfCutoff: undefined,
  phaserRate: undefined,
  roomLevel: undefined,
  roomSize: 3,
  delayLevel: undefined,
  delayTime: 0.3,
  delayFeedback: 0.35,
  orbit: undefined,
  slideTime: 0,
  nudgeTime: 0
};

// A sample recording is a fixed-length take, not a synth waveform shaped by
// its own envelope — the percussive sustain:0 default (silent by ~0.16s
// regardless of the buffer's actual length) is right for one-shot SFX but
// wrong for "play the sample". Sample voices default to holding instead, so
// a gated loop() event lets the recording ring for its full pattern-derived
// length; an ungated one-shot play() still releases right after decay either
// way (only a gate creates a hold plateau at all), so playing a sample
// through with .play() still needs an explicit .sustain()/.release() — noted
// in the README.
const SAMPLE_DEFAULT_SUSTAIN = 1;

/** Fills a pattern event's partial parameter patch out to a complete set of voice parameters. */
export function resolveParams(patch: ControlPatch): VoiceParams {
  const resolved = { ...DEFAULT_PARAMS, ...patch };
  if (patch.sampleName !== undefined && patch.sustain === undefined) {
    resolved.sustain = SAMPLE_DEFAULT_SUSTAIN;
  }
  return resolved;
}

const DEFAULT_OSCILLATOR_FREQUENCY = 440;
const DEFAULT_SAMPLE_BASE_NOTE = 'c4'; // the pitch an unregistered-baseNote sample is assumed to sound at
const MAX_NOISE_BUFFER_SECONDS = 2; // longer gates loop the buffer instead of growing it
const SLIDE_START_MULTIPLIER = 2; // an octave above the target — matches a percussive downward "thunk"
const STOP_TAIL_SECONDS = 0.02; // headroom past the last ramp so the ramp actually completes before stop()
const DEFAULT_ORBIT = 0;
const PHASER_STAGE_COUNT = 4; // series allpass filters; more stages = deeper notches
const PHASER_CENTER_HZ = 1000;
const PHASER_DEPTH_HZ = 600; // how far the LFO swings each stage's frequency around the centre
const DEFAULT_STOP_FADE_SECONDS = 0.01; // short enough to feel immediate, long enough to avoid a click
const STOP_FADE_TIME_CONSTANTS = 5; // setTargetAtTime reaches ~99% of the way after five time constants

/** Options for stopping a playing voice (or a whole playback) early. */
export interface StopOptions {
  /** Fade-out length in seconds before the voice is silent. Default 0.01. */
  fade?: number;
}

/**
 * Returned by play(), playVoices() and playParams(): the scheduled voices'
 * time window, and a way to stop them early. Safe to call stop() any number
 * of times, before or after the voices have started or finished.
 */
export interface PlaybackHandle {
  /** Earliest start time of any voice in this playback, on the context's clock. */
  readonly startTime: number;
  /** Latest time any voice in this playback is still sounding (after its release), on the context's clock. */
  readonly endTime: number;
  /**
   * Stops every voice at `when` (default: now) with a short fade. Voices that
   * have not started yet never sound; voices that already finished are
   * untouched. Without `cancelScheduledValues` on the context's params the
   * voice is cut hard instead of faded.
   */
  stop(when?: number, options?: StopOptions): void;
}

/** Where a voice's output lands, and options shared by every way of playing voices. */
export interface OutputOptions {
  /** Node the voices (and their effects buses) connect to instead of `ctx.destination`, e.g. a game's own mix bus. */
  output?: AudioNodeLike;
}

interface Stoppable {
  stop(when?: number): void;
}

/** Combines several playbacks into one handle covering all of them. */
export function combineHandles(handles: readonly PlaybackHandle[]): PlaybackHandle {
  if (handles.length === 1) {
    return handles[0];
  }
  return {
    startTime: handles.length > 0 ? Math.min(...handles.map((h) => h.startTime)) : 0,
    endTime: handles.length > 0 ? Math.max(...handles.map((h) => h.endTime)) : 0,
    stop(when, options) {
      for (const handle of handles) {
        handle.stop(when, options);
      }
    }
  };
}

/** What scheduleEnvelope() reports back: when the envelope finishes, and its level at any moment. */
interface EnvelopeShape {
  /** Absolute time the envelope finishes (fully released). */
  end: number;
  /** The level the scheduled automation is at, `t` seconds on the context's clock. */
  valueAt(t: number): number;
}

/**
 * Schedules an attack→decay→release envelope on an AudioParam, ramping between
 * `base` and `peak` rather than assuming 0 is the floor — gain envelopes use
 * base=0, filter envelopes use base=the resting cutoff. Without `gateEnd` the
 * shape is percussive (release starts as soon as the decay lands); with it,
 * the envelope holds at its sustain level until the gate closes, which is what
 * gives pattern events their note length. Returns the absolute time the
 * envelope finishes (fully released) plus a function that evaluates the shape,
 * so a stopped voice can fade from wherever its envelope actually is.
 */
function scheduleEnvelope(
  param: AudioParamLike,
  startTime: number,
  base: number,
  peak: number,
  attack: number,
  decay: number,
  sustainFraction: number,
  release: number,
  gateEnd?: number
): EnvelopeShape {
  const sustainValue = base + (peak - base) * sustainFraction;

  param.setValueAtTime(base, startTime);

  const attackEnd = startTime + attack;
  if (attack > 0) {
    param.linearRampToValueAtTime(peak, attackEnd);
  } else {
    param.setValueAtTime(peak, startTime);
  }

  const decayEnd = attackEnd + decay;
  if (decay > 0) {
    param.linearRampToValueAtTime(sustainValue, decayEnd);
  } else {
    param.setValueAtTime(sustainValue, decayEnd);
  }

  const releaseStart = gateEnd !== undefined ? Math.max(decayEnd, gateEnd) : decayEnd;
  if (releaseStart > decayEnd) {
    param.setValueAtTime(sustainValue, releaseStart);
  }

  const releaseEnd = releaseStart + release;
  if (release > 0) {
    param.linearRampToValueAtTime(base, releaseEnd);
  }

  const lerp = (from: number, to: number, t: number, t0: number, t1: number): number =>
    from + ((to - from) * (t - t0)) / (t1 - t0);

  return {
    end: releaseEnd,
    valueAt(t) {
      if (t <= startTime) return base;
      if (t < attackEnd) return lerp(base, peak, t, startTime, attackEnd);
      if (t < decayEnd) return lerp(peak, sustainValue, t, attackEnd, decayEnd);
      if (t < releaseStart) return sustainValue;
      if (release > 0 && t < releaseEnd)
        return lerp(sustainValue, base, t, releaseStart, releaseEnd);
      return release > 0 ? base : sustainValue;
    }
  };
}

function isNoiseType(soundType: VoiceParams['soundType']): soundType is 'white' | 'pink' | 'brown' {
  return soundType === 'white' || soundType === 'pink' || soundType === 'brown';
}

/**
 * Realizes a single voice against a real (or fake, for tests) AudioContext,
 * starting at `startTime`. A sample voice whose buffer isn't decoded yet (or
 * whose name was never registered) is silently skipped — samples.ts already
 * warns once per name; call loadSamples() up front to avoid skipped voices on
 * the first play.
 */
export function playVoice(
  ctx: AudioContextLike,
  params: VoiceParams,
  startTime: number,
  options: OutputOptions = {}
): PlaybackHandle {
  const output = options.output ?? ctx.destination;
  const usingSample = params.sampleName !== undefined;
  const sampleBuffer = usingSample
    ? getSampleBuffer(ctx, params.sampleName as string, params.sampleBank)
    : undefined;
  if (usingSample && sampleBuffer === undefined) {
    const skippedAt = Math.max(startTime + params.nudgeTime, 0);
    return { startTime: skippedAt, endTime: skippedAt, stop: () => undefined };
  }

  // Clamp to the context's origin — real AudioParams/sources throw RangeError on negative times.
  const voiceStart = Math.max(startTime + params.nudgeTime, 0);
  // A gate is only meaningful when there is a sustain level to hold; with
  // sustain 0 the voice is silent after its decay, so holding (and keeping
  // the nodes alive for the whole event length) would be pure waste.
  const gateEnd =
    params.duration !== undefined && params.sustain > 0 ? voiceStart + params.duration : undefined;

  const gainNode = ctx.createGain();
  const gainEnvelope = scheduleEnvelope(
    gainNode.gain,
    voiceStart,
    0,
    params.gainLevel,
    params.attack,
    params.decay,
    params.sustain,
    params.release,
    gateEnd
  );
  const gainReleaseEnd = gainEnvelope.end;

  let filterReleaseEnd = gainReleaseEnd;

  const source =
    usingSample || isNoiseType(params.soundType)
      ? ctx.createBufferSource()
      : ctx.createOscillator();

  if (usingSample) {
    const bufferSource = source as ReturnType<AudioContextLike['createBufferSource']>;
    bufferSource.buffer = sampleBuffer as NonNullable<typeof sampleBuffer>;
    const baseNote =
      getSampleBaseNote(params.sampleName as string, params.sampleBank) ?? DEFAULT_SAMPLE_BASE_NOTE;
    const rate =
      params.pitch !== undefined ? noteToFrequency(params.pitch) / noteToFrequency(baseNote) : 1;
    bufferSource.playbackRate.setValueAtTime(rate, voiceStart);
  } else if (isNoiseType(params.soundType)) {
    const bufferSource = source as ReturnType<AudioContextLike['createBufferSource']>;
    // Cap the synchronously-generated buffer and loop it for longer gates —
    // otherwise a slow looped noise pattern would allocate multi-second
    // buffers on the main thread every cycle.
    const audibleSeconds = Math.max(gainReleaseEnd - voiceStart, 0.05);
    const bufferDuration = Math.min(audibleSeconds, MAX_NOISE_BUFFER_SECONDS);
    bufferSource.buffer = buildNoiseBuffer(ctx, params.soundType, bufferDuration);
    bufferSource.loop = audibleSeconds > bufferDuration;
  } else {
    const oscillator = source as ReturnType<AudioContextLike['createOscillator']>;
    oscillator.type = params.soundType;
    const targetFreq =
      params.pitch !== undefined ? noteToFrequency(params.pitch) : DEFAULT_OSCILLATOR_FREQUENCY;
    if (params.slideTime > 0) {
      oscillator.frequency.setValueAtTime(targetFreq * SLIDE_START_MULTIPLIER, voiceStart);
      oscillator.frequency.exponentialRampToValueAtTime(targetFreq, voiceStart + params.slideTime);
    } else {
      oscillator.frequency.setValueAtTime(targetFreq, voiceStart);
    }
  }

  let tail: AudioNodeLike = source;

  if (params.filterCutoff !== undefined) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filterReleaseEnd = scheduleEnvelope(
      filter.frequency,
      voiceStart,
      params.filterCutoff,
      params.filterCutoff + params.filterEnvAmount,
      params.filterAttack,
      params.filterDecay,
      params.filterSustain,
      params.filterRelease,
      gateEnd
    ).end;
    tail.connect(filter);
    tail = filter;
  }

  // Neither insert below has its own envelope, so filterReleaseEnd is already
  // final here — safe to compute voiceEnd now and reuse it for the phaser's
  // LFO stop time as well as the source's own stop() at the end.
  const voiceEnd = Math.max(gainReleaseEnd, filterReleaseEnd) + STOP_TAIL_SECONDS;

  if (params.hpfCutoff !== undefined) {
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.setValueAtTime(params.hpfCutoff, voiceStart);
    tail.connect(hpf);
    tail = hpf;
  }

  const stoppables: Stoppable[] = [source];
  if (params.phaserRate !== undefined) {
    tail = connectPhaser(ctx, tail, params.phaserRate, voiceStart, voiceEnd, stoppables);
  }

  tail.connect(gainNode);

  const finalNode = connectOutput(ctx, output, gainNode, params, voiceStart);
  connectEffectSends(ctx, output, finalNode, params, voiceStart);

  source.start(voiceStart);
  source.stop(voiceEnd);

  return {
    startTime: voiceStart,
    endTime: voiceEnd,
    stop(when = ctx.currentTime, stopOptions = {}) {
      const stopAt = Math.max(when, 0);
      if (stopAt >= voiceEnd) {
        return;
      }
      const fade = Math.max(stopOptions.fade ?? DEFAULT_STOP_FADE_SECONDS, 0);
      const gain = gainNode.gain;
      let silentAt = stopAt;
      if (gain.cancelScheduledValues) {
        gain.cancelScheduledValues(stopAt);
        gain.setValueAtTime(gainEnvelope.valueAt(stopAt), stopAt);
        if (fade > 0 && gain.setTargetAtTime) {
          gain.setTargetAtTime(0, stopAt, fade / STOP_FADE_TIME_CONSTANTS);
          silentAt = stopAt + fade;
        } else if (fade > 0) {
          gain.linearRampToValueAtTime(0, stopAt + fade);
          silentAt = stopAt + fade;
        } else {
          gain.setValueAtTime(0, stopAt);
        }
      }
      // Calling stop() again on a source replaces the earlier stop time.
      for (const stoppable of stoppables) {
        stoppable.stop(Math.min(silentAt, voiceEnd));
      }
    }
  };
}

/**
 * Inserts a 4-stage series allpass phaser: one LFO drives every stage's
 * frequency together through a shared depth gain, so the notches sweep in
 * lockstep rather than independently. Returns the new tail to connect onward.
 */
function connectPhaser(
  ctx: AudioContextLike,
  input: AudioNodeLike,
  rateHz: number,
  voiceStart: number,
  voiceEnd: number,
  stoppables: Stoppable[]
): AudioNodeLike {
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.setValueAtTime(rateHz, voiceStart);

  const depth = ctx.createGain();
  depth.gain.setValueAtTime(PHASER_DEPTH_HZ, voiceStart);
  lfo.connect(depth);

  let tail = input;
  for (let i = 0; i < PHASER_STAGE_COUNT; i++) {
    const stage = ctx.createBiquadFilter();
    stage.type = 'allpass';
    stage.frequency.setValueAtTime(PHASER_CENTER_HZ, voiceStart);
    depth.connect(stage.frequency);
    tail.connect(stage);
    tail = stage;
  }

  lfo.start(voiceStart);
  lfo.stop(voiceEnd);
  stoppables.push(lfo);
  return tail;
}

/** Routes finalNode through a fresh send gain at `level`, into `target`. */
function connectSend(
  ctx: AudioContextLike,
  finalNode: AudioNodeLike,
  target: GainNodeLike,
  level: number,
  voiceStart: number
): void {
  const send = ctx.createGain();
  send.gain.setValueAtTime(level, voiceStart);
  finalNode.connect(send);
  send.connect(target);
}

/**
 * Sends the finished voice to its orbit's shared reverb/delay buses (see
 * effects.ts) when room/delay levels are set — post-placement, so the wet
 * signal follows pan/channels like the dry signal does. No sends, no orbit
 * bus lookup at all, when neither level is set.
 */
function connectEffectSends(
  ctx: AudioContextLike,
  output: AudioNodeLike,
  finalNode: AudioNodeLike,
  params: VoiceParams,
  voiceStart: number
): void {
  const hasRoom = params.roomLevel !== undefined && params.roomLevel > 0;
  const hasDelay = params.delayLevel !== undefined && params.delayLevel > 0;
  if (!hasRoom && !hasDelay) {
    return;
  }

  const bus = getOrbitBus(ctx, params.orbit ?? DEFAULT_ORBIT, output);

  if (hasRoom) {
    bus.setRoomSize(params.roomSize);
    connectSend(ctx, finalNode, bus.reverbInput, params.roomLevel as number, voiceStart);
  }

  if (hasDelay) {
    bus.setDelay(params.delayTime, params.delayFeedback);
    connectSend(ctx, finalNode, bus.delayInput, params.delayLevel as number, voiceStart);
  }
}

/**
 * Routes the enveloped voice to the destination: through per-speaker gains
 * into a channel merger when channelGains is set (folded down as far as the
 * destination requires), through a stereo panner when pan is set, or straight
 * through otherwise. On a destination widened by enableMultichannel(), the
 * plain path also goes through a two-channel merger — a bare mono connect
 * would land in the front-left speaker only under discrete interpretation.
 */
function connectOutput(
  ctx: AudioContextLike,
  output: AudioNodeLike,
  gainNode: GainNodeLike,
  params: VoiceParams,
  voiceStart: number
): AudioNodeLike {
  const available = (output as { channelCount?: number }).channelCount ?? 2;
  let placement = params.channelGains?.slice(0, MAX_CHANNELS);
  if (placement !== undefined && placement.length === 0) {
    placement = undefined;
  }

  if (placement === undefined && params.pan !== undefined) {
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(params.pan, voiceStart);
    gainNode.connect(panner);
    panner.connect(output);
    return panner;
  }

  if (placement === undefined) {
    if (available <= 2) {
      gainNode.connect(output);
      return gainNode;
    }
    placement = [1, 1]; // centred stereo image, matching the spec's mono->stereo up-mix
  }

  while (placement.length < 2) {
    placement.push(0); // a 1-channel merger would up-mix to both speakers, ignoring the placement
  }
  const gains = foldChannelGains(placement, available);
  const merger = ctx.createChannelMerger(gains.length);
  gains.forEach((level, channel) => {
    if (level > 0) {
      const channelGain = ctx.createGain();
      channelGain.gain.setValueAtTime(level, voiceStart);
      gainNode.connect(channelGain);
      channelGain.connect(merger, 0, channel);
    }
  });
  merger.connect(output);
  return merger;
}

/** Realizes every voice in a stack together, each offset by its own nudge time from `when`. */
export function playVoices(
  ctx: AudioContextLike,
  voicesParams: VoiceParams[],
  when: number,
  options: OutputOptions = {}
): PlaybackHandle {
  return combineHandles(voicesParams.map((params) => playVoice(ctx, params, when, options)));
}

/** Options for playParams(). */
export interface PlayParamsOptions extends OutputOptions {
  /** Absolute start time on the context's clock. Default: now. */
  when?: number;
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
  const when = options.when ?? ctx.currentTime;
  return combineHandles(
    voices.map((patch) => playVoice(ctx, resolveParams(patch), when, { output: options.output }))
  );
}
