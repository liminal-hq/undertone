// Smoke test of the WebAssembly module through its exports: haps, lists, transforms, foreign leaves, errors, freeing, memory
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run after scripts/build-wasm.sh, under Node 22+ or Bun (Node: `node --expose-gc`; Bun collects with Bun.gc):
//   node --expose-gc crates/undertone-wasm/tests/js/smoke.ts
//   bun crates/undertone-wasm/tests/js/smoke.ts
// Each check prints one line; the first failure stops the run with a non-zero exit. The last check makes the module panic on
// purpose (an i128 overflow) to record what a panic does, so nothing may run after it.

import assert from 'node:assert/strict';
import { Fraction, Pattern, lib, wasm } from './harness.ts';
import type { Hap } from './harness.ts';

const runtime = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`;
let checks = 0;

function check(name: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(run()).then(() => {
    checks += 1;
    console.log(`ok ${checks} - ${name}`);
  });
}

const f = (n: number, d = 1) => new Fraction(n, d);
const window = (pattern: Pattern, begin: Fraction, end: Fraction) => pattern.query({ begin, end });
/** The haps of `[from, to)` in time order (part begin, then whole begin), whatever order the tree gives them in. */
const cycle = (pattern: Pattern, from = 0, to = 1) =>
  window(pattern, f(from), f(to)).sort(
    (a, b) =>
      a.part.begin.cmp(b.part.begin) || (a.whole && b.whole ? a.whole.begin.cmp(b.whole.begin) : 0)
  );
const fraction = (x: Fraction) => `${x.n}/${x.d}`;
const describe = (haps: Hap[]) =>
  haps.map(
    (hap) =>
      `${hap.whole ? `${fraction(hap.whole.begin)}-${fraction(hap.whole.end)}` : '~'} ${fraction(hap.part.begin)}-${fraction(hap.part.end)} ${JSON.stringify(hap.value)}`
  );
const word = (w: string) => w;

/** The thrown value of `run`, which must throw. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const nodeGc = (globalThis as { gc?: () => void }).gc;
/** Whether the runtime lets the test ask for a collection (Bun always; Node with --expose-gc). */
const canCollect = typeof Bun !== 'undefined' || typeof nodeGc === 'function';

function collect(): void {
  if (typeof Bun !== 'undefined') Bun.gc(true);
  else nodeGc?.();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`# undertone-wasm smoke test on ${runtime}, module version ${wasm.undertoneVersion()}`);

await check("mini('c3 e3 g3') queries to three haps a third of a cycle each", () => {
  const p = lib.mini('c3 e3 g3', (w) => ({ pitch: w }));
  assert.deepEqual(describe(cycle(p)), [
    '0/1-1/3 0/1-1/3 {"pitch":"c3"}',
    '1/3-2/3 1/3-2/3 {"pitch":"e3"}',
    '2/3-1/1 2/3-1/1 {"pitch":"g3"}'
  ]);
  // A span that starts inside a hap gives a fragment whose whole reaches outside the query.
  assert.deepEqual(describe(window(p, f(1, 2), f(1))), [
    '1/3-2/3 1/2-2/3 {"pitch":"e3"}',
    '2/3-1/1 2/3-1/1 {"pitch":"g3"}'
  ]);
  assert.equal(lib.hasOnset(window(p, f(1, 2), f(1))[0]), false);
  assert.equal(lib.hasOnset(window(p, f(1, 2), f(1))[1]), true);
});

await check('list builders borrow: a pattern used in two lists stays usable', () => {
  const a = lib.pure('a');
  const b = lib.pure('b');
  const s1 = lib.seq(a, b);
  const s2 = lib.stack(a, b, a);
  const c = lib.cat(a, b);
  const t = lib.timecat([
    [1, a],
    [3, b]
  ]);
  const r = lib.arrange([2, a], [1, b]);
  assert.deepEqual(describe(cycle(s1)), ['0/1-1/2 0/1-1/2 "a"', '1/2-1/1 1/2-1/1 "b"']);
  assert.equal(cycle(s2).length, 3);
  assert.deepEqual(
    cycle(c, 0, 2).map((h) => h.value),
    ['a', 'b']
  );
  assert.equal(fraction(cycle(t)[1].part.begin), '1/4');
  assert.deepEqual(
    cycle(r, 0, 4).map((h) => h.value),
    ['a', 'a', 'b', 'a']
  );
  // The originals still answer after being pushed into five lists.
  assert.deepEqual(
    cycle(a).map((h) => h.value),
    ['a']
  );
  assert.deepEqual(
    cycle(b).map((h) => h.value),
    ['b']
  );
});

