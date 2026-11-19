// Types of the skeleton bridge's entries (hand-written; the real package generates them)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export interface Playback {
  startTime: number;
  operations: number;
}
export interface PlayOptions {
  context?: unknown;
  at?: number;
  cycleSeconds?: number;
}
export declare class Pattern {
  sound(type: string): Pattern;
  gain(level: number): Pattern;
  attack(seconds: number): Pattern;
  decay(seconds: number): Pattern;
  sustain(level: number): Pattern;
  release(seconds: number): Pattern;
  lpf(hz: number): Pattern;
  lpenv(hz: number): Pattern;
  lpd(seconds: number): Pattern;
  pan(position: number): Pattern;
  panlaw(db: number): Pattern;
  panpath(points: { time: number; pan: number }[]): Pattern;
  play(options?: PlayOptions): Playback;
}
export declare function note(text: string): Pattern;
export declare function replay(ctx: unknown, ops: Float64Array | number[]): number;
export declare const timing: { start: number; ready: number };
export declare function init(): Promise<void>;
