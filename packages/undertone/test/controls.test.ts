// Tests of the control generator against a fake backend and the real control table, until the module exports its dispatcher
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '@liminal-hq/undertone'; // loads the module
import * as wasm from '@liminal-hq/undertone/wasm';
import { installControlMethods, controlNames } from '../dist/controls.js';
import type { ControlBackend } from '../dist/controls.js';
import type { ControlRow } from '../dist/controlTypes.js';
import { installControls, wasmControlBackend } from '../dist/controlsWiring.js';

const table = wasm.controlTable() as ControlRow[];
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** A pattern stand-in whose handle is a string, and a backend that records what it was asked. */
class Fake {
  constructor(readonly handle: string) {}
}
const calls: string[] = [];
const backend: ControlBackend<string> = {
  control: (receiver, name, input, time) => {
    calls.push(`control ${receiver} ${name} ${JSON.stringify(input)} ${time ?? '-'}`);
    return `${receiver}.${name}`;
  },
  controlPattern: (receiver, name, input, time) => {
    calls.push(`controlPattern ${receiver} ${name} ${input} ${time ?? '-'}`);
    return `${receiver}.${name}`;
  },
  controlValue: (receiver, name, ...args) => {
    calls.push(`controlValue ${receiver} ${name} ${JSON.stringify(args)}`);
    return `${receiver}.${name}`;
  }
};
const host = {
  isPattern: (value: unknown): value is Fake => value instanceof Fake,
  handleOf: (pattern: Fake) => pattern.handle,
  wrap: (handle: string) => new Fake(handle)
};

describe('the control table', () => {
  it('has the 53 controls of the reference, with unique names', () => {
    expect(table).toHaveLength(53);
    expect(new Set(controlNames(table)).size).toBe(53);
  });

  it('is covered by the hand-written declarations', () => {
    const declared = new Set(
      [...read('../src/controlMethods.ts').matchAll(/^ {2,4}([a-z0-9]+)[(<]/gm)].map((m) => m[1])
    );
    expect(declared.size).toBeGreaterThan(50);
    expect(controlNames(table).filter((name) => !declared.has(name))).toEqual([]);
  });

  it('has row types in step with the ts-rs bindings', () => {
    const generated = read('../../../crates/undertone-wasm/bindings/ControlRow.ts');
    const fields = [...generated.matchAll(/^(\w+): /gm)].map((m) => m[1]);
    const copy = read('../src/controlTypes.ts');
    const copied = [...copy.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
    expect(copied).toEqual(fields);
    const args = [
      ...read('../../../crates/undertone-wasm/bindings/ControlArg.ts').matchAll(/"(\w+)"/g)
    ];
    for (const [, word] of args) expect(copy).toContain(`'${word}'`);
  });
});

describe('installControlMethods', () => {
  class Target extends Fake {}
  installControlMethods(Target.prototype, table, backend, host);
  const target = (handle = 'p') =>
    new Target(handle) as unknown as Record<string, (...a: unknown[]) => Fake>;

  it('installs one non-enumerable method per row', () => {
    for (const row of table) {
      expect(typeof Target.prototype[row.jsName as keyof Target]).toBe('function');
      expect(Object.keys(Target.prototype)).not.toContain(row.jsName);
    }
  });

  it('sends a patternable control a number, a string, or a pattern to the right call', () => {
    calls.length = 0;
    const gained = target().gain(0.5);
    target().gain('0.2 0.4');
    target().lpf(new Fake('sig'));
    expect(gained).toBeInstanceOf(Fake);
    expect(gained.handle).toBe('p.gain');
    expect(calls).toEqual([
      'control p gain 0.5 -',
      'control p gain "0.2 0.4" -',
      'controlPattern p lpf sig -'
    ]);
  });

  it('passes the extra seconds of a patternable control with a time', () => {
    calls.length = 0;
    target().panslide(-1, 0.3);
    expect(calls).toEqual(['control p panslide -1 0.3']);
  });

  it('sends the other kinds their arguments as given', () => {
    calls.length = 0;
    target().cut(2);
    target().channels([1, 0]);
    target().panpath([0, 1], 4);
    target().sound('sine');
    expect(calls).toEqual([
      'controlValue p cut [2]',
      'controlValue p channels [[1,0]]',
      'controlValue p panpath [[0,1],4]',
      'controlValue p sound ["sine"]'
    ]);
  });

  it('refuses a row that would replace an existing method', () => {
    class Clash extends Fake {
      gain() {
        return this;
      }
    }
    expect(() => installControlMethods(Clash.prototype, table, backend, host)).toThrow(
      /gain\(\) would replace an existing method/
    );
  });
});

describe('the real wiring', () => {
  it('waits for the module to export its dispatcher (RF-24 part 2)', () => {
    // When part 2 lands this flips: the backend exists and installControls() installs the methods on Pattern.
    const present = wasmControlBackend() !== undefined;
    expect(installControls()).toBe(present);
  });
});
