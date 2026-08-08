// Shared per-orbit effects buses: reverb and delay sends, lazily created per (context, orbit)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioBufferLike, AudioContextLike, GainNodeLike } from './types.js';

const ROOM_SIZE_MIN_SECONDS = 0.3;
const ROOM_SIZE_MAX_SECONDS = 4;
const ROOM_SIZE_REFERENCE_RANGE = 9; // roomSize 1..10 spans 9 units
const IR_CHANNELS = 2; // a per-channel IR decorrelates L/R for a wider tail than a mono one would
const IR_DECAY_FLOOR = 0.001; // the envelope reaches this fraction of full scale by the buffer's end
const DELAY_MAX_SECONDS = 5; // generous headroom past the ~0.1-0.35s the sample songs actually use

function roomSizeToSeconds(size: number): number {
  // The linear mapping only targets size in [1, 10]; below ~1.27 it
  // extrapolates past zero, which would collapse buildImpulseResponse() to a
  // degenerate near-empty buffer instead of a short room. Floor the output,
  // not just the input, so any size at or below that clamps to the shortest
  // documented room rather than going silent.
  const seconds =
    ROOM_SIZE_MIN_SECONDS +
    ((size - 1) * (ROOM_SIZE_MAX_SECONDS - ROOM_SIZE_MIN_SECONDS)) / ROOM_SIZE_REFERENCE_RANGE;
  return Math.max(seconds, ROOM_SIZE_MIN_SECONDS);
}

/**
 * Procedurally generates a synthetic reverb impulse response: exponentially-
 * decaying noise, the standard textbook algorithmic-reverb technique — not
 * derived from any sampled room or Strudel's own IR data.
 */
export function buildImpulseResponse(ctx: AudioContextLike, seconds: number): AudioBufferLike {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(IR_CHANNELS, length, ctx.sampleRate);
  const decayRate = -Math.log(IR_DECAY_FLOOR);
  for (let channel = 0; channel < IR_CHANNELS; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const envelope = Math.exp(-decayRate * (i / length));
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return buffer;
}

export interface OrbitBus {
  /** Send a voice's reverb-wet signal here. */
  readonly reverbInput: GainNodeLike;
  /** Send a voice's delay-wet signal here. */
  readonly delayInput: GainNodeLike;
  /** Regenerates the shared impulse response when `size` differs from what's already loaded. */
  setRoomSize(size: number): void;
  /** Updates the shared delay/feedback when they differ from what's already set. */
  setDelay(time: number, feedback: number): void;
}

interface MutableOrbitBus extends OrbitBus {
  lastRoomSize: number | undefined;
  lastDelayTime: number | undefined;
  lastDelayFeedback: number | undefined;
}

function createOrbitBus(ctx: AudioContextLike): MutableOrbitBus {
  const reverbInput = ctx.createGain();
  const convolver = ctx.createConvolver();
  reverbInput.connect(convolver);
  convolver.connect(ctx.destination);

  const delayInput = ctx.createGain();
  const delayNode = ctx.createDelay(DELAY_MAX_SECONDS);
  const delayOutput = ctx.createGain();
  const feedback = ctx.createGain();
  delayInput.connect(delayNode);
  delayNode.connect(delayOutput);
  delayOutput.connect(ctx.destination);
  delayNode.connect(feedback);
  feedback.connect(delayNode);

  const bus: MutableOrbitBus = {
    reverbInput,
    delayInput,
    lastRoomSize: undefined,
    lastDelayTime: undefined,
    lastDelayFeedback: undefined,
    setRoomSize(size) {
      // Regenerating the IR is real work — skip it when this orbit's room
      // size hasn't actually changed since the last voice that set it.
      if (bus.lastRoomSize === size) {
        return;
      }
      bus.lastRoomSize = size;
      convolver.buffer = buildImpulseResponse(ctx, roomSizeToSeconds(size));
    },
    setDelay(time, feedbackAmount) {
      if (bus.lastDelayTime !== time) {
        bus.lastDelayTime = time;
        delayNode.delayTime.setValueAtTime(time, ctx.currentTime);
      }
      if (bus.lastDelayFeedback !== feedbackAmount) {
        bus.lastDelayFeedback = feedbackAmount;
        feedback.gain.setValueAtTime(feedbackAmount, ctx.currentTime);
      }
    }
  };
  return bus;
}

const busesByContext = new WeakMap<AudioContextLike, Map<number, OrbitBus>>();

/**
 * The shared reverb/delay bus for one orbit number on `ctx`, created lazily on
 * first use. Every voice sending to the same (ctx, orbit) pair shares one
 * convolver and one delay line — the songs this was built for stack 15-20
 * simultaneous voices, and a convolver per voice would be unshippable.
 * setRoomSize()/setDelay() are last-writer-wins across every voice sharing the
 * orbit, which is exactly why a track gives each distinct room size its own
 * orbit number.
 */
export function getOrbitBus(ctx: AudioContextLike, orbit: number): OrbitBus {
  let busesForContext = busesByContext.get(ctx);
  if (!busesForContext) {
    busesForContext = new Map();
    busesByContext.set(ctx, busesForContext);
  }
  let bus = busesForContext.get(orbit);
  if (!bus) {
    bus = createOrbitBus(ctx);
    busesForContext.set(orbit, bus);
  }
  return bus;
}