await check(
  'every() calls the JavaScript function once, with the same Pattern object, after checking n',
  () => {
    const base = lib.mini('a b', word);
    const seen: unknown[] = [];
    const every = base.every(2, (p) => {
      seen.push(p);
      return p.rev();
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], base);
    assert.deepEqual(
      cycle(every, 0, 1).map((h) => h.value),
      ['b', 'a']
    );
    assert.deepEqual(
      cycle(every, 1, 2).map((h) => h.value),
      ['a', 'b']
    );
    // Querying never calls it again.
    cycle(every, 0, 8);
    assert.equal(seen.length, 1);
    // The count is checked first, so the function never runs and the message is the reference's.
    let ran = false;
    const error = thrown(() =>
      base.every(0, (p) => {
        ran = true;
        return p;
      })
    );
    assert.equal(ran, false);
    assert.ok(error instanceof Error && error.constructor === Error);
    assert.equal(error.message, 'every() cycle count must be a positive integer, got 0');
    // An exception from the function comes back as it was thrown.
    class Custom extends Error {}
    const mine = new Custom('mine');
    assert.equal(
      thrown(() =>
        base.every(2, () => {
          throw mine;
        })
      ),
      mine
    );
    // A thunk that hands back something else is refused.
    const notPattern = thrown(() => base.handle.every(2, () => 42));
    assert.equal((notPattern as Error).message, "a transform's thunk must return a pattern handle");
  }
);

await check('jux() puts the pattern hard left and the transformed copy hard right', () => {
  const p = lib.mini('a b', (w) => ({ s: w })).jux((x) => x.rev());
  const pans = cycle(p).map(
    (h) => `${(h.value as { s: string }).s}${(h.value as { pan: number }).pan}`
  );
  assert.deepEqual(pans.sort(), ['a-1', 'a1', 'b-1', 'b1']);
});

await check(
  'signal(fn) is a foreign leaf: sampled at an instant, queried as one hap, and exceptions pass through',
  () => {
    const calls: number[] = [];
    const ramp = lib.signal((t) => {
      calls.push(t);
      return t % 1;
    });
    assert.equal(ramp.sampleAt(f(13, 4)), 0.25);
    assert.equal(ramp.handle.hasSampler(), true);
    assert.deepEqual(describe(window(ramp, f(1, 2), f(1))), ['~ 1/2-1/1 0.5']);
    assert.deepEqual(
      cycle(ramp.segment(4)).map((h) => h.value),
      [0, 0.25, 0.5, 0.75]
    );
    assert.ok(calls.length > 0);
    const boom = new TypeError('boom');
    const bad = lib.signal(() => {
      throw boom;
    });
    assert.equal(
      thrown(() => cycle(bad.segment(2))),
      boom
    );
    assert.equal(
      thrown(() => bad.sampleAt(f(0))),
      boom
    );
    // The module is fine afterwards.
    assert.equal(cycle(lib.pure(1)).length, 1);
  }
);

await check('new Pattern(query, sampler) carries its sampler through a transform', () => {
  const clock = new Pattern<number>(
    (span) => (span.begin.lt(span.end) ? [{ part: span, value: span.begin.toNumber() }] : []),
    (t) => t.toNumber()
  );
  assert.equal(clock.handle.hasSampler(), true);
  const fast = clock.fast(2);
  assert.equal(fast.handle.hasSampler(), true);
  assert.equal(fast.sampleAt(f(1, 4)), 0.5);
  assert.deepEqual(describe(window(fast, f(1, 4), f(1, 2))), ['~ 1/4-1/2 0.5']);
  assert.deepEqual(
    cycle(clock.segment(2)).map((h) => h.value),
    [0, 0.5]
  );
  // A query function that returns the wrong shape is an error at the query.
  const broken = Pattern.of(wasm.fromQuery(() => 'nope'));
  assert.match(
    (thrown(() => cycle(broken)) as Error).message,
    /must return \[Float64Array, values\]/
  );
  const badIndex = Pattern.of(
    wasm.fromQuery(() => [new Float64Array([0, 1, 1, 1, 0, 0, 0, 0, 5]), []])
  );
  assert.equal(
    (thrown(() => cycle(badIndex)) as Error).message,
    "a hap's value index 5 is not in the values (0 of them)"
  );
});

