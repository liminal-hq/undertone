// Wires the control generator to the real pattern class and the module's dispatchers
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { installControlMethods } from './controls.js';
import type { ControlBackend } from './controls.js';
import type { ControlRow } from './controlTypes.js';
import { Pattern, handleOfPattern, patternOfHandle } from './pattern.js';
import { glue } from './wasm.js';
import type { WasmPattern } from './wasm.js';

/** The backend over the module's dispatchers (`.control`, `.controlPattern`, `.panslide`, ... of `WasmPattern`). */
export function wasmControlBackend(): ControlBackend<WasmPattern> {
  return {
    control: (receiver, name, input) => receiver.control(name, input),
    controlPattern: (receiver, name, input) => receiver.controlPattern(name, input),
    panslide: (receiver, from, seconds) => receiver.panslide(from, seconds),
    panslidePattern: (receiver, from, seconds) => receiver.panslidePattern(from, seconds),
    pitchsteps: (receiver, semitones, rate) => receiver.pitchsteps(semitones, rate),
    channels: (receiver, gains) => receiver.channels(gains),
    panpath: (receiver, path, rate) => receiver.panpath(path, rate),
    text: (receiver, name, value) =>
      name === 'sound'
        ? receiver.sound(value)
        : name === 's'
          ? receiver.s(value)
          : receiver.bank(value),
    voice: (receiver, patch) => receiver.voice(patch),
    scale: (receiver, spec) => receiver.scale(spec),
    voicing: (receiver, anchor) => receiver.voicing(anchor)
  };
}

let installed = false;

/** Installs the control methods on `Pattern.prototype` once the module is loaded. Safe to call again. */
export function installControls(): void {
  if (installed) return;
  installControlMethods(
    Pattern.prototype,
    glue.controlTable() as ControlRow[],
    wasmControlBackend(),
    {
      isPattern: (value): value is Pattern<unknown> => value instanceof Pattern,
      handleOf: handleOfPattern,
      wrap: (handle) => patternOfHandle(handle)
    }
  );
  installed = true;
}
