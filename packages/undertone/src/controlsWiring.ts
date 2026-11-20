// Wires the control generator to the real pattern class and, when the module has it, the module's control dispatcher
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { installControlMethods } from './controls.js';
import type { ControlBackend } from './controls.js';
import type { ControlRow } from './controlTypes.js';
import { Pattern, handleOfPattern, patternOfHandle } from './pattern.js';
import { glue } from './wasm.js';
import type { WasmPattern } from './wasm.js';

/** The dispatcher methods RF-24 part 2 adds to `WasmPattern` (the shape the boundary document describes). */
interface ControlGlue {
  control(name: string, input: number | string, time?: number): WasmPattern;
  controlPattern(name: string, input: WasmPattern, time?: number): WasmPattern;
  controlValue(name: string, ...args: unknown[]): WasmPattern;
}

/** The backend over the module's dispatcher, or undefined while the module does not export one (RF-24 part 1). */
export function wasmControlBackend(): ControlBackend<WasmPattern> | undefined {
  const proto = glue.WasmPattern.prototype as unknown as Partial<ControlGlue>;
  if (typeof proto.control !== 'function' || typeof proto.controlPattern !== 'function') {
    return undefined;
  }
  const on = (receiver: WasmPattern) => receiver as unknown as ControlGlue;
  return {
    control: (receiver, name, input, time) => on(receiver).control(name, input, time),
    controlPattern: (receiver, name, input, time) => on(receiver).controlPattern(name, input, time),
    controlValue: (receiver, name, ...args) => on(receiver).controlValue(name, ...args)
  };
}

let installed = false;

/**
 * Installs the control methods on `Pattern.prototype` once the module is loaded. Returns whether the methods exist: false
 * until the module exports its dispatcher.
 */
export function installControls(): boolean {
  if (installed) return true;
  const backend = wasmControlBackend();
  if (!backend) return false;
  installControlMethods(Pattern.prototype, glue.controlTable() as ControlRow[], backend, {
    isPattern: (value): value is Pattern<unknown> => value instanceof Pattern,
    handleOf: handleOfPattern,
    wrap: (handle) => patternOfHandle(handle)
  });
  installed = true;
  return true;
}