await check('fmap(fn) maps every value with one call per query', () => {
  let batches = 0;
  const p = lib.mini('1 2 3 4', Number);
  const handle = p.handle.fmap((values: number[]) => {
    batches += 1;
    return values.map((v) => v * 10);
  });
  const mapped = Pattern.of<number>(handle);
  assert.deepEqual(
    cycle(mapped, 0, 2).map((h) => h.value),
    [10, 20, 30, 40, 10, 20, 30, 40]
  );
  assert.equal(batches, 1);
  // A signal keeps its sampler through fmap.
  const half = lib.saw.fmap((v) => (v as number) / 2);
  assert.equal(half.sampleAt(f(1, 2)), 0.25);
});

await check('Rust errors are Error objects with the message word for word', () => {
  const parse = thrown(() => lib.mini('[a b', word));
  assert.ok(parse instanceof Error && parse.constructor === Error);
  assert.equal(
    parse.message,
    'Mini-notation error at position 4 in "[a b": unexpected end of pattern'
  );
  const leaf = thrown(() =>
    lib.mini('a bad', (w) => {
      if (w === 'bad') throw new Error('nope');
      return w;
    })
  );
  assert.equal((leaf as Error).message, 'Mini-notation error at position 2 in "a bad": nope');
  // A character beyond the Basic Multilingual Plane is reported as its high surrogate at its UTF-16 position, as the
  // reference's tokenizer reads it (a Rust string cannot hold the half; the export puts the source's own code unit back).
  assert.equal(
    (thrown(() => lib.mini('a \u{1F600}', word)) as Error).message,
    'Mini-notation error at position 2 in "a \u{1F600}": unexpected "\ud83d"'
  );
  assert.equal(
    (thrown(() => lib.mini('\ud800 a', word)) as Error).message,
    'Mini-notation error at position 0 in "\ud800 a": unexpected "\ud800"'
  );
  assert.equal(
    (thrown(() => lib.pure(1).fast(0)) as Error).message,
    'fast() factor must be positive, got 0'
  );
  assert.equal(
    (thrown(() => lib.pure(1).euclid(9, 8)) as Error).message,
    'Euclidean pulses must be between 0 and steps, got (9,8)'
  );
  assert.equal(
    (thrown(() => lib.rand.range(0, 1).seed(7)) as Error).message,
    'seed() works directly on rand, rand2, perlin, irand(), choose() and brand — call it before range() or segment()'
  );
  assert.equal(
    (thrown(() => lib.rand.seed(undefined as unknown as number)) as Error).message,
    'seed() needs a finite number or a string, got undefined'
  );
  assert.equal(
    (thrown(() => lib.noteToMidi('h2')) as Error).message,
    'Invalid note name: "h2". Expected e.g. "c2", "a4", "f#3", "bb3".'
  );
  assert.equal((thrown(() => lib.noteToFrequency(0)) as Error).message, 'Invalid frequency: 0');
  assert.equal(
    (thrown(() => lib.pure(1).query({ begin: f(0), end: { n: 1, d: 0 } as Fraction })) as Error)
      .message,
    'a time must be two safe integers with a denominator that is not 0, got 1/0'
  );
});

await check(
  'free() frees at once, twice is harmless in the wrapper, and a freed handle refuses to work',
  () => {
    const before = wasm.liveHandles();
    const p = lib.pure(1);
    assert.equal(wasm.liveHandles(), before + 1);
    p.free();
    assert.equal(wasm.liveHandles(), before);
    p.free();
    assert.equal(wasm.liveHandles(), before);
    assert.equal((thrown(() => cycle(p)) as Error).message, 'null pointer passed to rust');
    // The glue's own free() is not idempotent: the wrapper must guard it (RF-25).
    const raw = wasm.pure(2);
    raw.free();
    assert.equal((thrown(() => raw.free()) as Error).message, 'null pointer passed to rust');
    assert.equal(wasm.liveHandles(), before);
  }
);

