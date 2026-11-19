// Turns a corpus program (JSON data) into a pattern by calling the reference
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Pattern } from '../../src/pattern';
import type { Reference } from './reference';

/** One step of a program: a constructor or method name, then its arguments. */
export type Step = readonly [name: string, ...args: unknown[]];

/** A program: a list of steps. The first is a constructor, and each later step is a method. */
export type Program = readonly Step[];

type AnyPattern = Pattern<unknown>;

/** True for an array of steps (arrays whose first element is a name), which is how a nested program is told apart from data. */
export function isProgram(value: unknown): value is Program {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((step) => Array.isArray(step) && step.length > 0 && typeof step[0] === 'string')
  );
}

/** The named maps `fmap` takes in place of a closure. */
const NAMED_MAPS: Record<string, (arg: number) => (value: number) => number> = {
  add: (arg) => (value) => value + arg,
  sub: (arg) => (value) => value - arg,
  mul: (arg) => (value) => value * arg,
  div: (arg) => (value) => value / arg,
  neg: () => (value) => -value,
  abs: () => (value) => Math.abs(value),
  round: () => (value) => Math.round(value),
  floor: () => (value) => Math.floor(value)
};

/**
 * The leaf rules `mini` takes: what each word of a mini-notation string becomes.
 * - `word` keeps the word, and `number` is `Number(word)`.
 * - `pitch` is the leaf of `note()`: `{ pitch }` with a Hz number (digits only) or the note name, validated eagerly.
 * - `drum` is the leaf of `s()`: `{ soundType }` for one of the synth sound types, `{ sampleName }` for any other word.
 */
const LEAF_RULES: Record<string, (ref: Reference) => (word: string) => unknown> = {
  word: () => (word) => word,
  number: () => (word) => Number(word),
  pitch: (ref) => (word) => {
    if (/^\d+(\.\d+)?$/.test(word)) {
      const hz = Number(word);
      ref.lib.noteToFrequency(hz);
      return { pitch: hz };
    }
    ref.lib.noteToFrequency(word);
    return { pitch: word };
  },
  drum: (ref) => (word) =>
    ref.lib.s(word).query({ begin: new ref.lib.Fraction(0), end: new ref.lib.Fraction(1) })[0]
      ?.value
};

/** Methods that run side effects or leave the data model, so a program may not name them. */
const FORBIDDEN_METHODS = new Set(['query', 'sampleAt', 'play', 'loop', 'render', 'constructor']);

/** Which argument of a method is a transform (a program of methods applied to the pattern), not a pattern. */
const TRANSFORM_ARGUMENT: Record<string, number> = { every: 1, jux: 0 };

/**
 * Builds the pattern a program describes. A nested program in an argument is a pattern, except
 * where the method takes a transform (`every`, `jux`), where it is a list of methods applied to
 * the pattern the method was called on. Arrays and option objects are interpreted element by
 * element, so `timecat([[1, program], [2, program]])` works as written.
 */
export function interpret(ref: Reference, program: Program): AnyPattern {
  const [first, ...rest] = program;
  if (first === undefined) throw new Error('A program needs at least one step');
  let pattern = construct(ref, first);
  for (const step of rest) pattern = apply(ref, pattern, step);
  return pattern;
}

function argument(ref: Reference, value: unknown): unknown {
  if (isProgram(value)) return interpret(ref, value);
  if (Array.isArray(value)) return value.map((item) => argument(ref, item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, argument(ref, item)])
    );
  }
  return value;
}

function construct(ref: Reference, step: Step): AnyPattern {
  const [name, ...raw] = step;
  const lib = ref.lib as unknown as Record<string, unknown>;
  const value = lib[name];
  if (name === 'mini') {
    const [source, rule] = raw;
    const make = LEAF_RULES[String(rule)];
    if (make === undefined) throw new Error(`Unknown leaf rule "${String(rule)}"`);
    return ref.lib.mini(String(source), make(ref)) as AnyPattern;
  }
  if (name === 'pure') return ref.lib.pure(raw[0]) as AnyPattern;
  if (value instanceof ref.lib.Pattern) return value as AnyPattern;
  if (typeof value === 'function' && CONSTRUCTORS.has(name)) {
    return (value as (...args: unknown[]) => AnyPattern)(...raw.map((a) => argument(ref, a)));
  }
  throw new Error(`Unknown constructor "${name}"`);
}

/** The functions a program's first step may name (a signal name is looked up as a pattern instead). */
const CONSTRUCTORS = new Set([
  'note',
  'sound',
  's',
  'n',
  'chord',
  'stack',
  'seq',
  'cat',
  'timecat',
  'arrange',
  'irand',
  'choose',
  'brandBy'
]);

function apply(ref: Reference, pattern: AnyPattern, step: Step): AnyPattern {
  const [name, ...raw] = step;
  if (name === 'fmap') {
    const [mapName, arg] = raw;
    const make = NAMED_MAPS[String(mapName)];
    if (make === undefined) throw new Error(`Unknown named map "${String(mapName)}"`);
    const map = make(Number(arg ?? 0));
    return pattern.fmap((value) => map(value as number));
  }
  if (FORBIDDEN_METHODS.has(name)) throw new Error(`Method "${name}" is not allowed in a program`);
  const method = (pattern as unknown as Record<string, unknown>)[name];
  if (typeof method !== 'function') throw new Error(`Unknown method "${name}"`);
  const transformAt = TRANSFORM_ARGUMENT[name];
  const args = raw.map((value, index) =>
    index === transformAt ? transform(ref, value) : argument(ref, value)
  );
  return (method as (...a: unknown[]) => AnyPattern).apply(pattern, args);
}

function transform(ref: Reference, value: unknown): (pattern: AnyPattern) => AnyPattern {
  if (!isProgram(value)) throw new Error('A transform must be a program of methods');
  return (pattern) => value.reduce<AnyPattern>((acc, step) => apply(ref, acc, step), pattern);
}
