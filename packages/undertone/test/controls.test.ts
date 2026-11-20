// Tests of the control generator against a fake backend and the real control table, and of the real wiring
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '@liminal-hq/undertone'; // loads the module
import * as wasm from '@liminal-hq/undertone/wasm';
import { OWN_METHODS, installControlMethods, controlNames } from '../dist/controls.js';
import type { ControlBackend } from '../dist/controls.js';
import type { ControlRow } from '../dist/controlTypes.js';
import { installControls } from '../dist/controlsWiring.js';
import { Pattern, note } from '@liminal-hq/undertone';

const table = wasm.controlTable() as ControlRow[];
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** A pattern stand-in whose handle is a string, and a backend that records what it was asked. */
class Fake {
  constructor(readonly handle: string) {}
}
const calls: string[] = [];
const record =
  (kind: string) =>
  (receiver: string, ...args: unknown[]) => {
    calls.push(`${kind} ${receiver} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`.trim());
    return `${receiver}.${kind}`;
  };
const backend: ControlBackend<string> = {
  control: record('control'),
  controlPattern: record('controlPattern'),
  panslide: record('panslide'),
  panslidePattern: record('panslidePattern'),
  pitchsteps: record('pitchsteps'),
  channels: record('channels'),
  panpath: record('panpath'),
  text: record('text'),
  voice: record('voice'),
  scale: record('scale'),
  voicing: record('voicing')
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
      [
        ...read('../src/pattern.ts').matchAll(
          /^ {2}([a-z0-9]+)\(\n? *this: Pattern<ControlPatch>/gm
        )
      ].map((m) => m[1])
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

  it('installs one non-enumerable method per row, and the three hand-written ones', () => {
    for (const name of [...controlNames(table), ...OWN_METHODS]) {
      expect(typeof Target.prototype[name as keyof Target]).toBe('function');
      expect(Object.keys(Target.prototype)).not.toContain(name);
    }
  });

  it('sends a patternable control a number, a string, or a pattern to the right call', () => {
    calls.length = 0;
    const gained = target().gain(0.5);
    target().gain('0.2 0.4');
    target().lpf(new Fake('sig'));
    expect(gained).toBeInstanceOf(Fake);
    expect(gained.handle).toBe('p.control');
    expect(calls).toEqual([
      'control p "gain" 0.5',
      'control p "gain" "0.2 0.4"',
      'controlPattern p "lpf" "sig"'
    ]);
  });

  it('sends panslide its seconds, and refuses a pattern for them', () => {
    calls.length = 0;
    target().panslide(-1, 0.3);
    target().panslide(new Fake('from'), 0.3);
    expect(calls).toEqual(['panslide p -1 0.3', 'panslidePattern p "from" 0.3']);
    expect(() => target().panslide(0, new Fake('s'))).toThrow(
      'panslide() takes a plain value, not a pattern; it cannot change from event to event'
    );
  });

  it('sends the plain-value and list controls their arguments as given, and refuses a pattern in a list', () => {
    calls.length = 0;
    target().cut(2);
    target().channels([1, 0]);
    target().panpath([0, 1], 4);
    target().pitchsteps([0, 7], 100);
    target().sound('sine');
    target().voice({ pitch: 1 });
    target().scale('C4:major');
    target().voicing({ anchor: 'c4' });
    target().voicing();
    expect(calls).toEqual([
      'control p "cut" 2',
      'channels p [1,0]',
      'panpath p [0,1] 4',
      'pitchsteps p [0,7] 100',
      'text p "sound" "sine"',
      'voice p {"pitch":1}',
      'scale p "C4:major"',
      'voicing p "c4"',
      'voicing p'
    ]);
    for (const name of ['channels', 'panpath', 'pitchsteps']) {
      expect(() => target()[name](new Fake('x'))).toThrow(
        `${name}() takes a plain value, not a pattern; it cannot change from event to event`
      );
    }
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
  it('has installed every method on Pattern, and installing again changes nothing', () => {
    for (const name of [...controlNames(table), ...OWN_METHODS]) {
      expect(typeof Pattern.prototype[name as keyof Pattern<unknown>]).toBe('function');
    }
    installControls();
    expect(note('c3').gain(0.5)).toBeInstanceOf(Pattern);
  });
});
