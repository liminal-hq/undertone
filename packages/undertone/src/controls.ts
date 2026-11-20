// Installs one method per row of the control table on a pattern prototype, over a small backend interface
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlRow } from './controlTypes.js';

// The reference writes the ~55 control methods by hand (`.gain()`, `.lpf()`, `.pan()`, ...). Here they come from the Rust
// control table (`controlTable()`): the table says what each takes, and one dispatcher in the module does the work, so the two
// cannot drift (docs/rust-migration/results/M6-BOUNDARY.md, section 6). This file is the generator, written against the
// `ControlBackend` interface below so that it is tested with a fake today and wired to the module's dispatcher when RF-24
// part 2 exports it (`wasmControlBackend` in controlsWiring.ts is the one place that changes).

/**
 * What the generator needs from the module, over handles `H`. Each call returns a new handle and never changes the receiver.
 */
export interface ControlBackend<H> {
  /** A patternable control given a plain number, or a string of mini-notation numbers (`.gain('0.2 0.4')`). */
  control(receiver: H, name: string, input: number | string, time?: number): H;
  /** A patternable control given a pattern of numbers (a signal is read at each event's onset). */
  controlPattern(receiver: H, name: string, input: H, time?: number): H;
  /** Every other kind (integer, number, choice, text, number list, path): its arguments as the caller gave them. */
  controlValue(receiver: H, name: string, ...args: unknown[]): H;
}

/** How the generator reaches the pattern class: telling a pattern from a value, and moving between patterns and handles. */
export interface ControlHost<P extends object, H> {
  isPattern(value: unknown): value is P;
  handleOf(pattern: P): H;
  wrap(handle: H): P;
}

/** The method names a table installs, in table order. */
export function controlNames(table: readonly ControlRow[]): string[] {
  return table.map((row) => row.jsName);
}

/**
 * Installs one method per row on `target` (a prototype), as non-enumerable methods like a class's. A row whose name is
 * already on `target` is an error: the table must not shadow a hand-written method.
 */
export function installControlMethods<P extends object, H>(
  target: P,
  table: readonly ControlRow[],
  backend: ControlBackend<H>,
  host: ControlHost<P, H>
): void {
  for (const row of table) {
    if (Object.prototype.hasOwnProperty.call(target, row.jsName)) {
      throw new Error(`the control table's ${row.jsName}() would replace an existing method`);
    }
    const name = row.jsName;
    const method =
      row.arg === 'patternable' || row.arg === 'patternableWithTime'
        ? function (this: P, input: unknown, time?: number): P {
            const receiver = host.handleOf(this);
            if (host.isPattern(input)) {
              return host.wrap(backend.controlPattern(receiver, name, host.handleOf(input), time));
            }
            return host.wrap(backend.control(receiver, name, input as number | string, time));
          }
        : function (this: P, ...args: unknown[]): P {
            return host.wrap(backend.controlValue(host.handleOf(this), name, ...args));
          };
    Object.defineProperty(target, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
}