await check(
  'values cross bit for bit: -0, NaN, the infinities, undefined fields, nested lists',
  () => {
    const value = {
      zero: -0,
      nan: NaN,
      inf: Infinity,
      ninf: -Infinity,
      gone: undefined,
      list: [1, 'two', [true, { deep: -0 }]],
      nothing: Object.create(null)
    };
    const [hap] = cycle(lib.pure(value));
    const out = hap.value as typeof value;
    assert.ok(Object.is(out.zero, -0));
    assert.ok(Number.isNaN(out.nan));
    assert.equal(out.inf, Infinity);
    assert.equal(out.ninf, -Infinity);
    assert.ok('gone' in out && out.gone === undefined);
    assert.ok(Object.is((out.list[2] as [boolean, { deep: number }])[1].deep, -0));
    assert.deepEqual(Object.keys(out.nothing), []);
    assert.ok(Object.is(cycle(lib.pure(-0))[0].value, -0));
    assert.equal(cycle(lib.pure(undefined))[0].value, undefined);
    const refused =
      'a pattern value must be a number, a string, a boolean, undefined, an array, or a plain object, got ';
    assert.equal((thrown(() => lib.pure(null)) as Error).message, `${refused}null`);
    assert.equal((thrown(() => lib.pure(f(1, 2))) as Error).message, `${refused}1/2`);
    assert.equal((thrown(() => lib.choose(1, () => 2)) as Error).message, `${refused}() => 2`);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.match((thrown(() => lib.pure(cyclic)) as Error).message, /at most 64 levels deep/);
  }
);

await check('times beyond 2^53 cross as exact text', () => {
  const p = lib.pure(1);
  const [times, values, big] = p.handle.queryRatio('9007199254740993', '9007199254740994') as [
    Float64Array,
    unknown[],
    string[]
  ];
  assert.ok(Number.isNaN(times[0]) && times[1] === 0);
  assert.deepEqual(big, [
    '9007199254740993/1',
    '9007199254740994/1',
    '9007199254740993/1',
    '9007199254740994/1'
  ]);
  assert.deepEqual(values, [1]);
  assert.equal(wasm.fractionOp('add', '9007199254740993', '1'), '9007199254740994/1');
  assert.equal(wasm.fractionOp('cmp', '1/3', '1/2'), '-1');
  assert.equal(wasm.fractionFromNumber(0.75), '3/4');
  assert.equal(
    (thrown(() => wasm.fractionOp('div', '1', '0')) as Error).message,
    'Division by zero fraction'
  );
});

await check('signals, random sources, and pitch helpers give the reference numbers', () => {
  assert.equal(lib.sine.sampleAt(f(1, 4)), 1);
  assert.equal(lib.saw2.sampleAt(f(1, 4)), -0.5);
  const random = lib.seededRandom(0);
  assert.equal(random(), 0.26642920868471265);
  assert.equal(random(), 0.0003297457005828619);
  assert.notEqual(lib.seededRandom('0')(), 0.26642920868471265);
  assert.equal(lib.seededRandom('\ud83d')(), lib.seededRandom('\ud83d')());
  assert.notEqual(lib.seededRandom('\ud83d')(), lib.seededRandom('�')());
  assert.equal(lib.noteToMidi('c4'), 60);
  assert.equal(lib.midiToFrequency(69), 440);
  assert.equal(lib.noteToFrequency('a4'), 440);
  assert.equal(lib.noteToFrequency(261.5), 261.5);
  const seeded = lib.rand.seed(7);
  assert.equal(seeded.sampleAt(f(5, 7)), lib.rand.seed(7).sampleAt(f(5, 7)));
  assert.notEqual(seeded.sampleAt(f(5, 7)), lib.rand.sampleAt(f(5, 7)));
  assert.equal(
    lib
      .irand(4)
      .segment(8)
      .query({ begin: f(0), end: f(1) }).length,
    8
  );
  assert.equal(
    (thrown(() => wasm.signalNamed('wobble')) as Error).message,
    'unknown signal "wobble"'
  );
});

