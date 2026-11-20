// The control methods of Pattern as the reference declares them (0.4.0); merged into Pattern when the module's dispatcher lands
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Pattern } from './pattern.js';
import type {
  ControlInput,
  ControlPatch,
  OscType,
  PanPoint,
  ShapedWaveType,
  SoundType
} from './types.js';

// Hand-written, as the boundary document says (section 6): the API report checks them, and a test checks that the table's
// names are a subset of these. `this` is a pattern of ControlPatch in the reference; here the interface is used on its own,
// and the merge into Pattern restores that.

export interface ControlMethods {
  voice(patch: ControlPatch): Pattern<ControlPatch>;
  sound(type: SoundType): Pattern<ControlPatch>;
  s(name: SoundType | string): Pattern<ControlPatch>;
  bank(name: string): Pattern<ControlPatch>;
  scale(spec: string): Pattern<ControlPatch>;
  voicing(options?: { anchor?: string | number }): Pattern<ControlPatch>;
  attack(seconds: ControlInput): Pattern<ControlPatch>;
  decay(seconds: ControlInput): Pattern<ControlPatch>;
  sustain(level: ControlInput): Pattern<ControlPatch>;
  release(seconds: ControlInput): Pattern<ControlPatch>;
  gain(level: ControlInput): Pattern<ControlPatch>;
  lpf(hz: ControlInput): Pattern<ControlPatch>;
  lpenv(hzAmount: ControlInput): Pattern<ControlPatch>;
  lpa(seconds: ControlInput): Pattern<ControlPatch>;
  lpd(seconds: ControlInput): Pattern<ControlPatch>;
  lps(level: ControlInput): Pattern<ControlPatch>;
  lpr(seconds: ControlInput): Pattern<ControlPatch>;
  slide(seconds: ControlInput): Pattern<ControlPatch>;
  fm(index: ControlInput): Pattern<ControlPatch>;
  fmi(index: ControlInput): Pattern<ControlPatch>;
  fmh(ratio: ControlInput): Pattern<ControlPatch>;
  fmattack(seconds: ControlInput): Pattern<ControlPatch>;
  fmdecay(seconds: ControlInput): Pattern<ControlPatch>;
  fmsustain(level: ControlInput): Pattern<ControlPatch>;
  fmrelease(seconds: ControlInput): Pattern<ControlPatch>;
  fmenv(curve: 'lin' | 'exp'): Pattern<ControlPatch>;
  fmwave(type: OscType | ShapedWaveType): Pattern<ControlPatch>;
  penv(semitones: ControlInput): Pattern<ControlPatch>;
  pattack(seconds: ControlInput): Pattern<ControlPatch>;
  pdecay(seconds: ControlInput): Pattern<ControlPatch>;
  pitchsteps(semitones: readonly number[], rateHz?: number): Pattern<ControlPatch>;
  duration(seconds: ControlInput): Pattern<ControlPatch>;
  legato(fraction: ControlInput): Pattern<ControlPatch>;
  velocity(level: ControlInput): Pattern<ControlPatch>;
  cut(group: number): Pattern<ControlPatch>;
  nudge(seconds: ControlInput): Pattern<ControlPatch>;
  late(seconds: ControlInput): Pattern<ControlPatch>;
  early(seconds: ControlInput): Pattern<ControlPatch>;
  pan(position: ControlInput): Pattern<ControlPatch>;
  panslide(from: ControlInput, seconds?: number): Pattern<ControlPatch>;
  autopan(hz: ControlInput): Pattern<ControlPatch>;
  autopandepth(depth: ControlInput): Pattern<ControlPatch>;
  autopanshape(shape: 'sine' | 'triangle' | 'square'): Pattern<ControlPatch>;
  autopanphase(phase: ControlInput): Pattern<ControlPatch>;
  panpath(path: readonly number[] | readonly PanPoint[], rateHz?: number): Pattern<ControlPatch>;
  panlaw(db: number): Pattern<ControlPatch>;
  hpf(hz: ControlInput): Pattern<ControlPatch>;
  phaser(rateHz: ControlInput): Pattern<ControlPatch>;
  room(level: ControlInput): Pattern<ControlPatch>;
  roomsize(size: ControlInput): Pattern<ControlPatch>;
  delay(level: ControlInput): Pattern<ControlPatch>;
  delaytime(seconds: ControlInput): Pattern<ControlPatch>;
  delayfeedback(amount: ControlInput): Pattern<ControlPatch>;
  orbit(n: number): Pattern<ControlPatch>;
  channels(gains: number[]): Pattern<ControlPatch>;
  surround(angleDegrees: number): Pattern<ControlPatch>;
}
