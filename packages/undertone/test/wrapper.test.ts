// Tests of what the wrapper adds to the module: handles, freeing, the thunks, foreign leaves, and times beyond 2^53
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  Fraction,
  Pattern,
  cat,
  hasOnset,
  mini,
  pure,
  rand,
  sine,
  stack,
  silence,
  type Hap
} from '@liminal-hq/undertone';
import * as wasm from '@liminal-hq/undertone/wasm';

const span = (begin: Fraction, end: Fraction) => ({ begin, end });
const cycle = (pattern: Pattern<unknown>, n = 0) =>
  pattern.query(span(new Fraction(n), new Fraction(n + 1)));

/** A collection on demand: V8's `gc` without starting Node with `--expose-gc`. */
function collect(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

describe('the Pattern class', () => {
  it('is what every constructor and method returns', () => {
    const base = mini('a b', (word) => word);
    for (const made of [
      base,
      base.fast(2),
      base.slow(2),
      base.rev(),
      base.euclid(1, 2),
      base.segment(4),
      base.fmap((word) => word.length),
      base.every(2, (pattern) => pattern.rev()),
      pure(1),
      silence,
      stack(base, base),
      cat(base, base),
      sine.range(1, 2)
    ]) {
      expect(made).toBeInstanceOf(Pattern);
    }
  });

  it('keeps .query a public property that returns Hap objects with Fractions', () => {
    const haps = cycle(mini('a b', (word) => word)) as Hap<string>[];
    expect(typeof mini('a', (word) => word).query).toBe('function');
    expect(haps).toHaveLength(2);
    expect(haps[0].part.begin).toBeInstanceOf(Fraction);
    expect(haps[1].whole?.begin.toString()).toBe('1/2');
    expect(hasOnset(haps[1])).toBe(true);
  });

  it('never changes the receiver', () => {
    const base = mini('a b c', (word) => word);
    const before = cycle(base).map((hap) => hap.value);
    base.fast(3).rev().euclid(2, 3);
    expect(cycle(base).map((hap) => hap.value)).toEqual(before);
  });

  it('carries the signals through transforms with their sampler', () => {
    const shifted = sine.fast(2);
    expect(shifted.sample).toBeTypeOf('function');
    expect(shifted.sampleAt(new Fraction(1, 8))).toBeCloseTo(1);
    expect(mini('a', (word) => word).sample).toBeUndefined();
  });

  it('keeps the validation messages of the reference', () => {
    const numbers = pure(1);
    expect(() => numbers.add('1' as never)).toThrow('add() needs a number or a pattern of numbers');
    expect(() => numbers.sub({} as never)).toThrow('sub() needs a number or a pattern of numbers');
    expect(() => numbers.mul(null as never)).toThrow(
      'mul() needs a number or a pattern of numbers'
    );
    expect(() => numbers.div(undefined as never)).toThrow(
      'div() needs a number or a pattern of numbers'
    );
  });

  it('throws plain Errors with the Rust message', () => {
    for (const run of [
      () => pure(1).fast(0),
      () => pure(1).every(0, (pattern) => pattern),
      () => mini('a [b', (word) => word)
    ]) {
      try {
        run();
        expect.unreachable();
      } catch (error) {
        expect((error as Error).constructor).toBe(Error);
      }
    }
    expect(() => pure(1).fast(0)).toThrow('fast() factor must be positive, got 0');
  });

  it('refuses a null value with one clear message', () => {
    expect(() => pure(null)).toThrow(/a pattern value must be a number, a string, a boolean/);
  });
});

describe('free() and using', () => {
  it('is safe to call twice, where the glue would throw', () => {
    const pattern = pure(1).fast(2);
    pattern.free();
    expect(() => pattern.free()).not.toThrow();
  });

  it('makes a freed pattern say so, and leaves the patterns made from it alone', () => {
    const parent = mini('a b', (word) => word);
    const child = parent.fast(2);
    parent.free();
    expect(() => parent.query(span(new Fraction(0), new Fraction(1)))).toThrow(/was freed/);
    expect(() => parent.fast(2)).toThrow(/was freed/);
    expect(cycle(child)).toHaveLength(4);
  });

  it('frees at the end of a using block through Symbol.dispose', () => {
    const before = wasm.liveHandles();
    let kept!: Pattern<number>;
    {
      const pattern = pure(1);
      kept = pattern;
      expect(wasm.liveHandles()).toBe(before + 1);
      pattern[Symbol.dispose]();
    }
    expect(wasm.liveHandles()).toBe(before);
    expect(() => kept.fast(2)).toThrow(/was freed/);
  });

  it('frees a pattern that never needed its handle (a signal constant) without error', () => {
    expect(() => rand.fast(2).free()).not.toThrow();
  });
});

describe('handles and memory', () => {
  const N = 200_000;

  it('keeps memory bounded over many handles that are freed', () => {
    const handles = wasm.liveHandles();
    const memory = wasm.memoryBytes();
    for (let i = 0; i < N; i++) {
      const base = pure(i);
      const pattern = base.fast(2);
      pattern.free();
      base.free();
    }
    expect(wasm.liveHandles()).toBe(handles);
    expect(wasm.memoryBytes() - memory).toBeLessThan(8 * 1024 * 1024);
  });

  it('keeps memory bounded over many handles that are not freed, once the collector runs', async () => {
    const handles = wasm.liveHandles();
    const memory = wasm.memoryBytes();
    for (let i = 0; i < N; i++) {
      pure(i).fast(2);
    }
    // The collector cannot see WebAssembly memory, so dead handles can wait: this is the cost of not calling free().
    for (let round = 0; round < 40 && wasm.liveHandles() - handles > N / 10; round++) {
      collect();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(wasm.memoryBytes() - memory).toBeLessThan(256 * 1024 * 1024);
    expect(wasm.liveHandles() - handles).toBeLessThan(N / 2);
  });

  it('frees a PatternList after each constructor call', () => {
    const before = wasm.liveHandles();
    const parts = [pure(1), pure(2)];
    for (let i = 0; i < 1000; i++) {
      stack(...parts).free();
    }
    expect(wasm.liveHandles()).toBe(before + 2);
  });
});

describe('every() and jux()', () => {
  it('call the function once, with the receiver as a Pattern', () => {
    const base = mini('a b', (word) => word);
    const seen: unknown[] = [];
    base.every(3, (pattern) => {
      seen.push(pattern);
      return pattern.rev();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(base);

    const control = pure({ pan: 0 });
    const juxSeen: unknown[] = [];
    control.jux((pattern) => {
      juxSeen.push(pattern);
      return pattern.rev();
    });
    expect(juxSeen).toEqual([control]);
  });

  it('do not call the function when the cycle count is invalid', () => {
    let called = false;
    expect(() =>
      pure(1).every(0, (pattern) => {
        called = true;
        return pattern;
      })
    ).toThrow('every() cycle count must be a positive integer, got 0');
    expect(called).toBe(false);
  });

  it('leave the pattern the function returned usable, and take nothing from the user', () => {
    const base = pure('x');
    let returned!: Pattern<string>;
    const result = base.every(2, (pattern) => (returned = pattern.fast(2)));
    expect(cycle(returned)).toHaveLength(2);
    expect(cycle(result, 0)).toHaveLength(2);
    expect(cycle(result, 1)).toHaveLength(1);
  });

  it('rethrow an exception from the function as the same object', () => {
    const failure = new TypeError('from the user');
    let caught: unknown;
    try {
      pure(1).every(2, () => {
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });

  it('refuse a function that does not return a pattern', () => {
    expect(() => pure(1).every(2, (() => 5) as never)).toThrow(/must return a pattern handle/);
  });
});

describe('JavaScript functions as leaves', () => {
  it('runs new Pattern(query) and keeps its sampler through transforms', () => {
    const clock = new Pattern<number>(
      (range) =>
        range.begin.lt(range.end) ? [{ part: range, value: range.begin.toNumber() }] : [],
      (t) => t.toNumber()
    );
    expect(cycle(clock)[0].value).toBe(0);
    expect(clock.fast(2).sampleAt(new Fraction(1, 4))).toBe(0.5);
  });

  it('rethrows an exception from a query unchanged', () => {
    const failure = new RangeError('query failed');
    const broken = new Pattern<number>(() => {
      throw failure;
    });
    expect(() => cycle(broken)).toThrow(failure);
  });

  it('rethrows an exception from fmap unchanged', () => {
    const failure = new Error('map failed');
    const mapped = pure(1).fmap(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      cycle(mapped);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });

  it('gives fmap one value at a time', () => {
    const received: unknown[][] = [];
    const mapped = mini('a b c', (word) => word).fmap((...args) => {
      received.push(args);
      return args[0];
    });
    cycle(mapped);
    expect(received.every((args) => args.length === 1)).toBe(true);
  });

  it('passes a time beyond 2^53 to a query as an exact Fraction, and takes one back', () => {
    const far = new Fraction(2 ** 60).add(new Fraction(1, 3));
    const seen: Fraction[] = [];
    const probe = new Pattern<string>((range) => {
      seen.push(range.begin, range.end);
      return [{ whole: range, part: range, value: 'far' }];
    });
    const haps = probe.query(span(far, far.add(new Fraction(1, 7))));
    expect(seen[0].toString()).toBe(far.toString());
    expect(haps[0].part.begin.toString()).toBe(far.toString());
    expect(haps[0].whole?.end.toString()).toBe(far.add(new Fraction(1, 7)).toString());
  });
});

describe('Fraction beyond 2^53', () => {
  const big = (n: bigint, d: bigint) => {
    const out = Fraction.fromText(`${n}/${d}`);
    return out;
  };

  it('is exact where doubles are not', () => {
    const a = new Fraction(2 ** 60, 3);
    const b = a.add(new Fraction(1, 3));
    expect(b.toString()).toBe('1152921504606846977/3');
    expect(b.sub(a).toString()).toBe('1/3');
    expect(a.mul(new Fraction(3)).toString()).toBe(String(2n ** 60n));
    expect(a.div(a).toString()).toBe('1');
    expect(a.lt(b)).toBe(true);
    expect(a.eq(big(2n ** 60n, 3n))).toBe(true);
    expect(b.floor()).toBe(Number(1152921504606846977n / 3n));
  });

  it('agrees with the module on random operations', () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed;
    };
    const part = () => BigInt(next()) * BigInt(next() % 2 ** 29) + 1n;
    for (let i = 0; i < 300; i++) {
      const a = big(part() * (i % 2 ? -1n : 1n), part());
      const b = big(part(), part());
      for (const op of ['add', 'sub', 'mul', 'div'] as const) {
        expect(a[op](b).toString()).toBe(wasm.fractionOp(op, a.toString(), b.toString()));
      }
      expect(Math.sign(a.cmp(b))).toBe(Number(wasm.fractionOp('cmp', a.toString(), b.toString())));
    }
  });

  it('behaves as the reference does for every small value', () => {
    const half = new Fraction(1, 2);
    const third = new Fraction(1, 3);
    expect(half.add(third).toString()).toBe('5/6');
    expect(half.cmp(third)).toBeGreaterThan(0);
    expect(new Fraction(7, -14)).toMatchObject({ n: -1, d: 2 });
    expect(() => new Fraction(1, 0)).toThrow('Fraction denominator cannot be 0');
    expect(() => new Fraction(1.5)).toThrow('Fraction parts must be integers, got 1.5/1');
    expect(() => half.div(new Fraction(0))).toThrow('Division by zero fraction');
  });
});
