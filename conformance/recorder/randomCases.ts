// Layer 1 `random` group: the first 64 values of seededRandom(seed) for many seeds
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { encodeValue } from './format';
import type { CaseRecord } from './format';
import type { Reference } from './reference';

/** How many values each case records. */
export const RANDOM_COUNT = 64;

/** One `seededRandom(seed)` case: the seed, and where it came from. */
export interface RandomCase {
  id: string;
  from: string;
  seed: number | string;
}

const G = (family: string) => `generated: ${family}`;

/**
 * The seeds. A numeric seed goes through `seed >>> 0` (so fractions truncate, negatives wrap, and
 * NaN, the infinities, and negative zero are 0); a string seed is hashed with FNV-1a over its UTF-16
 * code units. The string families include the key shapes the reference builds for its own random
 * sources (`contextRandom`, `keyedRandom`, `timeRandom`, and `drift`).
 */
export function randomCases(): RandomCase[] {
  const out: RandomCase[] = [];
  const counter = new Map<string, number>();
  const add = (stem: string, from: string, seed: number | string) => {
    const next = (counter.get(stem) ?? 0) + 1;
    counter.set(stem, next);
    out.push({ id: `random-${stem}-${String(next).padStart(2, '0')}`, from, seed });
  };
  const numbers: [number, string][] = [
    [0, 'zero'],
    [1, 'one'],
    [2, 'two'],
    [3, 'three'],
    [7, 'seven'],
    [42, 'forty-two'],
    [100, 'a hundred'],
    [1337, 'a small integer'],
    [12345, 'a five digit integer'],
    [65535, '2^16 - 1'],
    [65536, '2^16'],
    [16777216, '2^24'],
    [2147483647, '2^31 - 1'],
    [2147483648, '2^31'],
    [4294967295, '2^32 - 1, the largest seed that is itself'],
    [4294967296, '2^32 wraps to 0'],
    [4294967297, '2^32 + 1 wraps to 1'],
    [8589934592, '2^33 wraps to 0'],
    [9007199254740991, 'the largest safe integer'],
    [9007199254740992, '2^53'],
    [-1, 'minus one wraps to 2^32 - 1'],
    [-2, 'minus two'],
    [-42, 'minus forty-two'],
    [-2147483648, '-2^31'],
    [-4294967296, '-2^32 wraps to 0'],
    [-9007199254740991, 'the smallest safe integer'],
    [0.5, 'a half truncates to 0'],
    [1.5, 'one and a half truncates to 1'],
    [2.999, 'just below three truncates to 2'],
    [-0.5, 'minus a half truncates to 0'],
    [-1.5, 'minus one and a half truncates toward zero then wraps'],
    [4294967295.9, 'a fraction above 2^32 - 1'],
    [1e-9, 'a tiny fraction'],
    [Number.MIN_VALUE, 'the smallest positive double'],
    [1e21, 'a number that prints with an exponent'],
    [1e300, 'a huge number'],
    [Number.MAX_VALUE, 'the largest double'],
    [-Number.MAX_VALUE, 'the most negative double'],
    [Number.NaN, 'NaN is 0'],
    [Infinity, 'Infinity is 0'],
    [-Infinity, '-Infinity is 0'],
    [-0, 'negative zero is 0'],
    [0x6d2b79f5, 'the generator increment as a seed'],
    [0x9e3779b9, 'the golden ratio constant'],
    [0xffffffff - 0x6d2b79f5 + 1, 'the seed whose first state is 0']
  ];
  for (const [seed, what] of numbers) add('number', G(`numeric seed: ${what}`), seed);
  // generated: seeds 0 to 15 in a row, to catch a state that is not reseeded.
  for (let seed = 0; seed < 16; seed++) add('run', G('consecutive numeric seeds 0 to 15'), seed);
  const long = 'the quick brown fox jumps over the lazy dog '.repeat(24);
  const strings: [string, string][] = [
    ['', 'the empty string is the FNV offset basis'],
    ['a', 'one letter'],
    ['b', 'the next letter'],
    ['seed', 'a word'],
    ['undertone', 'the library name'],
    ['0', 'the string zero differs from the number zero'],
    ['1', 'the string one'],
    ['42', 'the string forty-two'],
    ['NaN', 'the string NaN'],
    ['-1', 'a negative number as a string'],
    ['1.5', 'a decimal as a string'],
    [' ', 'a space'],
    ['  seed  ', 'surrounding spaces'],
    ['\t\n', 'whitespace controls'],
    ['\u0000', 'NUL'],
    ['\u0000\u0000', 'two NULs'],
    ['é', 'a precomposed e acute (one code unit)'],
    ['é', 'e and a combining acute (two code units, a different hash)'],
    ['üñî', 'accented letters'],
    ['日本語', 'CJK ideographs'],
    ['😀', 'an emoji hashes as two surrogate code units'],
    ['\ud83d', 'a lone high surrogate'],
    ['\ude00', 'a lone low surrogate'],
    ['\ude00\ud83d', 'surrogates in the wrong order'],
    ['👨‍👩‍👧', 'a family emoji with joiners'],
    ['\u{10ffff}', 'the last code point'],
    ['￿', 'the last BMP code unit'],
    ['﻿', 'a byte order mark'],
    [long, 'a long string of about 1000 code units'],
    ['x'.repeat(5000), 'a very long string'],
    ['song|rand|0/1', 'the shape timeRandom builds'],
    ['song|perlin|-7/3', 'timeRandom at negative time'],
    ['7|rand|1/3', 'timeRandom with a numeric seed'],
    ['0|drift|0/1|c3', 'a drift-like key'],
    ['1|0|0/1|c3', 'the key drift builds: seed, pass, position, pitch'],
    ['1|0|1/3|261.6255653005986', 'a drift key with a derived Hz float'],
    ['song|5|3/4|', 'a drift key with no pitch'],
    ['s|reverb|0|2000#0', 'a contextRandom key with an occurrence counter'],
    ['s|orbit:0:1.5:48000', 'a keyedRandom key'],
    ['0|white#0', 'a noise key'],
    ['0|white#1', 'the second occurrence of a noise key'],
    ['pipe|', 'a trailing bar']
  ];
  for (const [seed, what] of strings) add('string', G(`string seed: ${what}`), seed);
  return out;
}

/** Records one random case: the first `RANDOM_COUNT` values, as JavaScript prints them. */
export function recordRandom(ref: Reference, spec: RandomCase): CaseRecord {
  const next = ref.lib.seededRandom(spec.seed);
  const values = Array.from({ length: RANDOM_COUNT }, () => next());
  return {
    id: spec.id,
    group: 'random',
    from: spec.from,
    seed: encodeValue(spec.seed),
    values: values.map((value) => encodeValue(value))
  };
}
