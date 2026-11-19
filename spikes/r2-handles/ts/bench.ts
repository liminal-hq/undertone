// The three R2 measurements, runtime-agnostic: call counts, foreign-leaf timing, and the handle loop
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

import { counters, Pattern, stats } from './wrapper.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const now = () => performance.now();

/** Step 1: JavaScript calls during 1,000 queries of closure-at-construction chains. */
export function step1() {
  const rev = (p: Pattern) => p.rev();
  const chains: Record<string, Pattern> = {
    every: Pattern.note('c4 e4').every(2, rev),
    jux: Pattern.note('c4 e4').jux(rev),
    'every+jux': Pattern.note('c4 e4').every(2, rev).jux(rev),
    foreign: Pattern.counting(2).fmap((v) => v + 1),
    custom: Pattern.fromQuery((b, e) => [[b, e, 1]])
  };
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(chains)) {
    for (const method of ['count', 'query'] as const) {
      counters.imports = 0;
      counters.callbacks = 0;
      let haps = 0;
      for (let i = 0; i < 1000; i++)
        haps += method === 'count' ? p.count(i, i + 1) : p.query(i, i + 1).length / 5;
      out[`${name}.${method}`] = { imports: counters.imports, callbacks: counters.callbacks, haps };
    }
  }
  out.tree = chains['every+jux'].describe();
  return out;
}

/** Step 2: a 32-hap foreign-leaf query, 10,000 runs, as a median per call and a median of batches. */
export function step2(runs = 10000, batch = 100) {
  // Two shapes of 32 haps: a 32-step sequence (32 compress nodes) and one value sped up 32 times.
  const plain = Pattern.counting(32);
  const foreign = plain.fmap((v) => v + 1);
  const plainFast = Pattern.counting(1).fast(32);
  const foreignFast = plainFast.fmap((v) => v + 1);
  const custom = Pattern.fromQuery((b) =>
    Array.from({ length: 32 }, (_, i) => [b + i / 32, b + (i + 1) / 32, i + 1])
  );
  const measure = (p: Pattern) => {
    for (let i = 0; i < 2000; i++) p.query(0, 1); // warm-up
    const single: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t = now();
      p.query(0, 1);
      single.push((now() - t) * 1000);
    }
    const batches: number[] = [];
    for (let b = 0; b < runs / batch; b++) {
      const t = now();
      for (let i = 0; i < batch; i++) p.query(0, 1);
      batches.push(((now() - t) * 1000) / batch);
    }
    return {
      haps: p.query(0, 1).length / 5,
      medianSingleUs: median(single),
      medianBatchUs: median(batches)
    };
  };
  return {
    seq32Plain: measure(plain),
    seq32Foreign: measure(foreign),
    fast32Plain: measure(plainFast),
    fast32Foreign: measure(foreignFast),
    custom32: measure(custom)
  };
}

function chainOfTen(): Pattern {
  const rev = (p: Pattern) => p.rev();
  let p = Pattern.note('c4 e4'); // 1
  p = p.rev(); // 2
  p = p.fast(2); // 3
  p = p.every(2, rev); // 4, 5 (the transform's result is a handle too)
  p = p.rev(); // 6
  p = p.fast(2); // 7
  p = p.every(2, rev); // 8, 9
  return p.rev(); // 10
}

/** Step 3: build and drop a million patterns in chains of ten; settle; report. */
export type Settle = 'idle' | 'churn' | 'gc';

/**
 * How the ten-second settle wait behaves: `idle` only sleeps (no allocation, so no garbage collection is
 * forced), `churn` allocates a little JavaScript garbage on every poll as a running application would, and
 * `gc` calls the runtime's explicit collector. `gcInLoop` also collects at every await in the loop.
 */
export async function step3(
  opts: {
    gc?: () => void;
    settle?: Settle;
    gcInLoop?: boolean;
    repeats?: number;
    patterns?: number;
  } = {}
) {
  const settleMode = opts.settle ?? 'idle';
  let sink: unknown[] = [];
  const repeats = opts.repeats ?? 3;
  const total = opts.patterns ?? 1_000_000;
  const out: unknown[] = [];
  for (let r = 0; r < repeats; r++) {
    const start = stats();
    const samples = [{ patterns: 0, ...start }];
    let built = 0;
    let checksum = 0;
    const t0 = now();
    const created0 = start.created;
    while (built < total) {
      const p = chainOfTen();
      built += 10;
      if (built % 1000 === 0 && p.count(0, 1) > 0) checksum++;
      if (built % 10_000 === 0) {
        if (opts.gcInLoop && opts.gc) opts.gc();
        await tick();
      }
      if (built % 100_000 === 0) samples.push({ patterns: built, ...stats() });
    }
    const loopMs = now() - t0;
    const end = stats();
    // Settle: poll for up to ten seconds for live handles to return to the start.
    let settledAtMs = -1;
    const s0 = now();
    const limit = start.live + Math.max(1, Math.floor(total * 0.01));
    while (now() - s0 < 10_000) {
      if (settleMode === 'gc' && opts.gc) opts.gc();
      if (settleMode === 'churn') {
        sink = [];
        for (let i = 0; i < 20; i++) sink.push(new Array(10_000).fill(i)); // about 1.6 MB of garbage
      }
      await sleep(100);
      if (stats().live <= limit) {
        settledAtMs = now() - s0;
        break;
      }
    }
    const settled = stats();
    out.push({
      repeat: r + 1,
      createdThisRepeat: settled.created - created0,
      loopMs: Math.round(loopMs),
      samples,
      liveAtLoopEnd: end.live,
      liveAfterSettle: settled.live,
      settledWithinTenSeconds: settledAtMs >= 0,
      settledAtMs: Math.round(settledAtMs),
      memoryAfterSettle: settled.memoryBytes,
      checksum,
      sinkLength: sink.length
    });
  }
  return out;
}