await check('the controls table lists 53 controls as plain objects', () => {
  const rows = wasm.controlTable() as {
    jsName: string;
    fields: string[];
    arg: string;
    scalarOnly: boolean;
  }[];
  assert.equal(rows.length, 53);
  const gain = rows.find((row) => row.jsName === 'gain');
  assert.deepEqual(gain?.fields, ['gainLevel']);
  assert.equal(gain?.arg, 'patternable');
  assert.equal(rows.find((row) => row.jsName === 'panpath')?.scalarOnly, true);
});

await check('JavaScript functions held by freed leaves are released', () => {
  const before = wasm.liveForeignFunctions();
  const leaves = Array.from({ length: 1000 }, () => lib.signal((t) => t));
  assert.equal(wasm.liveForeignFunctions(), before + 1000);
  // A leaf inside another pattern lives as long as that pattern.
  const outer = leaves[0].fast(2);
  for (const leaf of leaves) leaf.free();
  assert.equal(wasm.liveForeignFunctions(), before + 1);
  outer.free();
  assert.equal(wasm.liveForeignFunctions(), before);
});

const HANDLES = 100_000;
const MB = 1024 * 1024;

await check(`${HANDLES} short-lived handles with free(): live handles and memory stay flat`, () => {
  const base = lib.mini('a b c', word);
  const live = wasm.liveHandles();
  const memory = wasm.memoryBytes();
  for (let i = 0; i < HANDLES; i += 1) {
    const p = base.fast(2);
    const q = p.rev();
    p.free();
    q.free();
  }
  assert.equal(wasm.liveHandles(), live);
  const grew = wasm.memoryBytes() - memory;
  console.log(`#   memory grew ${(grew / MB).toFixed(2)} MB over ${2 * HANDLES} freed handles`);
  assert.ok(grew <= 1 * MB);
});

await check(
  `${HANDLES} short-lived handles left to the collector: freed after a collection, memory bounded`,
  async () => {
    const base = lib.mini('a b c', word);
    // Collect the earlier checks' garbage first, so the baseline is only what is still held.
    for (let i = 0; i < 5; i += 1) {
      collect();
      await sleep(20);
    }
    const live = wasm.liveHandles();
    const memory = wasm.memoryBytes();
    for (let i = 0; i < HANDLES; i += 1) {
      base.fast(2).rev();
    }
    const atEnd = wasm.liveHandles() - live;
    let after = atEnd;
    for (let wait = 0; wait < 50 && after > HANDLES / 100; wait += 1) {
      collect();
      await sleep(20);
      after = wasm.liveHandles() - live;
    }
    const grew = wasm.memoryBytes() - memory;
    console.log(
      `#   live handles: ${atEnd} when the loop ended, ${after} after collecting; memory grew ${(grew / MB).toFixed(2)} MB`
    );
    if (canCollect) {
      assert.ok(after <= HANDLES / 100, 'the collector freed the handles');
    } else {
      // R2: without an explicit collection the collector runs when the JavaScript heap says so, which can be much later.
      console.log(
        '#   (no explicit collector here: run Node with --expose-gc to check the handles are freed)'
      );
    }
    // Two handles a pass, all alive until the collector runs: the high-water mark is about 140 bytes a handle (a tree node and
    // the handle). The bound is 256 bytes a handle, far below what an unbounded climb would reach over repeated runs.
    assert.ok(grew <= 2 * HANDLES * 256, `grew ${grew} bytes`);
  }
);

await check(
  'a panic traps: the call throws a RuntimeError (the instance must then be dropped)',
  () => {
    // i128 overflow in the pattern crate's Fraction: 2^53 three times over, then a query. This is the one known way to panic
    // (docs/rust-migration/results/M6-BOUNDARY.md, section 4).
    const huge = 2 ** 53;
    const p = lib.pure(1).fast(huge).fast(huge).fast(huge);
    const error = thrown(() => cycle(p, 1, 2));
    assert.ok(error instanceof WebAssembly.RuntimeError, String(error));
    console.log(`#   ${String(error)}`);
  }
);

console.log(`# ${checks} checks passed on ${runtime}`);
