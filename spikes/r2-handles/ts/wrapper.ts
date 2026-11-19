// The ~100-line TypeScript Pattern wrapper over the wasm handle, with call counters, for spike R2
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

import {
  initSync,
  Handle,
  note_handle,
  counting_handle,
  custom_handle,
  live_handles,
  created_handles
} from '../pkg/r2_handles.js';

/** Counts of JavaScript calls: `imports` is every wasm-to-JS import call, `callbacks` is user functions. */
export const counters = { imports: 0, callbacks: 0 };

let memory: WebAssembly.Memory | undefined;
let nextId = 1;

/** Instantiates the module, wrapping every import so that wasm-to-JS calls are counted. */
export function load(module: WebAssembly.Module): void {
  const Original = WebAssembly.Instance;
  // @ts-expect-error: the spike swaps the constructor for the duration of initSync only
  WebAssembly.Instance = function (m: WebAssembly.Module, imports: WebAssembly.Imports) {
    for (const ns of Object.values(imports)) {
      for (const [key, fn] of Object.entries(ns as Record<string, unknown>)) {
        if (typeof fn !== 'function') continue;
        (ns as Record<string, unknown>)[key] = (...args: unknown[]) => {
          counters.imports++;
          return fn(...args);
        };
      }
    }
    return new Original(m, imports);
  };
  try {
    memory = (initSync({ module }) as unknown as { memory: WebAssembly.Memory }).memory;
  } finally {
    WebAssembly.Instance = Original;
  }
}

export const stats = () => ({
  live: live_handles(),
  created: created_handles(),
  memoryBytes: memory!.buffer.byteLength
});

export class Pattern {
  readonly h: Handle;
  constructor(h: Handle) {
    this.h = h;
  }
  static note(text: string): Pattern {
    return new Pattern(note_handle(text));
  }
  static counting(n: number): Pattern {
    return new Pattern(counting_handle(n));
  }
  /** `new Pattern(query)`: the query function runs in JavaScript on every query. */
  static fromQuery(query: (begin: number, end: number) => number[][]): Pattern {
    return new Pattern(
      custom_handle((b: number, e: number) => {
        counters.callbacks++;
        return query(b, e).map((row) => Float64Array.from(row));
      }, nextId++)
    );
  }
  rev(): Pattern {
    return new Pattern(this.h.rev());
  }
  fast(factor: number): Pattern {
    return new Pattern(this.h.fast(factor));
  }
  /** The function runs once, here; only the pattern it returns crosses into the tree. */
  every(n: number, fn: (p: Pattern) => Pattern): Pattern {
    counters.callbacks++;
    return new Pattern(this.h.every_with(n, fn(this).h));
  }
  jux(fn: (p: Pattern) => Pattern): Pattern {
    counters.callbacks++;
    return new Pattern(this.h.jux_with(fn(this).h));
  }
  /** A foreign leaf: the function is called from Rust once per hap on every query. */
  fmap(fn: (v: number) => number): Pattern {
    return new Pattern(
      this.h.fmap_foreign((v: number) => {
        counters.callbacks++;
        return fn(v);
      }, nextId++)
    );
  }
  query(from: number, to: number): Float64Array | number[] {
    return this.h.query(from, to);
  }
  count(from: number, to: number): number {
    return this.h.count(from, to);
  }
  describe(): string {
    return this.h.describe();
  }
  /** Opt-in release (the fail-change fallback; unused when the garbage collector frees handles). */
  free(): void {
    this.h.free();
  }
}
