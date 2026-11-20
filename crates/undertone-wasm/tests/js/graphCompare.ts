// The layer 3 comparator of the Rust runner, shared by the module's runner (layer3.ts) and the package's (packages/undertone)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// No module is loaded here, so the package's Vitest runner can import it without instantiating a second copy of the glue.

import type { Json } from '../../../../conformance/recorder/format';

const FLOOR = 1e-15;

/** A recorded value back as a JavaScript value: `{ $num }` numbers and `{ $undefined }`. */
export function decodeJson(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decodeJson);
  if (value && typeof value === 'object') {
    const object = value as Record<string, Json>;
    if ('$num' in object) {
      const text = object.$num as string;
      return text === '-0' ? -0 : Number(text);
    }
    if ('$undefined' in object) return undefined;
    return Object.fromEntries(
      Object.entries(object).map(([key, field]) => [key, decodeJson(field)])
    );
  }
  return value;
}

const numberOf = (value: Json): number | undefined => {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$num') return decodeJson(value) as number;
  }
  return undefined;
};

/** The Rust runner's comparator: `undefined` when equal, `'floor'` when equal only through the floor, else the difference. */
export function compare(expected: Json, actual: Json, path: string): string | undefined | 'floor' {
  if (path.includes('.waves[') && (path.includes('.real[') || path.includes('.imag['))) {
    const e = numberOf(expected);
    const a = numberOf(actual);
    if (e !== undefined && a !== undefined) {
      if (Object.is(e, a)) return undefined;
      return Math.abs(e - a) <= FLOOR ? 'floor' : `${path}: recorded ${e}, wasm ${a}`;
    }
  }
  if (typeof expected === 'string' && typeof actual === 'string') {
    if (expected === actual) return undefined;
    if (path.includes('.nodes[') && path.includes('.params.gain[')) {
      const e = expected.split(' ');
      const a = actual.split(' ');
      const ok =
        e.length === a.length &&
        e.length > 2 &&
        e.every((token, index) => index === 1 || token === a[index]) &&
        e[1] !== '-0' &&
        a[1] !== '-0' &&
        Math.abs(Number(e[1]) - Number(a[1])) <= FLOOR;
      if (ok) return 'floor';
    }
    return `${path}: recorded ${JSON.stringify(expected)}, wasm ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}: ${expected.length} recorded, ${actual.length} from wasm`;
    }
    let floor = false;
    for (let i = 0; i < expected.length; i += 1) {
      const diff = compare(expected[i], actual[i], `${path}[${i}]`);
      if (diff === 'floor') floor = true;
      else if (diff) return diff;
    }
    return floor ? 'floor' : undefined;
  }
  if (
    expected &&
    actual &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const ek = Object.keys(expected).sort();
    const ak = Object.keys(actual).sort();
    if (ek.join() !== ak.join()) return `${path}: keys ${ek} recorded, ${ak} from wasm`;
    let floor = false;
    for (const key of ek) {
      const diff = compare(
        (expected as Record<string, Json>)[key],
        (actual as Record<string, Json>)[key],
        `${path}.${key}`
      );
      if (diff === 'floor') floor = true;
      else if (diff) return diff;
    }
    return floor ? 'floor' : undefined;
  }
  return JSON.stringify(expected) === JSON.stringify(actual)
    ? undefined
    : `${path}: recorded ${JSON.stringify(expected)}, wasm ${JSON.stringify(actual)}`;
}
