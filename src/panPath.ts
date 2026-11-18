// Builds a voice's pan automation from a pan path, and cuts it short when the voice is stopped early
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioParamLike, PanPoint } from './types.js';

/** One automation step on a panner's `pan`: jump to (`set`) or ramp linearly to (`ramp`) `value` at `time`. */
export interface PanEvent {
  kind: 'set' | 'ramp';
  /** Stereo position, -1 to 1. */
  value: number;
  /** Absolute time on the context's clock. */
  time: number;
}

function clampPan(pan: number): number {
  return Math.max(-1, Math.min(1, pan));
}

/**
 * The pan automation for one voice. The first point is the voice's pan at its
 * onset (held until that point's own time, if later); each later point ramps
 * linearly to its value at its time, or jumps there when it shares its time
 * with the point before it. After the last point the value holds, through the
 * release. Pans are clamped to -1..1, a negative time is taken as the onset,
 * and a time earlier than the point before it is taken as that point's time, so
 * the booked automation always runs forwards.
 */
export function buildPanPath(points: readonly PanPoint[], voiceStart: number): PanEvent[] {
  const events: PanEvent[] = [];
  let previous = 0;
  points.forEach((point, index) => {
    const offset = Math.max(point.time, previous, 0);
    const value = clampPan(point.pan);
    if (index === 0) {
      events.push({ kind: 'set', value, time: voiceStart });
      if (offset > 0) {
        events.push({ kind: 'set', value, time: voiceStart + offset });
      }
    } else {
      events.push({ kind: offset === previous ? 'set' : 'ramp', value, time: voiceStart + offset });
    }
    previous = offset;
  });
  return events;
}

/** Books a pan path's events on a param. */
export function applyPanPath(param: AudioParamLike, events: readonly PanEvent[]): void {
  for (const event of events) {
    if (event.kind === 'set') {
      param.setValueAtTime(event.value, event.time);
    } else {
      param.linearRampToValueAtTime(event.value, event.time);
    }
  }
}

/**
 * Cuts a booked pan path short at `stopAt`: every event from then on is
 * cancelled and the pan holds the value the path had reached, so a voice
 * stopped mid-sweep fades out where it was rather than finishing the sweep.
 * Does nothing when the path has already finished by then, when the voice had
 * not started, or when the param cannot cancel automation.
 */
export function stopPanPath(
  param: AudioParamLike,
  events: readonly PanEvent[],
  stopAt: number
): void {
  const next = events.findIndex((event) => event.time >= stopAt);
  if (next <= 0 || !param.cancelScheduledValues) {
    return;
  }
  const before = events[next - 1];
  const after = events[next];
  param.cancelScheduledValues(stopAt);
  if (after.kind === 'ramp') {
    // Re-book the part of the ramp already under way, ending at the value it reaches at the stop.
    const value =
      before.value +
      ((after.value - before.value) * (stopAt - before.time)) / (after.time - before.time);
    param.linearRampToValueAtTime(value, stopAt);
  } else {
    param.setValueAtTime(before.value, stopAt);
  }
}
