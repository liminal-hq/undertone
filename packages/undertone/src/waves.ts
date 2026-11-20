// Shaped waveform names, from the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ShapedWaveType } from './types.js';
import { glue } from './wasm.js';

/** The shaped waveforms (a live binding, read from the module once an entry has loaded it; see surround.ts). */
export let SHAPED_WAVE_TYPES: readonly ShapedWaveType[];

/** Reads the names from the module. Called by the entries once it is instantiated. */
export function loadWaves(): void {
  SHAPED_WAVE_TYPES = glue.shapedWaveTypes() as ShapedWaveType[];
}

export function isShapedWave(word: string): word is ShapedWaveType {
  return glue.isShapedWave(word);
}
