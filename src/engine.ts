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

/** Fills a pattern event's partial parameter patch out to a complete set of voice parameters. */
export function resolveParams(patch: ControlPatch): VoiceParams {
  return { ...DEFAULT_PARAMS, ...patch };
}

const DEFAULT_OSCILLATOR_FREQUENCY = 440;
const DEFAULT_SAMPLE_BASE_NOTE = 'c4'; // the pitch an unregistered-baseNote sample is assumed to sound at
const MAX_NOISE_BUFFER_SECONDS = 2; // longer gates loop the buffer instead of growing it
const SLIDE_START_MULTIPLIER = 2; // an octave above the target — matches a percussive downward "thunk"
const STOP_TAIL_SECONDS = 0.02; // headroom past the last ramp so the ramp actually completes before stop()
const DEFAULT_ORBIT = 0;
const PHASER_STAGE_COUNT = 4; // series allpass filters; more stages = deeper notches
const PHASER_CENTER_HZ = 1000;
const PHASER_DEPTH_HZ = 600; // how far the LFO swings each stage's frequency around the center

/**
 * Schedules an attack→decay→release envelope on an AudioParam, ramping between
 * `base` and `peak` rather than assuming 0 is the floor — gain envelopes use
 * base=0, filter envelopes use base=the resting cutoff. Without `gateEnd` the
 * shape is percussive (release starts as soon as the decay lands); with it,
 * the envelope holds at its sustain level until the gate closes, which is what
 * gives pattern events their note length. Returns the absolute time the
 * envelope finishes (fully released).
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
): number {
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

  return releaseEnd;
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
export function playVoice(ctx: AudioContextLike, params: VoiceParams, startTime: number): void {
  const usingSample = params.sampleName !== undefined;
  const sampleBuffer = usingSample
    ? getSampleBuffer(ctx, params.sampleName as string, params.sampleBank)
    : undefined;
  if (usingSample && sampleBuffer === undefined) {
    return;
  }

  // Clamp to the context's origin — real AudioParams/sources throw RangeError on negative times.
  const voiceStart = Math.max(startTime + params.nudgeTime, 0);
  // A gate is only meaningful when there is a sustain level to hold; with
  // sustain 0 the voice is silent after its decay, so holding (and keeping
  // the nodes alive for the whole event length) would be pure waste.
  const gateEnd =
    params.duration !== undefined && params.sustain > 0 ? voiceStart + params.duration : undefined;

  const gainNode = ctx.createGain();
  const gainReleaseEnd = scheduleEnvelope(
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
    );
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

  if (params.phaserRate !== undefined) {
    tail = connectPhaser(ctx, tail, params.phaserRate, voiceStart, voiceEnd);
  }

  tail.connect(gainNode);

  const finalNode = connectOutput(ctx, gainNode, params, voiceStart);
  connectEffectSends(ctx, finalNode, params, voiceStart);

  source.start(voiceStart);
  source.stop(voiceEnd);
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
  voiceEnd: number
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
  return tail;
}

/**
 * Sends the finished voice to its orbit's shared reverb/delay buses (see
 * effects.ts) when room/delay levels are set — post-placement, so the wet
 * signal follows pan/channels like the dry signal does. No sends, no orbit
 * bus lookup at all, when neither level is set.
 */
function connectEffectSends(
  ctx: AudioContextLike,
  finalNode: AudioNodeLike,
  params: VoiceParams,
  voiceStart: number
): void {
  const hasRoom = params.roomLevel !== undefined && params.roomLevel > 0;
  const hasDelay = params.delayLevel !== undefined && params.delayLevel > 0;
  if (!hasRoom && !hasDelay) {
    return;
  }

  const bus = getOrbitBus(ctx, params.orbit ?? DEFAULT_ORBIT);

  if (hasRoom) {
    bus.setRoomSize(params.roomSize);
    const send = ctx.createGain();
    send.gain.setValueAtTime(params.roomLevel as number, voiceStart);
    finalNode.connect(send);
    send.connect(bus.reverbInput);
  }

  if (hasDelay) {
    bus.setDelay(params.delayTime, params.delayFeedback);
    const send = ctx.createGain();
    send.gain.setValueAtTime(params.delayLevel as number, voiceStart);
    finalNode.connect(send);
    send.connect(bus.delayInput);
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
  gainNode: GainNodeLike,
  params: VoiceParams,
  voiceStart: number
): AudioNodeLike {
  const available = ctx.destination.channelCount ?? 2;
  let placement = params.channelGains?.slice(0, MAX_CHANNELS);
  if (placement !== undefined && placement.length === 0) {
    placement = undefined;
  }

  if (placement === undefined && params.pan !== undefined) {
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(params.pan, voiceStart);
    gainNode.connect(panner);
    panner.connect(ctx.destination);
    return panner;
  }

  if (placement === undefined) {
    if (available <= 2) {
      gainNode.connect(ctx.destination);
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
  merger.connect(ctx.destination);
  return merger;
}

/** Realizes every voice in a stack together, each offset by its own nudge time from `when`. */
export function playVoices(ctx: AudioContextLike, voicesParams: VoiceParams[], when: number): void {
  for (const params of voicesParams) {
    playVoice(ctx, params, when);
  }
}
