// Installs one method per row of the control table on a pattern prototype, over a small backend interface
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlRow } from './controlTypes.js';

// The reference writes the ~55 control methods by hand (`.gain()`, `.lpf()`, `.pan()`, ...). Here they come from the Rust
// control table (`controlTable()`): the table says what each takes, and the module's dispatchers do the work, so the two
// cannot drift (docs/rust-migration/results/M6-BOUNDARY.md, section 6). This file is the generator, written against the
// `ControlBackend` interface below so that it is tested with a fake backend as well as the real one (`wasmControlBackend`
// in controlsWiring.ts). The declarations of the methods are hand-written in pattern.ts, as the API report checks them.

/**
 * What the generator needs from the module, over handles `H`. Each call returns a new handle and never changes the receiver.
 * The arguments the generator cannot check itself cross as they were given: the module reads them (and reports what the
 * reference reports) in Rust.
 */
export interface ControlBackend<H> {
  /** Every control that takes a plain value: a number, a string of mini-notation numbers, a choice word, an integer. */
  control(receiver: H, name: string, input: unknown): H;
  /** A control given a pattern of numbers (a signal is read at each event's onset); a plain-value control refuses it. */
  controlPattern(receiver: H, name: string, input: H): H;
  /** `panslide(from, seconds)` with a plain `from`. */
  panslide(receiver: H, from: unknown, seconds: unknown): H;
  /** `panslide(from, seconds)` with a pattern for `from`. */
  panslidePattern(receiver: H, from: H, seconds: unknown): H;
  pitchsteps(receiver: H, semitones: unknown, rate: unknown): H;
  channels(receiver: H, gains: unknown): H;
  panpath(receiver: H, path: unknown, rate: unknown): H;
  /** `sound`, `s`, and `bank`: a name, not checked. */
  text(receiver: H, name: string, value: unknown): H;
  voice(receiver: H, patch: unknown): H;
  scale(receiver: H, spec: unknown): H;
  voicing(receiver: H, anchor: unknown): H;
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

/** The names of the methods installed besides the table's: the ones the reference writes without a control row. */
export const OWN_METHODS = ['voice', 'scale', 'voicing'] as const;

/** The reference's message for a plain-value control given a pattern. */
function plainValue(name: string): Error {
  return new Error(
    `${name}() takes a plain value, not a pattern; it cannot change from event to event`
  );
}

function define(target: object, name: string, method: (...args: never[]) => unknown): void {
  if (Object.prototype.hasOwnProperty.call(target, name)) {
    throw new Error(`the control table's ${name}() would replace an existing method`);
  }
  Object.defineProperty(target, name, {
    value: method,
    writable: true,
    configurable: true,
    enumerable: false
  });
}

/**
 * Installs one method per row, and `voice`, `scale`, and `voicing`, on `target` (a prototype), as non-enumerable methods like a
 * class's. A name already on `target` is an error: the table must not shadow a hand-written method.
 *
 * A pattern is told from a value here, with `instanceof`, because Rust cannot see a wrapper `Pattern` inside an untyped
 * value: a scalar-only control given one is refused by Rust, and the list controls and `panslide`'s seconds are refused here
 * with the same message.
 */
export function installControlMethods<P extends object, H>(
  target: P,
  table: readonly ControlRow[],
  backend: ControlBackend<H>,
  host: ControlHost<P, H>
): void {
  for (const row of table) {
    const name = row.jsName;
    switch (row.arg) {
      case 'patternableWithTime':
        define(target, name, function (this: P, from: unknown, seconds?: unknown): P {
          if (host.isPattern(seconds)) throw plainValue(name);
          const receiver = host.handleOf(this);
          return host.wrap(
            host.isPattern(from)
              ? backend.panslidePattern(receiver, host.handleOf(from), seconds)
              : backend.panslide(receiver, from, seconds)
          );
        });
        break;
      case 'numberList':
      case 'path': {
        if (name !== 'pitchsteps' && name !== 'channels' && name !== 'panpath') {
          throw new Error(`the control table's ${name}() has no dispatcher`);
        }
        define(target, name, function (this: P, list: unknown, rate?: unknown): P {
          if (host.isPattern(list)) throw plainValue(name);
          const receiver = host.handleOf(this);
          return host.wrap(
            name === 'pitchsteps'
              ? backend.pitchsteps(receiver, list, rate)
              : name === 'channels'
                ? backend.channels(receiver, list)
                : backend.panpath(receiver, list, rate)
          );
        });
        break;
      }
      case 'text':
        define(target, name, function (this: P, value: unknown): P {
          return host.wrap(backend.text(host.handleOf(this), name, value));
        });
        break;
      default:
        define(target, name, function (this: P, input: unknown): P {
          const receiver = host.handleOf(this);
          return host.wrap(
            host.isPattern(input)
              ? backend.controlPattern(receiver, name, host.handleOf(input))
              : backend.control(receiver, name, input)
          );
        });
    }
  }
  define(target, 'voice', function (this: P, patch: unknown): P {
    return host.wrap(backend.voice(host.handleOf(this), patch));
  });
  define(target, 'scale', function (this: P, spec: unknown): P {
    return host.wrap(backend.scale(host.handleOf(this), spec));
  });
  define(target, 'voicing', function (this: P, options?: { anchor?: string | number }): P {
    return host.wrap(backend.voicing(host.handleOf(this), options?.anchor));
  });
}
