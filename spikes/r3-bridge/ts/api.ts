// The skeleton's public API: note() and a Pattern that books voices on the caller's AudioContext
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note_pattern, type Pattern as RustPattern } from './wasm/r3_bridge.js';

/** The slice of an AudioContext that the replay uses (the fake context and the real one both fit). */
export interface ContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): any;
  createGain(): any;
  createBiquadFilter(): any;
  createStereoPanner(): any;
  createChannelMerger(inputs?: number): any;
}

/** What `play()` returns: when the first voice starts and the number of operations replayed. */
export interface Playback {
  startTime: number;
  operations: number;
}

export interface PlayOptions {
  context?: ContextLike;
  /** Context time of cycle 0. Default: the context's current time. */
  at?: number;
  /** Seconds per cycle (the stub has no scheduler, so this is explicit). Default 0.5. */
  cycleSeconds?: number;
}

const OSCILLATOR_TYPES = ['sine', 'square', 'sawtooth', 'triangle'];
const PARAMS = ['frequency', 'gain', 'frequency', 'pan']; // the automated parameter by node kind: oscillator, gain, filter, panner

/**
 * Replays the flat booking operations (six numbers each) on a context, in order. This is the TypeScript
 * half of the bridge: it never decides anything, it only makes the calls Rust asked for.
 */
export function replay(ctx: ContextLike, ops: Float64Array | number[]): number {
  const nodes: any[] = [ctx.destination];
  const kinds: number[] = [0];
  let first = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ops.length; i += 6) {
    const [code, a, b, c, d] = [ops[i], ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 4]];
    switch (code) {
      case 0: {
        const node = [
          () => ctx.createOscillator(),
          () => ctx.createGain(),
          () => ctx.createBiquadFilter(),
          () => ctx.createStereoPanner(),
          () => ctx.createChannelMerger(c)
        ][b]();
        nodes[a] = node;
        kinds[a] = b;
        break;
      }
      case 1:
        nodes[a].type = OSCILLATOR_TYPES[b];
        break;
      case 2: {
        const param = nodes[a][kindParam(kinds[a])];
        param.setValueAtTime(c, b);
        break;
      }
      case 3: {
        const param = nodes[a][kindParam(kinds[a])];
        param.linearRampToValueAtTime(c, b);
        break;
      }
      case 4:
        nodes[a].connect(nodes[b], c, d);
        break;
      case 5:
        nodes[a].connect(ctx.destination);
        break;
      case 6:
        nodes[a].start(b);
        first = Math.min(first, b);
        break;
      case 7:
        nodes[a].stop(b);
        break;
    }
  }
  return first;
}

function kindParam(kind: number): string {
  return PARAMS[kind] ?? 'gain';
}

let sharedContext: ContextLike | undefined;

/** A pattern whose events the skeleton can book: the patch is the TypeScript half of `withControl`. */
export class Pattern {
  constructor(
    private readonly rust: RustPattern,
    private readonly patch: Record<string, unknown> = {}
  ) {}
  private with(more: Record<string, unknown>): Pattern {
    return new Pattern(this.rust, { ...this.patch, ...more });
  }
  sound(type: string): Pattern {
    return this.with({ soundType: type });
  }
  gain(level: number): Pattern {
    return this.with({ gainLevel: level });
  }
  attack(seconds: number): Pattern {
    return this.with({ attack: seconds });
  }
  decay(seconds: number): Pattern {
    return this.with({ decay: seconds });
  }
  sustain(level: number): Pattern {
    return this.with({ sustain: level });
  }
  release(seconds: number): Pattern {
    return this.with({ release: seconds });
  }
  lpf(hz: number): Pattern {
    return this.with({ filterCutoff: hz });
  }
  lpenv(hz: number): Pattern {
    return this.with({ filterEnvAmount: hz });
  }
  lpd(seconds: number): Pattern {
    return this.with({ filterDecay: seconds });
  }
  pan(position: number): Pattern {
    return this.with({ pan: position });
  }
  panlaw(db: number): Pattern {
    return this.with({ panLaw: db });
  }
  panpath(points: { time: number; pan: number }[]): Pattern {
    return this.with({ panPath: points });
  }
  /** Books cycle 0 on `options.context` (a shared AudioContext when none is given). */
  play(options: PlayOptions = {}): Playback {
    const ctx = options.context ?? (sharedContext ??= new AudioContext() as unknown as ContextLike);
    const at = options.at ?? ctx.currentTime;
    const ops = this.rust.book(this.patch, 0, 1, options.cycleSeconds ?? 0.5, at);
    const startTime = replay(ctx, ops);
    return { startTime, operations: ops.length / 6 };
  }
}

/** `note('a3')`: a pattern of pitches. */
export function note(text: string): Pattern {
  return new Pattern(note_pattern(text));
}
