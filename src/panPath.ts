// Builds a voice's pan automation from a pan path, its pan law gains, and cuts it short when the voice is stopped early
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

/** The pan law of a plain `StereoPannerNode`: about -3 dB on each side at the centre. */
export const DEFAULT_PAN_LAW = -3;

/** The quietest centre a pan law may ask for, in dB. */
export const MIN_PAN_LAW = -6;

/** The widest pan step a ramp under a pan law is booked in; finer steps follow the curve more closely. */
const PAN_LAW_STEP = 1 / 32;

/**
 * The pan law a voice asks for, checked: `undefined` for the plain stereo
 * panner (no law, a law that is not a number, or exactly -3 dB), otherwise
 * the law clamped to -6..0 dB.
 */
export function customPanLaw(law: number | undefined): number | undefined {
  if (law === undefined || !Number.isFinite(law) || law === DEFAULT_PAN_LAW) {
    return undefined;
  }
  return Math.max(MIN_PAN_LAW, Math.min(0, law));
}

/**
 * Each side's gain for a pan under a pan law (`law`, each side's level at the
 * centre in dB, -6 to 0): the equal-power gains cos and sin of
 * (pan + 1) · π/4, scaled by √2 · 10^(law/20) so the centre lands on the law,
 * and each capped at 1. At 0 dB the louder side stays full, like a balance
 * control; at -6 dB the centre is half each side and a hard pan is
 * -3 dB. This is the law Fizz Audio Studio's OPL3 placement uses.
 */
export function panLawGains(pan: number, law: number): { left: number; right: number } {
  const angle = ((clampPan(pan) + 1) * Math.PI) / 4;
  const scale = Math.SQRT2 * 10 ** (law / 20);
  return {
    left: Math.min(1, scale * Math.cos(angle)),
    right: Math.min(1, scale * Math.sin(angle))
  };
}

/**
 * The pans where a law's side gains reach their cap of 1 (only for laws above
 * -3 dB, where the scaled curve would pass full): the left side is full from
 * hard left up to the first, the right side from the second to hard right.
 */
function panLawKnees(law: number): number[] {
  const scale = Math.SQRT2 * 10 ** (law / 20);
  if (!(scale > 1)) {
    return [];
  }
  const knee = (4 * Math.acos(1 / scale)) / Math.PI - 1; // where scale · cos(angle) = 1
  return [knee, -knee];
}

/**
 * A pan path's events as the two side gains of a pan law. A step stays a
 * step; a ramp is booked as linear gain ramps at most 1/32 of a pan apart,
 * with a break where a side reaches its cap, so the gains follow the law's
 * curve to within 0.001 dB along the way and land on it exactly at every
 * point of the path.
 */
export function panLawPath(
  events: readonly PanEvent[],
  law: number
): { left: PanEvent[]; right: PanEvent[] } {
  const left: PanEvent[] = [];
  const right: PanEvent[] = [];
  const push = (kind: PanEvent['kind'], pan: number, time: number) => {
    const gains = panLawGains(pan, law);
    left.push({ kind, value: gains.left, time });
    right.push({ kind, value: gains.right, time });
  };
  const knees = panLawKnees(law);
  events.forEach((event, index) => {
    const before = events[index - 1];
    if (event.kind === 'set' || before === undefined) {
      push('set', event.value, event.time);
      return;
    }
    const from = before.value;
    const span = event.value - from;
    const steps = Math.max(1, Math.ceil(Math.abs(span) / PAN_LAW_STEP));
    // Fractions of the ramp to break at: even steps, and any knee strictly inside it.
    const breaks = new Set<number>();
    for (let step = 1; step < steps; step++) {
      breaks.add(step / steps);
    }
    for (const knee of knees) {
      const fraction = (knee - from) / span;
      if (fraction > 0 && fraction < 1) {
        breaks.add(fraction);
      }
    }
    for (const fraction of [...breaks].sort((a, b) => a - b)) {
      push('ramp', from + span * fraction, before.time + (event.time - before.time) * fraction);
    }
    push('ramp', event.value, event.time);
  });
  return { left, right };
}
